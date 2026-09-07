from __future__ import annotations

import hashlib
import json
import os
import queue
import socket
import threading
import time
import unicodedata
from pathlib import Path
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

import socketio

APP_NAME = "KITKARAOKE Agent"
APP_VERSION = "0.2.0"
DEFAULT_SERVER = "https://demodj.kitkaraoke.com"

VIDEO_EXTS = {".mp4", ".mkv", ".webm", ".mov", ".avi"}
AUDIO_EXTS = [".wav", ".mp3", ".m4a", ".flac"]
CDG_EXT = ".cdg"


def app_data_dir() -> Path:
    base = os.environ.get("APPDATA")
    if base:
        root = Path(base)
    else:
        root = Path.home() / ".config"
    path = root / "KITKARAOKE Agent"
    path.mkdir(parents=True, exist_ok=True)
    return path


CONFIG_PATH = app_data_dir() / "config.json"


def normalize_text(value: str) -> str:
    raw = unicodedata.normalize("NFD", value or "")
    raw = "".join(ch for ch in raw if unicodedata.category(ch) != "Mn")
    chars = []
    for ch in raw.lower():
        chars.append(ch if ch.isalnum() else " ")
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
            self._summary = summary

    def summary(self) -> dict:
        with self._lock:
            return dict(self._summary)

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
        self.root.geometry("780x620")
        self.root.minsize(720, 560)

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

        self.server_var = tk.StringVar(value=self.config.get("server", DEFAULT_SERVER))
        self.folder_var = tk.StringVar(value=self.config.get("folder", ""))
        self.code_var = tk.StringVar(value=self.config.get("agentCode", "------"))
        self.connection_var = tk.StringVar(value="DESCONECTADO")
        self.scan_var = tk.StringVar(value="Sin índice")
        self.counts_var = tk.StringVar(value="0 canciones · 0 video · 0 CDG+audio")

        self.build_ui()
        self.bind_socket_events()

        self.root.protocol("WM_DELETE_WINDOW", self.on_close)
        self.root.after(150, self.flush_logs)

        if self.folder_var.get():
            self.start_scan(auto=True)

        self.root.after(600, self.connect_async)

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
            text="Servidor local seguro para el DEMO SERVER LAB",
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

        privacy = ttk.LabelFrame(outer, text="Protección", padding=12)
        privacy.pack(fill="x", pady=(14, 0))
        ttk.Label(
            privacy,
            text=(
                "Solo se indexa la carpeta elegida. Las rutas completas de Windows "
                "NO se envían a OVH. El panel recibe únicamente ID, artista, título "
                "y formato. Esta versión todavía no transmite archivos."
            ),
            wraplength=710,
            justify="left",
        ).pack(anchor="w")

        logs = ttk.LabelFrame(outer, text="Logs", padding=8)
        logs.pack(fill="both", expand=True, pady=(14, 0))
        self.log_text = tk.Text(
            logs,
            height=14,
            wrap="word",
            font=("Consolas", 9),
            state="disabled",
        )
        self.log_text.pack(fill="both", expand=True)

    def ui(self, fn, *args) -> None:
        self.root.after(0, lambda: fn(*args))

    def add_log(self, message: str) -> None:
        stamp = time.strftime("%H:%M:%S")
        self.log_queue.put(f"[{stamp}] {message}")

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

        thread = threading.Thread(
            target=self.scan_folder,
            args=(Path(folder),),
            daemon=True,
        )
        thread.start()

    def scan_folder(self, root_path: Path) -> None:
        if not root_path.exists() or not root_path.is_dir():
            self.ui(self.scan_var.set, "La carpeta ya no existe")
            self.add_log(f"Carpeta no disponible: {root_path}")
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
                    path = base_path / name
                    ext = path.suffix.lower()
                    if ext in VIDEO_EXTS or ext == CDG_EXT or ext in AUDIO_EXTS:
                        all_files.append(path)
                        files_seen += 1

            by_parent_stem: dict[tuple[str, str], dict[str, Path]] = {}
            for path in all_files:
                key = (str(path.parent).lower(), path.stem.lower())
                by_parent_stem.setdefault(key, {})[path.suffix.lower()] = path

            for path in all_files:
                ext = path.suffix.lower()

                if ext in VIDEO_EXTS:
                    artist, title = parse_artist_title(path.stem)
                    key = normalize_text(f"{artist} {title} {path.stem}")
                    items.append(
                        {
                            "id": stable_id(path),
                            "artist": artist,
                            "title": title,
                            "format": "MP4" if ext == ".mp4" else ext[1:].upper(),
                            "audio": "",
                            "_path": str(path),
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
                    (str(path.parent).lower(), path.stem.lower()), {}
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

                artist, title = parse_artist_title(path.stem)
                key = normalize_text(f"{artist} {title} {path.stem}")
                items.append(
                    {
                        "id": stable_id(path),
                        "artist": artist,
                        "title": title,
                        "format": "CDG",
                        "audio": audio_ext,
                        "_path": str(path),
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

    def register_agent(self) -> None:
        if not self.connected:
            return

        payload = {
            "preferredCode": self.config.get("agentCode", ""),
            "name": f"{APP_NAME} · {socket.gethostname()}",
            "version": APP_VERSION,
            "summary": self.catalog.summary(),
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
                {"summary": self.catalog.summary()},
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
