from __future__ import annotations

import difflib
import hashlib
import importlib.util
import json
import os
import queue
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
from pathlib import Path
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

import imageio_ffmpeg
import requests
import socketio

APP_NAME = "KITKARAOKE Agent"
APP_VERSION = "0.9.1"
DEFAULT_SERVER = "https://demodj.kitkaraoke.com"

VIDEO_EXTS = {".mp4", ".mkv", ".webm", ".mov", ".avi"}
AUDIO_EXTS = [".wav", ".mp3", ".m4a", ".aac", ".ogg", ".flac"]
CDG_EXT = ".cdg"
CDG_PACKETS_PER_SECOND = 300
CDG_PACKET_SIZE = 24


def app_data_dir() -> Path:
    base = os.environ.get("APPDATA")
    root = Path(base) if base else Path.home() / ".config"
    path = root / "KITKARAOKE Agent"
    path.mkdir(parents=True, exist_ok=True)
    return path


CONFIG_PATH = app_data_dir() / "config.json"
LOG_DIR = app_data_dir() / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)


def normalize_text(value: str) -> str:
    raw = unicodedata.normalize("NFD", value or "")
    raw = "".join(ch for ch in raw if unicodedata.category(ch) != "Mn")
    chars = [ch if ch.isalnum() else " " for ch in raw.lower()]
    return " ".join("".join(chars).split())


def parse_artist_title(stem: str) -> tuple[str, str]:
    cleaned = stem.replace("_", " ").strip()
    for separator in (" - ", " – ", " — "):
        if separator in cleaned:
            artist, title = cleaned.split(separator, 1)
            if artist.strip() and title.strip():
                return artist.strip(), title.strip()
    return "", cleaned


def stable_id(path: Path) -> str:
    value = str(path.resolve()).encode("utf-8", errors="ignore")
    return hashlib.sha1(value).hexdigest()[:20]


class Catalog:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._items: list[dict] = []
        self._by_id: dict[str, dict] = {}
        self._summary = {
            "files": 0,
            "songs": 0,
            "video": 0,
            "cdg": 0,
            "cdgWithAudio": 0,
        }

    def replace(self, items: list[dict], summary: dict) -> None:
        with self._lock:
            self._items = items
            self._by_id = {item["id"]: item for item in items}
            self._summary = summary

    def summary(self) -> dict:
        with self._lock:
            return dict(self._summary)

    def get(self, media_id: str) -> dict | None:
        with self._lock:
            item = self._by_id.get(str(media_id or ""))
            return dict(item) if item else None

    def search(self, query: str, limit: int = 50) -> tuple[list[dict], int]:
        needle = normalize_text(query)
        tokens = [t for t in needle.split() if t]
        if not tokens:
            return [], 0

        with self._lock:
            candidates = []
            for item in self._items:
                key = item["_key"]
                if not all(token in key for token in tokens):
                    continue

                score = 0
                title_key = item["_title_key"]
                artist_key = item["_artist_key"]

                if needle == title_key:
                    score += 100
                elif needle in title_key:
                    score += 70
                if needle and needle in artist_key:
                    score += 45
                if key.startswith(needle):
                    score += 25
                score += max(0, 20 - len(key) // 30)
                candidates.append((score, item))

            candidates.sort(key=lambda pair: (-pair[0], pair[1]["title"].lower()))
            total = len(candidates)
            safe = []
            for _, item in candidates[: max(1, min(80, limit))]:
                safe.append(
                    {
                        "id": item["id"],
                        "title": item["title"],
                        "artist": item["artist"],
                        "format": item["format"],
                        "audio": item["audio"],
                        "duration": None,
                    }
                )
            return safe, total


class AgentApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title(f"{APP_NAME} {APP_VERSION}")
        self.root.geometry("820x700")
        self.root.minsize(760, 620)

        self.catalog = Catalog()
        self.config = self.load_config()
        self.sio = socketio.Client(
            reconnection=True,
            reconnection_attempts=0,
            reconnection_delay=1,
            reconnection_delay_max=10,
            logger=False,
            engineio_logger=False,
        )

        self.connected = False
        self.registered = False
        self.stop_event = threading.Event()
        self.log_queue: queue.Queue[str] = queue.Queue()
        self.ffmpeg_path = self.detect_ffmpeg()
        self.ffprobe_path = self.detect_ffprobe()
        self.node_path = shutil.which("node") or shutil.which("nodejs") or ""
        bundled_deno = Path(__file__).resolve().parent / "engine" / "deno.exe"
        self.deno_path = (
            str(bundled_deno)
            if bundled_deno.exists()
            else (shutil.which("deno") or "")
        )
        self.ytdlp_available = importlib.util.find_spec("yt_dlp") is not None
        self.prepare_lock = threading.Lock()
        self.cancelled_traces: set[str] = set()
        self.latest_prepare_trace_id = ""

        self.server_var = tk.StringVar(value=self.config.get("server", DEFAULT_SERVER))
        self.folder_var = tk.StringVar(value=self.config.get("folder", ""))
        self.code_var = tk.StringVar(value=self.config.get("agentCode", "------"))
        self.connection_var = tk.StringVar(value="DESCONECTADO")
        self.scan_var = tk.StringVar(value="Sin índice")
        self.counts_var = tk.StringVar(value="0 canciones · 0 video · 0 CDG+audio")
        self.prepare_var = tk.StringVar(
            value="FFmpeg listo" if self.ffmpeg_path else "FFmpeg no disponible"
        )

        self.build_ui()
        self.bind_socket_events()

        self.root.protocol("WM_DELETE_WINDOW", self.on_close)
        self.root.after(150, self.flush_logs)

        if self.ffmpeg_path:
            self.add_log("Motor FFmpeg listo para demos CDG/MP4.")
            if self.ffprobe_path:
                self.add_log("FFprobe listo · AUTO detectará resolución/FPS/codec del MP4.")
            else:
                self.add_log("FFprobe no encontrado · AUTO usará inspección segura con FFmpeg.")
        else:
            self.add_log("ERROR: no se encontró FFmpeg.")

        if self.ytdlp_available:
            runtime = "Deno" if self.deno_path else ("Node" if self.node_path else "SIN runtime JS")
            self.add_log(f"YouTube Background AUTO listo · yt-dlp + {runtime}.")
        else:
            self.add_log("YouTube Background AUTO no disponible · falta instalar yt-dlp.")

        if self.folder_var.get():
            self.start_scan(auto=True)

        self.root.after(600, self.connect_async)

    def detect_ffmpeg(self) -> str:
        system = shutil.which("ffmpeg")
        if system:
            return system
        try:
            return imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:
            return ""

    def detect_ffprobe(self) -> str:
        system = shutil.which("ffprobe")
        if system:
            return system
        if not self.ffmpeg_path:
            return ""
        ffmpeg = Path(self.ffmpeg_path)
        candidates = [
            ffmpeg.with_name("ffprobe.exe"),
            ffmpeg.with_name("ffprobe"),
        ]
        name = ffmpeg.name
        if "ffmpeg" in name.lower():
            replaced = re.sub("ffmpeg", "ffprobe", name, count=1, flags=re.IGNORECASE)
            candidates.append(ffmpeg.with_name(replaced))
        for candidate in candidates:
            try:
                if candidate.exists() and candidate.is_file():
                    return str(candidate)
            except Exception:
                continue
        return ""

    @staticmethod
    def _parse_fps(value: str | None) -> float | None:
        raw = str(value or "").strip()
        if not raw or raw in {"0/0", "N/A"}:
            return None
        try:
            if "/" in raw:
                num, den = raw.split("/", 1)
                den_f = float(den)
                if den_f == 0:
                    return None
                return round(float(num) / den_f, 3)
            return round(float(raw), 3)
        except Exception:
            return None

    def probe_video(self, source: Path) -> dict:
        if self.ffprobe_path:
            try:
                command = [
                    self.ffprobe_path,
                    "-v", "error",
                    "-select_streams", "v:0",
                    "-show_entries",
                    "stream=width,height,codec_name,avg_frame_rate,r_frame_rate,pix_fmt",
                    "-of", "json",
                    str(source),
                ]
                proc = subprocess.run(
                    command,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    timeout=20,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                )
                if proc.returncode == 0:
                    payload = json.loads(proc.stdout or "{}")
                    streams = payload.get("streams") or []
                    if streams:
                        stream = streams[0]
                        width = int(stream.get("width") or 0)
                        height = int(stream.get("height") or 0)
                        if width > 0 and height > 0:
                            fps = self._parse_fps(
                                stream.get("avg_frame_rate") or stream.get("r_frame_rate")
                            )
                            return {
                                "width": width,
                                "height": height,
                                "fps": fps,
                                "codec": str(stream.get("codec_name") or "").upper() or None,
                                "pixFmt": str(stream.get("pix_fmt") or "") or None,
                                "probe": "ffprobe",
                            }
            except Exception:
                pass

        if not self.ffmpeg_path:
            raise RuntimeError("No hay motor para inspeccionar el video")

        command = [
            self.ffmpeg_path,
            "-hide_banner",
            "-i", str(source),
            "-map", "0:v:0",
            "-frames:v", "1",
            "-an",
            "-f", "null",
            "-",
        ]
        proc = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=30,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        text_out = (proc.stderr or "") + "\n" + (proc.stdout or "")
        video_line = next(
            (line for line in text_out.splitlines() if "Video:" in line),
            "",
        )
        match_size = re.search(r"(?<!\d)(\d{2,5})x(\d{2,5})(?!\d)", video_line)
        if not match_size:
            raise RuntimeError("No se pudo detectar la resolución del MP4")
        width = int(match_size.group(1))
        height = int(match_size.group(2))
        match_fps = re.search(r"(\d+(?:\.\d+)?)\s*fps\b", video_line)
        match_codec = re.search(r"Video:\s*([^,\s]+)", video_line)
        return {
            "width": width,
            "height": height,
            "fps": round(float(match_fps.group(1)), 3) if match_fps else None,
            "codec": match_codec.group(1).upper() if match_codec else None,
            "pixFmt": None,
            "probe": "ffmpeg-fallback",
        }

    @staticmethod
    def resolution_label(width: int, height: int) -> str:
        if width <= 0 or height <= 0:
            return "unknown"
        return f"{height}p"

    def capabilities(self) -> dict:
        return {
            "prepareMedia": bool(self.ffmpeg_path),
            "ffmpeg": bool(self.ffmpeg_path),
            "cdgAacDemo": bool(self.ffmpeg_path),
            "mp4H264Demo": bool(self.ffmpeg_path),
            "videoQualities": ["original"],
            "preserveOriginalVideoResolution": True,
            "mp4VideoStreamCopyWhenH264": True,
            "youtubeBackgroundAuto": bool(self.ytdlp_available and self.ffmpeg_path),
            "youtubeSearch": bool(self.ytdlp_available),
            "youtubeBackgroundMaxResolution": "854x480",
            "youtubeBackgroundQualityPolicy": "BEST_AVAILABLE_UP_TO_480P",
            "youtubeBackgroundNoUpscale": True,
            "youtubeBackgroundMuted": True,
            "youtubeResolverDrainSafe": True,
            "youtubeLivePrepare": True,
            "youtubeFastPrepare": True,
            "audioAacBitrate": "192k",
            "transportMode": "HTTP_PRELOAD",
            "fullPreloadRecommended": True,
            "version": APP_VERSION,
        }

    def load_config(self) -> dict:
        try:
            if CONFIG_PATH.exists():
                data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    return data
        except Exception:
            pass
        return {}

    def save_config(self) -> None:
        data = {
            "server": self.server_var.get().strip() or DEFAULT_SERVER,
            "folder": self.folder_var.get().strip(),
            "agentCode": self.code_var.get().strip().upper()
            if self.code_var.get().strip() not in {"", "------"}
            else "",
        }
        CONFIG_PATH.write_text(
            json.dumps(data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        self.config.update(data)

    def build_ui(self) -> None:
        style = ttk.Style()
        try:
            style.theme_use("vista")
        except Exception:
            pass

        outer = ttk.Frame(self.root, padding=18)
        outer.pack(fill="both", expand=True)

        ttk.Label(
            outer,
            text="KITKARAOKE AGENT",
            font=("Segoe UI", 20, "bold"),
        ).pack(anchor="w")
        ttk.Label(
            outer,
            text="Demo Server LAB · búsqueda + preparación real + diagnóstico",
            font=("Segoe UI", 10),
        ).pack(anchor="w", pady=(0, 16))

        status = ttk.LabelFrame(outer, text="Conexión con OVH", padding=12)
        status.pack(fill="x")

        row = ttk.Frame(status)
        row.pack(fill="x")
        ttk.Label(row, text="Estado:", width=12).pack(side="left")
        ttk.Label(
            row,
            textvariable=self.connection_var,
            font=("Segoe UI", 10, "bold"),
        ).pack(side="left")
        ttk.Label(row, text="Código:", padding=(24, 0, 6, 0)).pack(side="left")
        ttk.Label(
            row,
            textvariable=self.code_var,
            font=("Consolas", 18, "bold"),
        ).pack(side="left")

        row2 = ttk.Frame(status)
        row2.pack(fill="x", pady=(10, 0))
        ttk.Label(row2, text="Servidor:", width=12).pack(side="left")
        ttk.Entry(row2, textvariable=self.server_var).pack(
            side="left", fill="x", expand=True
        )
        ttk.Button(row2, text="Reconectar", command=self.reconnect).pack(
            side="left", padx=(8, 0)
        )

        library = ttk.LabelFrame(outer, text="Carpeta autorizada", padding=12)
        library.pack(fill="x", pady=(14, 0))

        row3 = ttk.Frame(library)
        row3.pack(fill="x")
        ttk.Entry(row3, textvariable=self.folder_var, state="readonly").pack(
            side="left", fill="x", expand=True
        )
        ttk.Button(row3, text="Elegir carpeta", command=self.choose_folder).pack(
            side="left", padx=(8, 0)
        )
        ttk.Button(row3, text="Reindexar", command=self.start_scan).pack(
            side="left", padx=(8, 0)
        )

        ttk.Label(library, textvariable=self.scan_var).pack(anchor="w", pady=(10, 0))
        ttk.Label(
            library,
            textvariable=self.counts_var,
            font=("Segoe UI", 10, "bold"),
        ).pack(anchor="w", pady=(3, 0))

        engine = ttk.LabelFrame(outer, text="Motor de demos", padding=12)
        engine.pack(fill="x", pady=(14, 0))
        ttk.Label(
            engine,
            textvariable=self.prepare_var,
            font=("Segoe UI", 10, "bold"),
        ).pack(anchor="w")
        ttk.Label(
            engine,
            text=(
                "CDG: recorte + audio AAC 192 kbps. "
                "MP4 AUTO: detecta resolución/FPS y limita a 1280×720 sin upscale. "
                "YouTube Background AUTO: búsqueda + selección + video mudo opcional. "
                "La TV precarga el demo principal completo antes de PLAY."
            ),
            wraplength=750,
            justify="left",
        ).pack(anchor="w", pady=(4, 0))

        privacy = ttk.LabelFrame(outer, text="Protección", padding=12)
        privacy.pack(fill="x", pady=(14, 0))
        ttk.Label(
            privacy,
            text=(
                "Solo se indexa la carpeta elegida. Las rutas completas de Windows "
                "NO se envían a OVH. Los uploads usan un token temporal por reproducción "
                "y caducan en la caché del LAB."
            ),
            wraplength=750,
            justify="left",
        ).pack(anchor="w")

        logs = ttk.LabelFrame(outer, text="Logs permanentes del Agent", padding=8)
        logs.pack(fill="both", expand=True, pady=(14, 0))
        self.log_text = tk.Text(
            logs,
            height=16,
            wrap="word",
            font=("Consolas", 9),
            state="disabled",
        )
        self.log_text.pack(fill="both", expand=True)

    def ui(self, fn, *args) -> None:
        self.root.after(0, lambda: fn(*args))

    def add_log(self, message: str) -> None:
        stamp = time.strftime("%H:%M:%S")
        line = f"[{stamp}] {message}"
        self.log_queue.put(line)
        try:
            log_file = LOG_DIR / ("agent-" + time.strftime("%Y%m%d") + ".log")
            with log_file.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
        except Exception:
            pass

    def flush_logs(self) -> None:
        lines = []
        try:
            while True:
                lines.append(self.log_queue.get_nowait())
        except queue.Empty:
            pass

        if lines:
            self.log_text.configure(state="normal")
            self.log_text.insert("end", "\n".join(lines) + "\n")
            self.log_text.see("end")
            self.log_text.configure(state="disabled")

        if not self.stop_event.is_set():
            self.root.after(150, self.flush_logs)

    def choose_folder(self) -> None:
        selected = filedialog.askdirectory(
            title="Selecciona la carpeta raíz de karaokes"
        )
        if not selected:
            return
        self.folder_var.set(selected)
        self.save_config()
        self.start_scan()

    def start_scan(self, auto: bool = False) -> None:
        folder = self.folder_var.get().strip()
        if not folder:
            if not auto:
                messagebox.showinfo(APP_NAME, "Primero selecciona una carpeta.")
            return
        threading.Thread(
            target=self.scan_folder,
            args=(Path(folder),),
            daemon=True,
        ).start()

    def scan_folder(self, root_path: Path) -> None:
        if not root_path.exists() or not root_path.is_dir():
            self.ui(self.scan_var.set, "La carpeta ya no existe")
            self.add_log("Carpeta autorizada no disponible.")
            return

        started = time.perf_counter()
        self.ui(self.scan_var.set, "Indexando…")
        self.add_log(f"Indexando carpeta autorizada: {root_path.name}")

        files_seen = 0
        video_count = 0
        cdg_count = 0
        cdg_with_audio = 0
        items: list[dict] = []

        try:
            all_files: list[Path] = []
            for base, _dirs, names in os.walk(root_path):
                base_path = Path(base)
                for name in names:
                    file_path = base_path / name
                    ext = file_path.suffix.lower()
                    if ext in VIDEO_EXTS or ext == CDG_EXT or ext in AUDIO_EXTS:
                        all_files.append(file_path)
                        files_seen += 1

            by_parent_stem: dict[tuple[str, str], dict[str, Path]] = {}
            for file_path in all_files:
                key = (str(file_path.parent).lower(), file_path.stem.lower())
                by_parent_stem.setdefault(key, {})[file_path.suffix.lower()] = file_path

            for file_path in all_files:
                ext = file_path.suffix.lower()

                if ext in VIDEO_EXTS:
                    artist, title = parse_artist_title(file_path.stem)
                    key = normalize_text(f"{artist} {title} {file_path.stem}")
                    items.append(
                        {
                            "id": stable_id(file_path),
                            "artist": artist,
                            "title": title,
                            "format": "MP4" if ext == ".mp4" else ext[1:].upper(),
                            "audio": "",
                            "_path": str(file_path),
                            "_audio_path": "",
                            "_key": key,
                            "_title_key": normalize_text(title),
                            "_artist_key": normalize_text(artist),
                        }
                    )
                    video_count += 1
                    continue

                if ext != CDG_EXT:
                    continue

                cdg_count += 1
                siblings = by_parent_stem.get(
                    (str(file_path.parent).lower(), file_path.stem.lower()), {}
                )
                audio_path = None
                audio_ext = ""
                for candidate in AUDIO_EXTS:
                    if candidate in siblings:
                        audio_path = siblings[candidate]
                        audio_ext = candidate[1:].upper()
                        break

                if audio_path:
                    cdg_with_audio += 1

                artist, title = parse_artist_title(file_path.stem)
                key = normalize_text(f"{artist} {title} {file_path.stem}")
                items.append(
                    {
                        "id": stable_id(file_path),
                        "artist": artist,
                        "title": title,
                        "format": "CDG",
                        "audio": audio_ext,
                        "_path": str(file_path),
                        "_audio_path": str(audio_path) if audio_path else "",
                        "_key": key,
                        "_title_key": normalize_text(title),
                        "_artist_key": normalize_text(artist),
                    }
                )

            summary = {
                "files": files_seen,
                "songs": len(items),
                "video": video_count,
                "cdg": cdg_count,
                "cdgWithAudio": cdg_with_audio,
            }
            self.catalog.replace(items, summary)

            elapsed = time.perf_counter() - started
            self.ui(
                self.scan_var.set,
                f"Índice listo en {elapsed:.1f} s · {files_seen:,} archivos revisados",
            )
            self.ui(
                self.counts_var.set,
                f"{len(items):,} canciones · {video_count:,} video · "
                f"{cdg_with_audio:,} CDG+audio",
            )
            self.add_log(
                f"Índice listo: {len(items):,} canciones; "
                f"{video_count:,} video; {cdg_with_audio:,} CDG+audio."
            )
            if self.connected and self.registered:
                self.send_heartbeat()
        except Exception as exc:
            self.ui(self.scan_var.set, "Error al indexar")
            self.add_log(f"ERROR indexando: {exc}")

    def emit_diag(
        self,
        trace_id: str,
        event: str,
        data: dict | None = None,
        level: str = "info",
        room_code: str = "",
    ) -> None:
        clean = data or {}
        self.add_log(
            f"{event}"
            + (f" · trace {trace_id[:8]}" if trace_id else "")
            + (f" · {json.dumps(clean, ensure_ascii=False)}" if clean else "")
        )
        if not self.connected:
            return
        try:
            self.sio.emit(
                "agent:diagnostic",
                {
                    "traceId": trace_id,
                    "roomCode": room_code,
                    "event": event,
                    "data": clean,
                    "level": level,
                },
            )
        except Exception:
            pass

    def is_cancelled(self, trace_id: str) -> bool:
        return bool(trace_id) and (
            trace_id in self.cancelled_traces
            or (self.latest_prepare_trace_id and trace_id != self.latest_prepare_trace_id)
        )

    def ensure_not_cancelled(self, trace_id: str) -> None:
        if self.is_cancelled(trace_id):
            raise RuntimeError("PREPARE_SUPERSEDED")

    def run_ffmpeg(self, args: list[str], trace_id: str = "") -> None:
        if not self.ffmpeg_path:
            raise RuntimeError("FFmpeg no está disponible")
        command = [self.ffmpeg_path, "-hide_banner", "-loglevel", "error", "-y"] + args
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        while process.poll() is None:
            if trace_id and self.is_cancelled(trace_id):
                try:
                    process.terminate()
                    process.wait(timeout=3)
                except Exception:
                    try:
                        process.kill()
                    except Exception:
                        pass
                raise RuntimeError("PREPARE_SUPERSEDED")
            time.sleep(0.08)

        stdout, stderr = process.communicate()
        if process.returncode != 0:
            detail = (stderr or stdout or "FFmpeg error").strip()
            raise RuntimeError(detail[-600:])

    def prepare_cdg(
        self,
        item: dict,
        duration: int,
        workdir: Path,
        trace_id: str,
        room_code: str,
    ) -> dict[str, Path]:
        cdg_source = Path(item["_path"])
        audio_source = Path(item.get("_audio_path") or "")
        if not cdg_source.exists():
            raise FileNotFoundError("El CDG ya no existe en la carpeta autorizada")
        if not audio_source.exists():
            raise FileNotFoundError("El CDG no tiene audio emparejado")

        cdg_out = workdir / "demo.cdg"
        audio_out = workdir / "demo.m4a"

        target_bytes = duration * CDG_PACKETS_PER_SECOND * CDG_PACKET_SIZE
        started = time.perf_counter()
        with cdg_source.open("rb") as src, cdg_out.open("wb") as dst:
            remaining = target_bytes
            while remaining > 0:
                chunk = src.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                dst.write(chunk)
                remaining -= len(chunk)

        self.emit_diag(
            trace_id,
            "AGENT_CDG_SLICE_READY",
            {
                "bytes": cdg_out.stat().st_size,
                "elapsedMs": int((time.perf_counter() - started) * 1000),
                "duration": duration,
            },
            room_code=room_code,
        )

        started = time.perf_counter()
        self.run_ffmpeg(
            [
                "-i", str(audio_source),
                "-t", str(duration),
                "-vn",
                "-c:a", "aac",
                "-b:a", "192k",
                "-movflags", "+faststart",
                str(audio_out),
            ],
            trace_id=trace_id,
        )
        self.emit_diag(
            trace_id,
            "AGENT_AUDIO_TRANSCODE_READY",
            {
                "codec": "AAC",
                "bitrate": "192k",
                "bytes": audio_out.stat().st_size,
                "elapsedMs": int((time.perf_counter() - started) * 1000),
            },
            room_code=room_code,
        )
        return {"cdg": cdg_out, "audio": audio_out}

    def prepare_video(
        self,
        item: dict,
        duration: int,
        workdir: Path,
        trace_id: str,
        room_code: str,
        video_quality: str = "original",
    ) -> dict[str, Path]:
        source = Path(item["_path"])
        if not source.exists():
            raise FileNotFoundError("El video ya no existe en la carpeta autorizada")

        # V0.9: los karaokes MP4 conservan SIEMPRE la resolución original.
        # Si el video ya es H.264, copiamos el stream de video sin recodificar
        # y solo normalizamos audio a AAC para compatibilidad del navegador.
        requested = "original"

        probe_started = time.perf_counter()
        source_info = self.probe_video(source)
        source_width = int(source_info.get("width") or 0)
        source_height = int(source_info.get("height") or 0)
        source_fps = source_info.get("fps")
        source_codec = str(source_info.get("codec") or "").upper()
        detected_resolution = self.resolution_label(source_width, source_height)

        self.emit_diag(
            trace_id,
            "AGENT_VIDEO_SOURCE_PROBED",
            {
                "sourceWidth": source_width,
                "sourceHeight": source_height,
                "sourceFps": source_fps,
                "sourceCodec": source_codec or None,
                "sourcePixFmt": source_info.get("pixFmt"),
                "sourceResolution": f"{source_width}x{source_height}",
                "detectedResolution": detected_resolution,
                "probe": source_info.get("probe"),
                "elapsedMs": int((time.perf_counter() - probe_started) * 1000),
            },
            room_code=room_code,
        )

        can_video_stream_copy = source_codec in {"H264", "AVC", "AVC1"}
        decision = (
            "VIDEO_STREAM_COPY"
            if can_video_stream_copy
            else "VIDEO_COMPAT_TRANSCODE_ORIGINAL_RESOLUTION"
        )

        self.emit_diag(
            trace_id,
            "AGENT_VIDEO_QUALITY_DECISION",
            {
                "requestedQuality": requested,
                "sourceWidth": source_width,
                "sourceHeight": source_height,
                "sourceFps": source_fps,
                "detectedResolution": detected_resolution,
                "outputResolutionPolicy": "PRESERVE_SOURCE",
                "decision": decision,
                "noUpscale": True,
                "noDownscale": True,
                "videoStreamCopy": can_video_stream_copy,
            },
            room_code=room_code,
        )

        video_out = workdir / "demo.mp4"
        started = time.perf_counter()
        prepare_mode = decision

        if can_video_stream_copy:
            copy_args = [
                "-i", str(source),
                "-t", str(duration),
                "-map", "0:v:0",
                "-map", "0:a?",
                "-c:v", "copy",
                "-c:a", "aac",
                "-b:a", "192k",
                "-movflags", "+faststart",
                str(video_out),
            ]
            try:
                self.run_ffmpeg(copy_args, trace_id=trace_id)
            except Exception as copy_error:
                self.emit_diag(
                    trace_id,
                    "AGENT_MP4_STREAM_COPY_FALLBACK",
                    {"error": str(copy_error)[-600:]},
                    level="warn",
                    room_code=room_code,
                )
                try:
                    video_out.unlink(missing_ok=True)
                except Exception:
                    pass
                prepare_mode = "VIDEO_COMPAT_TRANSCODE_ORIGINAL_RESOLUTION"

        if prepare_mode == "VIDEO_COMPAT_TRANSCODE_ORIGINAL_RESOLUTION":
            transcode_args = [
                "-i", str(source),
                "-t", str(duration),
                "-map", "0:v:0",
                "-map", "0:a?",
                "-c:v", "libx264",
                "-preset", "veryfast",
                "-crf", "18",
                "-pix_fmt", "yuv420p",
                "-c:a", "aac",
                "-b:a", "192k",
                "-movflags", "+faststart",
                str(video_out),
            ]
            self.run_ffmpeg(transcode_args, trace_id=trace_id)

        prepare_ms = int((time.perf_counter() - started) * 1000)
        output_info = self.probe_video(video_out)
        output_width = int(output_info.get("width") or 0)
        output_height = int(output_info.get("height") or 0)
        output_fps = output_info.get("fps")

        if output_width != source_width or output_height != source_height:
            raise RuntimeError(
                "ORIGINAL_RESOLUTION_GUARD: la salida MP4 cambió la resolución original"
            )

        self.emit_diag(
            trace_id,
            "AGENT_MP4_TRANSCODE_READY",
            {
                "videoCodec": output_info.get("codec") or "H264",
                "audioCodec": "AAC",
                "audioBitrate": "192k",
                "requestedQuality": "original",
                "decision": prepare_mode,
                "sourceWidth": source_width,
                "sourceHeight": source_height,
                "outputWidth": output_width,
                "outputHeight": output_height,
                "sourceFps": source_fps,
                "outputFps": output_fps,
                "sourceResolution": f"{source_width}x{source_height}",
                "outputResolution": f"{output_width}x{output_height}",
                "originalResolutionPreserved": True,
                "videoStreamCopied": prepare_mode == "VIDEO_STREAM_COPY",
                "bytes": video_out.stat().st_size,
                "prepareMs": prepare_ms,
                "elapsedMs": prepare_ms,
            },
            room_code=room_code,
        )
        return {"video": video_out}

    @staticmethod
    def _clean_youtube_component(value: str) -> str:
        text = str(value or "").replace("_", " ")
        text = re.sub(
            r"(?i)\b(karaoke|hifi|djgabo|club\s+karaoke|clean\s+edit|720p|1080p|2160p|4k|hd|fhd|uhd)\b",
            " ",
            text,
        )
        text = re.sub(
            r"(?i)\((?:coro|coros|voz\s+(?:mujer|hombre)|instrumental|clean\s+edit)\)",
            " ",
            text,
        )
        text = re.sub(r"(?i)\bby\s+djgabo\b", " ", text)
        text = re.sub(r"\s+", " ", text).strip(" -–—")
        return text

    def _youtube_base_args(self) -> list[str]:
        args = [
            sys.executable,
            "-m",
            "yt_dlp",
            "--ignore-config",
            "--no-warnings",
            "--no-playlist",
            "--socket-timeout",
            "12",
            "--retries",
            "2",
            "--extractor-retries",
            "2",
        ]
        if self.deno_path:
            args += ["--js-runtimes", f"deno:{self.deno_path}"]
        elif self.node_path:
            args += ["--js-runtimes", f"node:{self.node_path}"]
        cookies = Path(__file__).with_name("cookies.txt")
        try:
            if cookies.exists() and cookies.stat().st_size > 100:
                args += ["--cookies", str(cookies)]
        except Exception:
            pass
        return args

    def _run_ytdlp_json(
        self,
        args: list[str],
        trace_id: str,
        timeout: int = 45,
    ) -> dict:
        if not self.ytdlp_available:
            raise RuntimeError("YTDLP_NOT_AVAILABLE")
        command = self._youtube_base_args() + args
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        deadline = time.monotonic() + max(1, timeout)
        stdout = ""
        stderr = ""
        while True:
            if trace_id and self.is_cancelled(trace_id):
                try:
                    process.kill()
                except Exception:
                    pass
                try:
                    process.communicate(timeout=2)
                except Exception:
                    pass
                raise RuntimeError("PREPARE_SUPERSEDED")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                try:
                    process.kill()
                except Exception:
                    pass
                try:
                    stdout, stderr = process.communicate(timeout=2)
                except Exception:
                    pass
                detail = " ".join((stderr or stdout or "").split())[-600:]
                raise RuntimeError("YTDLP_TIMEOUT" + (" · " + detail if detail else ""))
            try:
                # communicate() drena stdout/stderr mientras espera. Así yt-dlp no
                # puede quedar bloqueado por llenar el pipe con JSON de resultados.
                stdout, stderr = process.communicate(timeout=min(0.35, remaining))
                break
            except subprocess.TimeoutExpired:
                continue
        if process.returncode != 0 or not (stdout or "").strip():
            detail = " ".join((stderr or stdout or "yt-dlp error").split())
            raise RuntimeError(detail[-1200:])
        try:
            return json.loads(stdout)
        except Exception as exc:
            raise RuntimeError("YTDLP_JSON_INVALID") from exc

    def search_youtube_background(
        self,
        artist: str,
        song_title: str,
        trace_id: str,
        room_code: str,
    ) -> dict:
        artist_clean = self._clean_youtube_component(artist)
        title_clean = self._clean_youtube_component(song_title)
        if not title_clean:
            raise RuntimeError("YOUTUBE_QUERY_EMPTY")
        query = " ".join(x for x in [artist_clean, title_clean, "official video"] if x).strip()
        started = time.perf_counter()
        self.emit_diag(
            trace_id,
            "YOUTUBE_BACKGROUND_SEARCH_START",
            {"query": query, "limit": 12},
            room_code=room_code,
        )
        payload = self._run_ytdlp_json(
            ["--flat-playlist", "--dump-single-json", f"ytsearch12:{query}"],
            trace_id,
            timeout=40,
        )
        entries = [e for e in (payload.get("entries") or []) if isinstance(e, dict)]
        if not entries:
            raise RuntimeError("YOUTUBE_SEARCH_NO_RESULTS")

        artist_norm = normalize_text(artist_clean)
        title_norm = normalize_text(title_clean)
        title_tokens = [t for t in title_norm.split() if len(t) > 1]
        hard_reject_terms = {
            "karaoke",
            "cover",
            "reaction",
            "reaccion",
            "tutorial",
            "slowed",
            "nightcore",
            "instrumental",
        }
        soft_negative_terms = {
            "lyrics": 60,
            "lyric": 60,
            "letra": 60,
            "sped": 70,
        }
        live_terms = (" live ", " en vivo ", " concierto ", " concert ")

        candidates = []
        for rank, entry in enumerate(entries):
            video_id = str(entry.get("id") or "")
            if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
                continue
            yt_title = str(entry.get("title") or "")
            channel = str(entry.get("channel") or entry.get("uploader") or "")
            title_key = " " + normalize_text(yt_title) + " "
            channel_key = normalize_text(channel)
            if not title_tokens:
                continue
            coverage = sum(1 for token in title_tokens if token in title_key) / max(1, len(title_tokens))
            similarity = difflib.SequenceMatcher(None, title_norm, normalize_text(yt_title)).ratio()
            artist_match = bool(
                artist_norm and (
                    artist_norm in channel_key
                    or artist_norm in title_key
                    or all(t in (channel_key + " " + title_key) for t in artist_norm.split() if len(t) > 2)
                )
            )
            if coverage < 0.55 and similarity < 0.48:
                continue

            lowered = title_key
            if any(f" {term} " in lowered for term in hard_reject_terms):
                continue
            penalty = 0
            for term, points in soft_negative_terms.items():
                if f" {term} " in lowered:
                    penalty += points
            if any(term in lowered for term in live_terms):
                penalty += 35

            verified = bool(entry.get("channel_is_verified"))
            official_marker = any(
                marker in lowered
                for marker in (
                    " official ",
                    " video oficial ",
                    " official music video ",
                    " videoclip oficial ",
                )
            )
            channel_official_marker = "official" in channel_key or "vevo" in channel_key
            official_confidence = (
                "verified-artist-channel"
                if verified and artist_match
                else "artist-channel-official-marker"
                if artist_match and (official_marker or channel_official_marker)
                else ""
            )
            official = bool(official_confidence)
            try:
                views = int(entry.get("view_count") or 0)
            except Exception:
                views = 0

            score = int(coverage * 100) + int(similarity * 40)
            if artist_match:
                score += 55
            if official_marker:
                score += 55
            if verified and artist_match:
                score += 80
            score -= penalty
            candidates.append(
                {
                    "youtubeId": video_id,
                    "title": yt_title[:240],
                    "channel": channel[:180],
                    "viewCount": max(0, views),
                    "official": official,
                    "officialConfidence": official_confidence,
                    "score": score,
                    "coverage": round(coverage, 3),
                    "artistMatch": artist_match,
                    "rank": rank,
                }
            )

        if not candidates:
            raise RuntimeError("YOUTUBE_SEARCH_NO_MATCHING_VIDEO")

        official_candidates = [c for c in candidates if c["official"] and c["score"] > 0]
        if official_candidates:
            selected = sorted(
                official_candidates,
                key=lambda x: (
                    x["officialConfidence"] == "verified-artist-channel",
                    x["score"],
                    x["viewCount"],
                    -x["rank"],
                ),
                reverse=True,
            )[0]
            selected["selectionReason"] = "OFFICIAL_CHANNEL_FIRST"
        else:
            usable = [
                c for c in candidates
                if c["score"] > 0
                and c["artistMatch"]
                and c["coverage"] >= 0.50
            ]
            if not usable:
                raise RuntimeError("YOUTUBE_SEARCH_ONLY_LOW_CONFIDENCE_RESULTS")
            has_views = any(c["viewCount"] > 0 for c in usable)
            selected = sorted(
                usable,
                key=(
                    (lambda x: (x["viewCount"], x["score"], -x["rank"]))
                    if has_views
                    else (lambda x: (x["score"], -x["rank"]))
                ),
                reverse=True,
            )[0]
            selected["selectionReason"] = (
                "MOST_VIEWED_MATCH" if has_views else "SEARCH_RANK_FALLBACK"
            )

        self.emit_diag(
            trace_id,
            "YOUTUBE_BACKGROUND_SELECTED",
            {
                **selected,
                "candidateCount": len(candidates),
                "searchMs": int((time.perf_counter() - started) * 1000),
            },
            room_code=room_code,
        )
        return selected

    def resolve_youtube_video_stream(
        self,
        video_id: str,
        trace_id: str,
        room_code: str,
    ) -> dict:
        target = f"https://www.youtube.com/watch?v={video_id}"
        fmt = (
            "bv*[height<=480][ext=mp4][vcodec^=avc1]/"
            "bv*[height<=480][ext=mp4]/"
            "bv*[height<=480]/"
            "b[height<=480]"
        )
        attempts = [
            ("DEFAULT", []),
            ("ANDROID_VR", ["--extractor-args", "youtube:player_client=android_vr"]),
            ("WEB_SAFARI", ["--extractor-args", "youtube:player_client=web_safari"]),
        ]
        errors = []
        for label, extra in attempts:
            self.ensure_not_cancelled(trace_id)
            try:
                info = self._run_ytdlp_json(
                    [
                        *extra,
                        "--skip-download",
                        "--dump-single-json",
                        "-f",
                        fmt,
                        target,
                    ],
                    trace_id,
                    timeout=55,
                )
                stream = None
                requested = info.get("requested_formats") or []
                for part in requested:
                    if isinstance(part, dict) and str(part.get("vcodec") or "none") != "none" and part.get("url"):
                        stream = part
                        break
                if stream is None and info.get("url"):
                    stream = info
                if not stream or not stream.get("url"):
                    raise RuntimeError("YOUTUBE_STREAM_URL_MISSING")
                result = {
                    "url": str(stream["url"]),
                    "headers": stream.get("http_headers") or info.get("http_headers") or {},
                    "width": int(stream.get("width") or info.get("width") or 0),
                    "height": int(stream.get("height") or info.get("height") or 0),
                    "fps": stream.get("fps") or info.get("fps"),
                    "vcodec": str(stream.get("vcodec") or info.get("vcodec") or ""),
                    "ext": str(stream.get("ext") or info.get("ext") or ""),
                    "protocol": str(stream.get("protocol") or info.get("protocol") or ""),
                    "formatId": str(stream.get("format_id") or info.get("format_id") or ""),
                    "resolverMode": label,
                }
                self.emit_diag(
                    trace_id,
                    "YOUTUBE_BACKGROUND_STREAM_RESOLVED",
                    {
                        "resolverMode": label,
                        "sourceWidth": result["width"],
                        "sourceHeight": result["height"],
                        "sourceFps": result["fps"],
                        "videoCodec": result["vcodec"],
                        "ext": result["ext"],
                        "protocol": result["protocol"],
                        "formatId": result["formatId"],
                    },
                    room_code=room_code,
                )
                return result
            except Exception as exc:
                if str(exc) == "PREPARE_SUPERSEDED":
                    raise
                errors.append(f"{label}: {str(exc)[-450:]}")
        raise RuntimeError("YOUTUBE_RESOLVE_FAILED · " + " | ".join(errors[-3:]))

    # MP4LAB_STREAM_PIPE_V1
def stream_youtube_background_to_ovh(
    self,
    selected: dict,
    stream: dict,
    duration: int,
    upload_url: str,
    upload_token: str,
    trace_id: str,
    room_code: str,
) -> dict:
    self.ensure_not_cancelled(trace_id)
    if not self.ffmpeg_path:
        raise RuntimeError("FFMPEG_NOT_AVAILABLE")
    if not upload_url or "/hybrid-upload" not in upload_url:
        raise RuntimeError("MP4LAB_STREAM_PIPE_INVALID_UPLOAD_URL")

    header_lines = []
    for key in ("User-Agent", "Referer", "Origin"):
        value = str((stream.get("headers") or {}).get(key) or "")
        if value:
            header_lines.append(f"{key}: {value}\\r\\n")

    source_width = int(stream.get("width") or 0)
    source_height = int(stream.get("height") or 0)
    source_codec = str(stream.get("vcodec") or "").lower()
    source_ext = str(stream.get("ext") or "").lower()
    can_stream_copy = bool(
        ("avc1" in source_codec or "h264" in source_codec)
        and source_ext == "mp4"
        and source_height > 0
        and source_height <= 480
    )
    prepare_mode = "PIPE_STREAM_COPY" if can_stream_copy else "PIPE_FAST_TRANSCODE"

    input_args = [
        "-reconnect", "1",
        "-reconnect_streamed", "1",
        "-reconnect_delay_max", "5",
    ]
    if header_lines:
        input_args += ["-headers", "".join(header_lines)]

    output_args = [
        "-i", stream["url"],
        "-t", str(duration),
        "-map", "0:v:0",
        "-an",
    ]
    if can_stream_copy:
        output_args += ["-c:v", "copy"]
    else:
        output_args += [
            "-vf",
            "scale=w='min(iw,854)':h='min(ih,480)':force_original_aspect_ratio=decrease:force_divisible_by=2",
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-crf", "30",
            "-maxrate", "1000k",
            "-bufsize", "2000k",
            "-pix_fmt", "yuv420p",
        ]
    output_args += [
        "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
        "-f", "mp4",
        "pipe:1",
    ]

    command = [
        self.ffmpeg_path,
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
    ] + input_args + output_args

    self.emit_diag(
        trace_id,
        "YOUTUBE_BACKGROUND_PIPE_START",
        {
            "mode": prepare_mode,
            "duration": duration,
            "sourceWidth": source_width,
            "sourceHeight": source_height,
            "sourceCodec": stream.get("vcodec"),
            "sourceExt": stream.get("ext"),
            "transport": "HTTP_CHUNKED_PC_TO_OVH",
            "localTempFile": False,
        },
        room_code=room_code,
    )

    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    if process.stdout is None or process.stderr is None:
        try:
            process.kill()
        except Exception:
            pass
        raise RuntimeError("FFMPEG_PIPE_NOT_AVAILABLE")

    stderr_parts: list[bytes] = []
    def drain_stderr() -> None:
        try:
            while True:
                piece = process.stderr.read(8192)
                if not piece:
                    break
                stderr_parts.append(piece)
                if len(stderr_parts) > 80:
                    del stderr_parts[:20]
        except Exception:
            pass
    stderr_thread = threading.Thread(target=drain_stderr, daemon=True)
    stderr_thread.start()

    started = time.perf_counter()
    sent_bytes = 0
    first_byte_ms = None

    def body_iter():
        nonlocal sent_bytes, first_byte_ms
        try:
            while True:
                if self.is_cancelled(trace_id):
                    try:
                        process.terminate()
                    except Exception:
                        pass
                    raise RuntimeError("PREPARE_SUPERSEDED")
                chunk = os.read(process.stdout.fileno(), 64 * 1024)
                if not chunk:
                    break
                sent_bytes += len(chunk)
                if first_byte_ms is None:
                    first_byte_ms = int((time.perf_counter() - started) * 1000)
                    self.emit_diag(
                        trace_id,
                        "YOUTUBE_BACKGROUND_PIPE_FIRST_BYTE",
                        {"elapsedMs": first_byte_ms, "bytes": len(chunk)},
                        room_code=room_code,
                    )
                yield chunk
        finally:
            try:
                process.stdout.close()
            except Exception:
                pass

    try:
        response = requests.put(
            upload_url,
            data=body_iter(),
            headers={
                "X-Upload-Token": upload_token,
                "Content-Type": "video/mp4",
            },
            timeout=(15, max(300, int(duration) * 5)),
        )
    except Exception:
        try:
            process.kill()
        except Exception:
            pass
        raise
    finally:
        try:
            process.wait(timeout=20)
        except Exception:
            try:
                process.kill()
            except Exception:
                pass
        stderr_thread.join(timeout=2)

    stderr_text = b"".join(stderr_parts).decode("utf-8", errors="replace").strip()
    if process.returncode not in (0, None):
        raise RuntimeError("FFMPEG_PIPE_FAILED · " + (stderr_text[-1000:] or f"rc={process.returncode}"))
    if response.status_code >= 400:
        raise RuntimeError(
            f"Upload background HTTP {response.status_code}: {response.text[:500]}"
        )

    elapsed_ms = int((time.perf_counter() - started) * 1000)
    try:
        receiver = response.json()
    except Exception:
        receiver = {}

    out_width = source_width
    out_height = source_height
    if not can_stream_copy and source_width > 0 and source_height > 0:
        ratio = min(1.0, 854.0 / source_width, 480.0 / source_height)
        out_width = max(2, int(source_width * ratio) // 2 * 2)
        out_height = max(2, int(source_height * ratio) // 2 * 2)

    meta = {
        **selected,
        "sourceWidth": source_width,
        "sourceHeight": source_height,
        "sourceFps": stream.get("fps"),
        "sourceCodec": stream.get("vcodec"),
        "outputWidth": out_width,
        "outputHeight": out_height,
        "outputFps": stream.get("fps"),
        "resolverMode": stream.get("resolverMode"),
        "prepareMode": prepare_mode,
        "backgroundQuality": "normal",
        "youtubeQualityPolicy": "BEST_AVAILABLE_UP_TO_480P",
        "targetHeight": 480,
        "noUpscale": True,
        "bytes": int(receiver.get("bytes") or sent_bytes),
        "elapsedMs": elapsed_ms,
        "firstByteMs": first_byte_ms,
        "muted": True,
        "transport": "HTTP_CHUNKED_PC_TO_OVH",
    }
    self.emit_diag(
        trace_id,
        "YOUTUBE_BACKGROUND_PIPE_COMPLETE",
        {
            "bytes": meta["bytes"],
            "elapsedMs": elapsed_ms,
            "firstByteMs": first_byte_ms,
            "mbps": round((sent_bytes * 8 / 1_000_000) / max(elapsed_ms / 1000, 0.001), 2),
            "receiverState": receiver.get("state"),
            "receiverDuration": receiver.get("duration"),
        },
        room_code=room_code,
    )
    self.emit_diag(
        trace_id,
        "YOUTUBE_BACKGROUND_TRANSCODE_READY",
        meta,
        room_code=room_code,
    )
    return meta

    def prepare_youtube_background(
        self,
        media: dict,
        duration: int,
        upload_url: str,
        upload_token: str,
        trace_id: str,
        room_code: str,
        core_ready_event: threading.Event | None = None,
    ) -> None:
        try:
            if not upload_url:
                return
            if not self.ytdlp_available:
                raise RuntimeError("YTDLP_NOT_AVAILABLE")
            artist = str(media.get("artist") or "")
            song_title = str(media.get("songTitle") or "")
            if not song_title:
                parsed_artist, parsed_title = parse_artist_title(str(media.get("title") or ""))
                artist = artist or parsed_artist
                song_title = parsed_title

            # Muchos catálogos comerciales tienen un código de disco/pista antes
            # del artista real: "MRH11-06 - Keane - Bedshaped". Si el primer
            # campo parece código, reparseamos "Keane - Bedshaped" para no
            # contaminar la búsqueda YouTube con MRH11-06/SF249-09/etc.
            compact_artist = re.sub(r"[^A-Za-z0-9-]", "", artist)
            looks_catalog_code = bool(
                re.fullmatch(r"[A-Za-z]{1,10}\d{1,6}(?:-\d{1,3})?", compact_artist)
                or re.fullmatch(r"[A-Za-z]{1,8}\d{1,6}-\d{1,3}", compact_artist)
            )
            nested_artist, nested_title = parse_artist_title(song_title)
            if looks_catalog_code and nested_artist and nested_title:
                self.emit_diag(
                    trace_id,
                    "YOUTUBE_BACKGROUND_QUERY_NORMALIZED",
                    {
                        "catalogCode": artist[:40],
                        "artist": nested_artist[:160],
                        "songTitle": nested_title[:220],
                    },
                    room_code=room_code,
                )
                artist = nested_artist
                song_title = nested_title

            selected = self.search_youtube_background(
                artist,
                song_title,
                trace_id,
                room_code,
            )
            stream = self.resolve_youtube_video_stream(
                selected["youtubeId"],
                trace_id,
                room_code,
            )
            self.ensure_not_cancelled(trace_id)

            # MP4 LAB hybrid: FFmpeg reads YouTube on this PC and uploads to OVH
            # while bytes are produced; no complete local background.mp4 is staged first.
            if "/hybrid-upload" in upload_url:
                meta = self.stream_youtube_background_to_ovh(
                    selected, stream, duration, upload_url, upload_token, trace_id, room_code
                )
                self.ensure_not_cancelled(trace_id)
                self.sio.emit(
                    "agent:background:complete",
                    {"traceId": trace_id, "background": meta},
                )
                return

            if core_ready_event is not None and not core_ready_event.is_set():
                self.emit_diag(
                    trace_id,
                    "YOUTUBE_BACKGROUND_WAIT_CORE",
                    {
                        "reason": "avoid-parallel-ffmpeg-contention",
                        "searchAndResolveAlreadyComplete": True,
                    },
                    room_code=room_code,
                )
                wait_started = time.perf_counter()
                while not core_ready_event.wait(0.20):
                    self.ensure_not_cancelled(trace_id)
                    if time.perf_counter() - wait_started > 90:
                        raise RuntimeError("YOUTUBE_BACKGROUND_CORE_WAIT_TIMEOUT")

            with tempfile.TemporaryDirectory(prefix="kitkaraoke-youtube-bg-") as temp:
                output = Path(temp) / "background.mp4"
                header_lines = []
                for key in ("User-Agent", "Referer", "Origin"):
                    value = str((stream.get("headers") or {}).get(key) or "")
                    if value:
                        header_lines.append(f"{key}: {value}\\r\\n")

                # YouTube es solo fondo: una sola política automática.
                # Elegimos la mejor calidad que exista hasta 480p. Si el
                # original disponible es 360p/240p/etc., conservamos esa máxima
                # calidad inferior. Nunca hacemos upscale.
                quality = str(media.get("backgroundQuality") or "normal").strip().lower()
                target_height = 480
                source_width = int(stream.get("width") or 0)
                source_height = int(stream.get("height") or 0)
                source_codec = str(stream.get("vcodec") or "").lower()
                source_ext = str(stream.get("ext") or "").lower()
                can_stream_copy = bool(
                    ("avc1" in source_codec or "h264" in source_codec)
                    and source_ext == "mp4"
                    and source_height > 0
                    and source_height <= 480
                )

                base_args = [
                    "-reconnect", "1",
                    "-reconnect_streamed", "1",
                    "-reconnect_delay_max", "5",
                ]
                if header_lines:
                    base_args += ["-headers", "".join(header_lines)]

                prepare_mode = "STREAM_COPY" if can_stream_copy else "FAST_TRANSCODE"
                self.emit_diag(
                    trace_id,
                    "YOUTUBE_BACKGROUND_PREPARE_MODE",
                    {
                        "mode": prepare_mode,
                        "backgroundQuality": quality,
                        "youtubeQualityPolicy": "BEST_AVAILABLE_UP_TO_480P",
                        "targetHeight": 480,
                        "sourceWidth": source_width,
                        "sourceHeight": source_height,
                        "sourceCodec": stream.get("vcodec"),
                        "sourceExt": stream.get("ext"),
                        "noUpscale": True,
                    },
                    room_code=room_code,
                )

                started = time.perf_counter()
                if can_stream_copy:
                    copy_args = base_args + [
                        "-i", stream["url"],
                        "-t", str(duration),
                        "-an",
                        "-c:v", "copy",
                        "-movflags", "+faststart",
                        str(output),
                    ]
                    try:
                        self.run_ffmpeg(copy_args, trace_id=trace_id)
                    except Exception as copy_error:
                        self.emit_diag(
                            trace_id,
                            "YOUTUBE_BACKGROUND_STREAM_COPY_FALLBACK",
                            {"error": str(copy_error)[-600:]},
                            level="warn",
                            room_code=room_code,
                        )
                        prepare_mode = "FAST_TRANSCODE"

                if prepare_mode == "FAST_TRANSCODE":
                    transcode_args = base_args + [
                        "-i", stream["url"],
                        "-t", str(duration),
                        "-an",
                        "-vf",
                        (
                            "scale=w='min(iw,854)':h='min(ih,480)':"
                            "force_original_aspect_ratio=decrease:force_divisible_by=2"
                        ),
                        "-c:v", "libx264",
                        "-preset", "ultrafast",
                        "-crf", "30",
                        "-maxrate", "1000k" if target_height <= 480 else "1200k",
                        "-bufsize", "2000k" if target_height <= 480 else "2400k",
                        "-pix_fmt", "yuv420p",
                        "-movflags", "+faststart",
                        str(output),
                    ]
                    self.run_ffmpeg(transcode_args, trace_id=trace_id)

                prepare_ms = int((time.perf_counter() - started) * 1000)
                out_info = self.probe_video(output)
                meta = {
                    **selected,
                    "sourceWidth": source_width,
                    "sourceHeight": source_height,
                    "sourceFps": stream.get("fps"),
                    "sourceCodec": stream.get("vcodec"),
                    "outputWidth": int(out_info.get("width") or 0),
                    "outputHeight": int(out_info.get("height") or 0),
                    "outputFps": out_info.get("fps"),
                    "resolverMode": stream.get("resolverMode"),
                    "prepareMode": prepare_mode,
                    "backgroundQuality": quality,
                    "youtubeQualityPolicy": "BEST_AVAILABLE_UP_TO_480P",
                    "targetHeight": 480,
                    "noUpscale": True,
                    "bytes": output.stat().st_size,
                    "elapsedMs": prepare_ms,
                    "muted": True,
                }
                self.emit_diag(
                    trace_id,
                    "YOUTUBE_BACKGROUND_TRANSCODE_READY",
                    meta,
                    room_code=room_code,
                )
                self.upload_part(
                    upload_url,
                    upload_token,
                    output,
                    "background",
                    trace_id,
                    room_code,
                )
                self.ensure_not_cancelled(trace_id)
                self.sio.emit(
                    "agent:background:complete",
                    {"traceId": trace_id, "background": meta},
                )
        except Exception as exc:
            if str(exc) == "PREPARE_SUPERSEDED":
                self.emit_diag(
                    trace_id,
                    "YOUTUBE_BACKGROUND_CANCELLED",
                    {"reason": "replaced-by-newer-request"},
                    level="warn",
                    room_code=room_code,
                )
                return
            error_text = str(exc)[-1200:]
            self.emit_diag(
                trace_id,
                "YOUTUBE_BACKGROUND_FALLBACK",
                {
                    "error": error_text,
                    "fallback": "GENERATED_BACKGROUND",
                    "karaokeContinues": True,
                },
                level="warn",
                room_code=room_code,
            )
            try:
                self.sio.emit(
                    "agent:background:error",
                    {
                        "traceId": trace_id,
                        "error": error_text,
                        "retryable": True,
                    },
                )
            except Exception:
                pass

    def upload_part(
        self,
        url: str,
        token: str,
        file_path: Path,
        kind: str,
        trace_id: str,
        room_code: str,
    ) -> tuple[int, int]:
        size = file_path.stat().st_size
        mime = {
            "cdg": "application/octet-stream",
            "audio": "audio/mp4",
            "video": "video/mp4",
            "background": "video/mp4",
        }.get(kind, "application/octet-stream")
        started = time.perf_counter()

        self.emit_diag(
            trace_id,
            "AGENT_UPLOAD_START",
            {"kind": kind, "bytes": size},
            room_code=room_code,
        )

        with file_path.open("rb") as handle:
            response = requests.put(
                url,
                data=handle,
                headers={
                    "X-Upload-Token": token,
                    "Content-Type": mime,
                    "Content-Length": str(size),
                },
                timeout=(15, 180),
            )
        if response.status_code >= 400:
            raise RuntimeError(
                f"Upload {kind} HTTP {response.status_code}: {response.text[:180]}"
            )

        elapsed_ms = int((time.perf_counter() - started) * 1000)
        self.emit_diag(
            trace_id,
            "AGENT_UPLOAD_COMPLETE",
            {
                "kind": kind,
                "bytes": size,
                "elapsedMs": elapsed_ms,
                "mbps": round((size * 8 / 1_000_000) / max(elapsed_ms / 1000, 0.001), 2),
            },
            room_code=room_code,
        )
        return size, elapsed_ms

    def prepare_media(self, payload: dict) -> None:
        trace_id = str(payload.get("traceId") or "")
        room_code = str(payload.get("roomCode") or "")
        media = payload.get("media") or {}
        media_id = str(media.get("id") or "")
        duration = int(payload.get("duration") or 120)
        uploads = payload.get("uploads") or {}
        upload_token = str(payload.get("uploadToken") or "")
        total_started = time.perf_counter()
        background_core_ready = threading.Event()

        if duration not in (30, 45, 60, 120):
            duration = 120

        try:
            if not self.ffmpeg_path:
                raise RuntimeError("FFmpeg no disponible en el Agent")
            self.ensure_not_cancelled(trace_id)

            self.ui(self.prepare_var.set, "Preparando demo…")
            self.emit_diag(
                trace_id,
                "AGENT_PREPARE_START",
                {
                    "mediaId": media_id,
                    "title": str(media.get("title") or ""),
                    "format": str(media.get("format") or ""),
                    "duration": duration,
                    "videoQuality": str(media.get("videoQuality") or "original"),
                    "cdgBackground": str(media.get("cdgBackground") or ""),
                    "youtubeBackground": str(media.get("cdgBackground") or "").lower() == "youtube-auto",
                },
                room_code=room_code,
            )

            lookup_started = time.perf_counter()
            item = self.catalog.get(media_id)
            if not item:
                raise FileNotFoundError("MEDIA_ID_NOT_FOUND_IN_LOCAL_CATALOG")

            self.emit_diag(
                trace_id,
                "AGENT_MEDIA_FOUND",
                {
                    "format": item["format"],
                    "audio": item["audio"],
                    "elapsedMs": int((time.perf_counter() - lookup_started) * 1000),
                },
                room_code=room_code,
            )

            if (
                item["format"] == "CDG"
                and str(media.get("cdgBackground") or "").lower() == "youtube-auto"
                and str(uploads.get("background") or "")
            ):
                threading.Thread(
                    target=self.prepare_youtube_background,
                    args=(
                        dict(media),
                        duration,
                        str(uploads.get("background") or ""),
                        upload_token,
                        trace_id,
                        room_code,
                        background_core_ready,
                    ),
                    daemon=True,
                ).start()
                self.emit_diag(
                    trace_id,
                    "YOUTUBE_BACKGROUND_ASYNC_STARTED",
                    {
                        "artist": str(media.get("artist") or ""),
                        "songTitle": str(media.get("songTitle") or ""),
                        "nonBlocking": True,
                    },
                    room_code=room_code,
                )

            with tempfile.TemporaryDirectory(prefix="kitkaraoke-demo-") as temp:
                workdir = Path(temp)
                if item["format"] == "CDG":
                    parts = self.prepare_cdg(
                        item, duration, workdir, trace_id, room_code
                    )
                else:
                    parts = self.prepare_video(
                        item,
                        duration,
                        workdir,
                        trace_id,
                        room_code,
                        str(media.get("videoQuality") or "original"),
                    )

                background_core_ready.set()
                self.ensure_not_cancelled(trace_id)
                total_bytes = 0
                upload_ms = 0
                for kind, file_path in parts.items():
                    self.ensure_not_cancelled(trace_id)
                    url = str(uploads.get(kind) or "")
                    if not url:
                        raise RuntimeError(f"Falta URL temporal para {kind}")
                    size, elapsed = self.upload_part(
                        url,
                        upload_token,
                        file_path,
                        kind,
                        trace_id,
                        room_code,
                    )
                    total_bytes += size
                    upload_ms += elapsed

            total_ms = int((time.perf_counter() - total_started) * 1000)
            metrics = {
                "totalMs": total_ms,
                "uploadMs": upload_ms,
                "totalBytes": total_bytes,
                "duration": duration,
                "youtubeBackgroundNonBlocking": bool(
                    item["format"] == "CDG"
                    and str(media.get("cdgBackground") or "").lower() == "youtube-auto"
                ),
            }
            self.emit_diag(
                trace_id,
                "AGENT_PREPARE_COMPLETE",
                metrics,
                room_code=room_code,
            )
            self.sio.emit(
                "agent:prepare:complete",
                {"traceId": trace_id, "metrics": metrics},
            )
            self.ui(self.prepare_var.set, "Demo listo · enviado a OVH")
        except Exception as exc:
            background_core_ready.set()
            error_text = str(exc)
            if error_text == "PREPARE_SUPERSEDED":
                self.emit_diag(
                    trace_id,
                    "AGENT_PREPARE_CANCELLED",
                    {"reason": "replaced-by-newer-request"},
                    room_code=room_code,
                )
                self.ui(self.prepare_var.set, "Solicitud anterior cancelada")
                return

            self.emit_diag(
                trace_id,
                "AGENT_PREPARE_ERROR",
                {"error": error_text},
                level="error",
                room_code=room_code,
            )
            try:
                self.sio.emit(
                    "agent:prepare:error",
                    {
                        "traceId": trace_id,
                        "code": "AGENT_PREPARE_FAILED",
                        "error": error_text,
                    },
                )
            except Exception:
                pass
            self.ui(self.prepare_var.set, "Error preparando demo")

    def bind_socket_events(self) -> None:
        @self.sio.event
        def connect():
            self.connected = True
            self.ui(self.connection_var.set, "CONECTADO · registrando…")
            self.add_log("Conexión segura con OVH establecida.")
            self.register_agent()

        @self.sio.event
        def disconnect():
            self.connected = False
            self.registered = False
            self.ui(self.connection_var.set, "DESCONECTADO")
            self.add_log("Conexión con OVH cerrada.")

        @self.sio.on("connect_error")
        def connect_error(data):
            self.connected = False
            self.ui(self.connection_var.set, "ERROR DE CONEXIÓN")
            self.add_log(f"No se pudo conectar: {data}")

        @self.sio.on("agent:search")
        def on_search(payload):
            request_id = str((payload or {}).get("requestId", ""))
            query_text = str((payload or {}).get("query", "")).strip()
            limit = int((payload or {}).get("limit", 50) or 50)

            started = time.perf_counter()
            results, total = self.catalog.search(query_text, limit)
            elapsed_ms = int((time.perf_counter() - started) * 1000)

            self.add_log(
                f'Búsqueda remota "{query_text}" → {total} coincidencia(s) '
                f"({elapsed_ms} ms)."
            )
            self.sio.emit(
                "agent:search:result",
                {
                    "requestId": request_id,
                    "query": query_text,
                    "elapsedMs": elapsed_ms,
                    "totalMatches": total,
                    "results": results,
                },
            )

        @self.sio.on("agent:prepare")
        def on_prepare(payload):
            data = payload or {}
            trace_id = str(data.get("traceId") or "")
            self.latest_prepare_trace_id = trace_id
            self.cancelled_traces.discard(trace_id)

            def worker():
                with self.prepare_lock:
                    if self.is_cancelled(trace_id):
                        self.emit_diag(
                            trace_id,
                            "AGENT_PREPARE_CANCELLED",
                            {"reason": "stale-before-start"},
                            room_code=str(data.get("roomCode") or ""),
                        )
                        return
                    self.prepare_media(data)

            threading.Thread(target=worker, daemon=True).start()

        @self.sio.on("agent:background:prepare")
        def on_background_prepare(payload):
            data = payload or {}
            trace_id = str(data.get("traceId") or "")
            room_code = str(data.get("roomCode") or "")
            media = data.get("media") or {}
            duration = int(data.get("duration") or 120)
            upload_url = str(data.get("uploadUrl") or "")
            upload_token = str(data.get("uploadToken") or "")
            if not trace_id or not upload_url or not upload_token:
                self.emit_diag(
                    trace_id,
                    "YOUTUBE_BACKGROUND_LIVE_REQUEST_INVALID",
                    {"hasUploadUrl": bool(upload_url), "hasToken": bool(upload_token)},
                    level="warn",
                    room_code=room_code,
                )
                return

            def worker():
                # El mismo lock del prepare principal evita pelear por FFmpeg/CPU.
                with self.prepare_lock:
                    if self.is_cancelled(trace_id):
                        return
                    self.emit_diag(
                        trace_id,
                        "YOUTUBE_BACKGROUND_LIVE_REQUEST_START",
                        {"reason": str(data.get("reason") or "panel-live")},
                        room_code=room_code,
                    )
                    self.prepare_youtube_background(
                        dict(media),
                        duration,
                        upload_url,
                        upload_token,
                        trace_id,
                        room_code,
                        None,
                    )

            threading.Thread(target=worker, daemon=True).start()

        @self.sio.on("agent:prepare:cancel")
        def on_prepare_cancel(payload):
            data = payload or {}
            trace_id = str(data.get("traceId") or "")
            if trace_id:
                self.cancelled_traces.add(trace_id)
                self.emit_diag(
                    trace_id,
                    "AGENT_CANCEL_REQUEST_RECEIVED",
                    {"replacedByTraceId": str(data.get("replacedByTraceId") or "")},
                    room_code=str(data.get("roomCode") or ""),
                )

    def register_agent(self) -> None:
        if not self.connected:
            return

        payload = {
            "preferredCode": self.config.get("agentCode", ""),
            "name": f"{APP_NAME} · {socket.gethostname()}",
            "version": APP_VERSION,
            "summary": self.catalog.summary(),
            "capabilities": self.capabilities(),
        }

        def ack(response):
            if not isinstance(response, dict) or not response.get("ok"):
                self.ui(self.connection_var.set, "ERROR REGISTRO")
                self.add_log(f"Registro rechazado: {response}")
                return

            agent = response.get("agent") or {}
            code = str(agent.get("code", "")).upper()
            if code:
                self.registered = True
                self.config["agentCode"] = code
                self.ui(self.code_var.set, code)
                self.ui(self.connection_var.set, "ONLINE")
                self.save_config()
                self.add_log(
                    f"Agent ONLINE. Código de vinculación: {code}. "
                    "Escríbelo en demodj.kitkaraoke.com."
                )

        self.sio.emit("agent:register", payload, callback=ack)

    def send_heartbeat(self) -> None:
        if not self.connected or not self.registered:
            return
        try:
            self.sio.emit(
                "agent:heartbeat",
                {
                    "summary": self.catalog.summary(),
                    "capabilities": self.capabilities(),
                },
            )
        except Exception:
            pass

    def heartbeat_loop(self) -> None:
        while not self.stop_event.wait(20):
            self.send_heartbeat()

    def connect_async(self) -> None:
        if self.connected:
            return
        threading.Thread(target=self.connect_worker, daemon=True).start()

        if not getattr(self, "_heartbeat_started", False):
            self._heartbeat_started = True
            threading.Thread(target=self.heartbeat_loop, daemon=True).start()

    def connect_worker(self) -> None:
        server_url = self.server_var.get().strip() or DEFAULT_SERVER
        self.config["server"] = server_url
        self.save_config()
        self.ui(self.connection_var.set, "CONECTANDO…")
        self.add_log(f"Conectando a {server_url}")

        try:
            if self.sio.connected:
                return
            self.sio.connect(
                server_url,
                wait=True,
                wait_timeout=20,
            )
        except Exception as exc:
            self.ui(self.connection_var.set, "DESCONECTADO")
            self.add_log(f"Conexión fallida: {exc}")

    def reconnect(self) -> None:
        def worker():
            try:
                if self.sio.connected:
                    self.sio.disconnect()
            except Exception:
                pass
            time.sleep(0.5)
            self.connect_worker()

        threading.Thread(target=worker, daemon=True).start()

    def on_close(self) -> None:
        self.stop_event.set()
        try:
            self.save_config()
        except Exception:
            pass
        try:
            if self.sio.connected:
                self.sio.disconnect()
        except Exception:
            pass
        self.root.destroy()


def main() -> None:
    root = tk.Tk()
    AgentApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
