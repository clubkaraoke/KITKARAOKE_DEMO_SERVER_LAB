from __future__ import annotations

import hashlib
import json
import os
import queue
import shutil
import socket
import subprocess
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
APP_VERSION = "0.4.0"
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
        else:
            self.add_log("ERROR: no se encontró FFmpeg.")

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

    def capabilities(self) -> dict:
        return {
            "prepareMedia": bool(self.ffmpeg_path),
            "ffmpeg": bool(self.ffmpeg_path),
            "cdgAacDemo": bool(self.ffmpeg_path),
            "mp4H264Demo": bool(self.ffmpeg_path),
            "videoQualities": ["auto", "360", "540", "720"],
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
                "CDG: recorte + audio AAC 160 kbps. "
                "MP4: H.264/AAC 720p con faststart. "
                "La TV precarga el demo completo antes de PLAY."
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
                "videoQuality": str(media.get("videoQuality") or "auto") if item["format"] != "CDG" else None,
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
                "-b:a", "160k",
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
                "bitrate": "160k",
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
        video_quality: str = "auto",
    ) -> dict[str, Path]:
        source = Path(item["_path"])
        if not source.exists():
            raise FileNotFoundError("El video ya no existe en la carpeta autorizada")

        requested = str(video_quality or "auto").strip().lower()
        profiles = {
            "360": {"height": 360, "crf": "24", "video_bitrate": "750k", "maxrate": "900k", "bufsize": "1800k", "audio_bitrate": "128k"},
            "540": {"height": 540, "crf": "23", "video_bitrate": "1500k", "maxrate": "1800k", "bufsize": "3600k", "audio_bitrate": "160k"},
            "720": {"height": 720, "crf": "22", "video_bitrate": "2800k", "maxrate": "3500k", "bufsize": "7000k", "audio_bitrate": "160k"},
            "auto": {"height": 720, "crf": "23", "video_bitrate": None, "maxrate": None, "bufsize": None, "audio_bitrate": "160k"},
        }
        if requested not in profiles:
            requested = "auto"
        profile = profiles[requested]

        video_out = workdir / "demo.mp4"
        args = [
            "-i", str(source),
            "-t", str(duration),
            "-vf", f"scale=-2:{profile['height']}:force_original_aspect_ratio=decrease",
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", profile["crf"],
            "-pix_fmt", "yuv420p",
        ]
        if profile["video_bitrate"]:
            args += [
                "-b:v", profile["video_bitrate"],
                "-maxrate", profile["maxrate"],
                "-bufsize", profile["bufsize"],
            ]
        args += [
            "-c:a", "aac",
            "-b:a", profile["audio_bitrate"],
            "-movflags", "+faststart",
            str(video_out),
        ]

        started = time.perf_counter()
        self.run_ffmpeg(args, trace_id=trace_id)
        self.emit_diag(
            trace_id,
            "AGENT_MP4_TRANSCODE_READY",
            {
                "videoCodec": "H264",
                "audioCodec": "AAC",
                "videoQuality": requested,
                "targetHeight": profile["height"],
                "crf": int(profile["crf"]),
                "videoBitrate": profile["video_bitrate"] or "CRF_AUTO",
                "audioBitrate": profile["audio_bitrate"],
                "faststart": True,
                "bytes": video_out.stat().st_size,
                "elapsedMs": int((time.perf_counter() - started) * 1000),
            },
            room_code=room_code,
        )
        return {"video": video_out}

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
        duration = int(payload.get("duration") or 45)
        uploads = payload.get("uploads") or {}
        upload_token = str(payload.get("uploadToken") or "")
        total_started = time.perf_counter()

        if duration not in (30, 45, 60):
            duration = 45

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
                    "videoQuality": str(media.get("videoQuality") or "auto"),
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
                        str(media.get("videoQuality") or "auto"),
                    )

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
