"use strict";

const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const path = require("path");
const { pipeline } = require("stream/promises");
const express = require("express");
const helmet = require("helmet");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT || 3000);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MINUTES || 120) * 60 * 1000;
const MEDIA_TTL_MS = Number(process.env.MEDIA_TTL_MINUTES || 20) * 60 * 1000;
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(__dirname, "..", ".media-cache");
const DIAG_DIR = process.env.DIAG_DIR || path.join(__dirname, "..", ".diagnostics");
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB || 80) * 1024 * 1024;
const SEARCH_TTL_MS = 30 * 1000;
const DIAG_LIMIT = 1500;
const TV_CLIENT_VERSION = "LAB-TV-4.7";
const AGENT_MIN_VERSION = "0.9.0";
const PUBLIC_ORIGIN = String(process.env.PUBLIC_ORIGIN || "https://demodj.kitkaraoke.com").replace(/\/$/, "");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ["websocket", "polling"],
  maxHttpBufferSize: 2 * 1024 * 1024
});

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "..", "public"), {
  etag: false,
  maxAge: 0,
  setHeaders(res, filePath) {
    if (/\.(?:html|js|css)$/i.test(filePath)) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
  }
}));

const rooms = new Map();
const agents = new Map();
const pendingSearches = new Map();
const mediaJobs = new Map();
const roomDiagnostics = new Map();

fs.mkdirSync(MEDIA_DIR, { recursive: true });
fs.mkdirSync(DIAG_DIR, { recursive: true });

function nowIso() {
  return new Date().toISOString();
}

function safeObject(value, depth = 0) {
  if (depth > 5) return "[depth-limit]";
  if (typeof value === "string") {
    return value
      .replace(/([?&]token=)[^&\\s"]+/gi, "$1[redacted]")
      .replace(/(bearer\\s+)[a-z0-9._~+\\/-]+/gi, "$1[redacted]");
  }
  if (Array.isArray(value)) return value.slice(0, 80).map((v) => safeObject(v, depth + 1));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (lower.includes("token") || lower.includes("password") || lower.includes("secret")) {
      out[key] = "[redacted]";
      continue;
    }
    if (lower === "path" || lower.endsWith("path") || lower.includes("filepath")) {
      out[key] = "[local-path-hidden]";
      continue;
    }
    out[key] = safeObject(item, depth + 1);
  }
  return out;
}

function log(event, data = {}) {
  process.stdout.write(JSON.stringify({ ts: nowIso(), event, ...safeObject(data) }) + "\n");
}

function diag(roomCode, source, event, data = {}, traceId = null, level = "info") {
  if (!roomCode) return null;
  const entry = {
    ts: nowIso(),
    epochMs: Date.now(),
    roomCode,
    traceId: traceId || null,
    source,
    level,
    event,
    data: safeObject(data)
  };
  const list = roomDiagnostics.get(roomCode) || [];
  list.push(entry);
  if (list.length > DIAG_LIMIT) list.splice(0, list.length - DIAG_LIMIT);
  roomDiagnostics.set(roomCode, list);

  const dayDir = path.join(DIAG_DIR, entry.ts.slice(0, 10));
  const diskEntry = JSON.stringify(entry) + "\n";
  fsp.mkdir(dayDir, { recursive: true })
    .then(() => fsp.appendFile(path.join(dayDir, roomCode + ".jsonl"), diskEntry, "utf8"))
    .catch((error) => log("diag_persist_error", {
      roomCode,
      error: String(error && error.message ? error.message : error)
    }));

  const room = rooms.get(roomCode);
  if (room && room.djSocketId) io.to(room.djSocketId).emit("diagnostic:event", entry);
  log("diag", entry);
  return entry;
}

function normalizeCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
}

function makeCode(store) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = "";
    for (let i = 0; i < 6; i += 1) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
  } while (store.has(code));
  return code;
}

function newRoom(code, djSocketId) {
  const now = Date.now();
  const room = {
    code,
    createdAt: now,
    lastActivity: now,
    djSocketId,
    tvSocketIds: new Set(),
    readyTvSocketIds: new Set(),
    agentCode: null,
    activeTraceId: null,
    settings: {
      cdgQuality: "original",
      cdgBackground: "black",
      cdgTransparencyMode: "auto",
      backgroundQuality: "normal",
      videoQuality: "original",
      youtubeBlur: 14,
      youtubeShade: 55
    },
    playback: {
      state: "idle",
      media: null,
      position: 0,
      traceId: null
    }
  };
  rooms.set(code, room);
  return room;
}

function publicAgentState(code) {
  if (!code) return null;
  const agent = agents.get(code);
  if (!agent) return { code, online: false };
  return {
    code,
    online: true,
    name: agent.name,
    version: agent.version,
    summary: agent.summary || null,
    capabilities: agent.capabilities || null,
    connectedAt: agent.connectedAt,
    lastSeen: agent.lastSeen
  };
}

function publicRoomState(room) {
  return {
    code: room.code,
    createdAt: room.createdAt,
    lastActivity: room.lastActivity,
    tvCount: room.tvSocketIds.size,
    tvReadyCount: room.readyTvSocketIds.size,
    hasDj: Boolean(room.djSocketId),
    agent: publicAgentState(room.agentCode),
    activeTraceId: room.activeTraceId || null,
    settings: room.settings,
    playback: room.playback
  };
}

function touch(room) {
  room.lastActivity = Date.now();
}

function emitRoomState(room) {
  io.to(room.code).emit("room:state", publicRoomState(room));
}

function safeSummary(value) {
  const src = value && typeof value === "object" ? value : {};
  return {
    files: Math.max(0, Number(src.files || 0)),
    songs: Math.max(0, Number(src.songs || 0)),
    video: Math.max(0, Number(src.video || 0)),
    cdg: Math.max(0, Number(src.cdg || 0)),
    cdgWithAudio: Math.max(0, Number(src.cdgWithAudio || 0))
  };
}

function sanitizeResults(results) {
  if (!Array.isArray(results)) return [];
  return results.slice(0, 80).map((item) => ({
    id: String(item.id || "").slice(0, 64),
    title: String(item.title || "").slice(0, 220),
    artist: String(item.artist || "").slice(0, 160),
    format: String(item.format || "").slice(0, 32),
    audio: String(item.audio || "").slice(0, 16),
    duration: Number.isFinite(Number(item.duration)) ? Math.max(0, Number(item.duration)) : null
  }));
}

function expectedKinds(format) {
  return String(format || "").toUpperCase() === "CDG"
    ? ["cdg", "audio"]
    : ["video"];
}

function normalizeCdgQuality(value) {
  const mode = String(value || "").trim().toLowerCase();
  const allowed = new Set(["original", "sdf-lab-v2", "sdf-karaoke-pro"]);
  return allowed.has(mode) ? mode : "original";
}

function normalizeCdgBackground(value) {
  const mode = String(value || "").trim().toLowerCase();
  const allowed = new Set(["black", "waves", "glow", "gradient", "particles", "youtube-auto"]);
  return allowed.has(mode) ? mode : "black";
}

function normalizeCdgTransparencyMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  const allowed = new Set(["auto", "original", "force"]);
  return allowed.has(mode) ? mode : "auto";
}

function normalizeBackgroundQuality(value) {
  const mode = String(value || "").trim().toLowerCase();
  const allowed = new Set(["light", "normal", "premium"]);
  return allowed.has(mode) ? mode : "normal";
}

function normalizeVideoQuality(_value) {
  return "original";
}

function normalizeYoutubeBlur(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 14;
  return Math.max(0, Math.min(30, Math.round(n)));
}

function normalizeYoutubeShade(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 55;
  return Math.max(0, Math.min(85, Math.round(n)));
}

function safeYoutubeBackgroundMeta(value) {
  const src = value && typeof value === "object" ? value : {};
  return {
    youtubeId: String(src.youtubeId || "").slice(0, 24),
    title: String(src.title || "").slice(0, 240),
    channel: String(src.channel || "").slice(0, 180),
    viewCount: Number.isFinite(Number(src.viewCount)) ? Math.max(0, Number(src.viewCount)) : null,
    official: Boolean(src.official),
    officialConfidence: String(src.officialConfidence || "").slice(0, 40),
    selectionReason: String(src.selectionReason || "").slice(0, 80),
    sourceWidth: Number.isFinite(Number(src.sourceWidth)) ? Math.max(0, Number(src.sourceWidth)) : null,
    sourceHeight: Number.isFinite(Number(src.sourceHeight)) ? Math.max(0, Number(src.sourceHeight)) : null,
    outputWidth: Number.isFinite(Number(src.outputWidth)) ? Math.max(0, Number(src.outputWidth)) : null,
    outputHeight: Number.isFinite(Number(src.outputHeight)) ? Math.max(0, Number(src.outputHeight)) : null,
    outputFps: Number.isFinite(Number(src.outputFps)) ? Math.max(0, Number(src.outputFps)) : null,
    sourceCodec: String(src.sourceCodec || "").slice(0, 80),
    resolverMode: String(src.resolverMode || "").slice(0, 40),
    prepareMode: String(src.prepareMode || "").slice(0, 40),
    backgroundQuality: String(src.backgroundQuality || "").slice(0, 20),
    targetHeight: Number.isFinite(Number(src.targetHeight)) ? Math.max(0, Number(src.targetHeight)) : null,
    bytes: Number.isFinite(Number(src.bytes)) ? Math.max(0, Number(src.bytes)) : null,
    elapsedMs: Number.isFinite(Number(src.elapsedMs)) ? Math.max(0, Number(src.elapsedMs)) : null
  };
}


function mediaExtension(kind) {
  if (kind === "cdg") return ".cdg";
  if (kind === "audio") return ".m4a";
  if (kind === "background") return ".mp4";
  return ".mp4";
}

function mediaMime(kind) {
  if (kind === "cdg") return "application/octet-stream";
  if (kind === "audio") return "audio/mp4";
  if (kind === "background") return "video/mp4";
  return "video/mp4";
}

function createMediaJob(room, media, duration) {
  const traceId = crypto.randomUUID();
  const uploadToken = crypto.randomBytes(32).toString("hex");
  const mediaToken = crypto.randomBytes(24).toString("hex");
  const kinds = expectedKinds(media.format);
  const createdAt = Date.now();
  const job = {
    traceId,
    roomCode: room.code,
    agentCode: room.agentCode,
    media: {
      id: String(media.id || "").slice(0, 64),
      title: String(media.title || "").slice(0, 240),
      format: String(media.format || "").toUpperCase(),
      audio: String(media.audio || "").toUpperCase(),
      cdgQuality: normalizeCdgQuality(media.cdgQuality || room.settings.cdgQuality),
      cdgBackground: normalizeCdgBackground(media.cdgBackground || room.settings.cdgBackground),
      cdgTransparencyMode: normalizeCdgTransparencyMode(media.cdgTransparencyMode || room.settings.cdgTransparencyMode),
      backgroundQuality: normalizeBackgroundQuality(media.backgroundQuality || room.settings.backgroundQuality),
      videoQuality: String(media.format || "").toUpperCase() === "CDG"
        ? null
        : normalizeVideoQuality(media.videoQuality || room.settings.videoQuality),
      artist: String(media.artist || "").slice(0, 160),
      songTitle: String(media.songTitle || "").slice(0, 220),
      youtubeBlur: normalizeYoutubeBlur(media.youtubeBlur ?? room.settings.youtubeBlur),
      youtubeShade: normalizeYoutubeShade(media.youtubeShade ?? room.settings.youtubeShade),
      youtubeBackground: String(media.format || "").toUpperCase() === "CDG" &&
        normalizeCdgBackground(media.cdgBackground || room.settings.cdgBackground) === "youtube-auto",
      source: "KITKARAOKE_AGENT"
    },
    duration: [30, 45, 60, 120].includes(Number(duration)) ? Number(duration) : 120,
    expected: kinds,
    // El fondo YouTube siempre es una pieza opcional para CDG. Así puede
    // activarse en vivo después de preparar el karaoke sin rehacer CDG/audio.
    optional: String(media.format || "").toUpperCase() === "CDG" ? ["background"] : [],
    backgroundMeta: null,
    backgroundState: String(media.format || "").toUpperCase() === "CDG" &&
      normalizeCdgBackground(media.cdgBackground || room.settings.cdgBackground) === "youtube-auto"
      ? "preparing"
      : "idle",
    backgroundLastAttemptAt: 0,
    origin: PUBLIC_ORIGIN,
    files: {},
    uploadToken,
    mediaToken,
    createdAt,
    updatedAt: createdAt,
    expiresAt: createdAt + MEDIA_TTL_MS,
    status: "preparing"
  };
  mediaJobs.set(traceId, job);
  return job;
}

function uploadUrl(traceId, kind) {
  return "/api/upload/" + encodeURIComponent(traceId) + "/" + encodeURIComponent(kind);
}

function playbackUrl(job, kind) {
  return "/media/" + encodeURIComponent(job.traceId) + "/" + encodeURIComponent(kind) +
    "?token=" + encodeURIComponent(job.mediaToken);
}

function allPartsReady(job) {
  return job.expected.every((kind) => job.files[kind] && job.files[kind].size > 0);
}

async function deleteJobFiles(job) {
  for (const item of Object.values(job.files || {})) {
    if (!item || !item.file) continue;
    await fsp.unlink(item.file).catch(() => {});
  }
  await fsp.rm(path.join(MEDIA_DIR, job.traceId), { recursive: true, force: true }).catch(() => {});
}

function sendPreparedMedia(job) {
  const room = rooms.get(job.roomCode);
  if (!room) return false;

  const media = {
    ...job.media,
    traceId: job.traceId,
    duration: job.duration,
    transport: "OVH_TEMP_CACHE",
    preloadPolicy: "FULL_BEFORE_PLAY",
    urls: job.media.format === "CDG"
      ? {
          cdg: playbackUrl(job, "cdg"),
          audio: playbackUrl(job, "audio"),
          ...(job.files.background ? { background: playbackUrl(job, "background") } : {})
        }
      : { video: playbackUrl(job, "video") },
    youtubeBackgroundMeta: job.backgroundMeta || null
  };

  room.readyTvSocketIds.clear();
  room.playback = {
    state: "preloading",
    media,
    position: 0,
    traceId: job.traceId
  };
  touch(room);

  const event = {
    command: "LOAD",
    media,
    sentAt: Date.now(),
    traceId: job.traceId
  };
  io.to(room.code).emit("player:command", event);
  emitRoomState(room);

  diag(room.code, "OVH", "TV_LOAD_SENT", {
    mediaId: media.id,
    title: media.title,
    format: media.format,
    cdgQuality: media.cdgQuality || null,
    cdgBackground: media.cdgBackground || null,
    cdgTransparencyMode: media.cdgTransparencyMode || null,
    backgroundQuality: media.backgroundQuality || null,
    videoQuality: media.videoQuality || null,
    youtubeBackground: Boolean(media.youtubeBackground),
    youtubeBlur: media.youtubeBlur,
    youtubeShade: media.youtubeShade,
    youtubeBackgroundReady: Boolean(media.urls?.background),
    youtubeBackgroundMeta: media.youtubeBackgroundMeta || null,
    transportMode: "HTTP_PRELOAD",
    duration: media.duration,
    tvCount: room.tvSocketIds.size,
    preloadPolicy: media.preloadPolicy
  }, job.traceId);

  return true;
}

function requestYoutubeBackground(job, room, reason = "panel-live") {
  if (!job || !room || job.media.format !== "CDG") return false;
  if (job.files.background || job.backgroundState === "ready" || job.backgroundState === "uploaded") {
    return false;
  }
  if (job.backgroundState === "requested" || job.backgroundState === "preparing") {
    return false;
  }
  const agent = job.agentCode ? agents.get(job.agentCode) : null;
  if (!agent) {
    job.backgroundState = "failed";
    diag(job.roomCode, "OVH", "YOUTUBE_BACKGROUND_REQUEST_SKIPPED", {
      reason: "AGENT_OFFLINE",
      requestedBy: reason
    }, job.traceId, "warn");
    return false;
  }

  if (!job.optional.includes("background")) job.optional.push("background");
  job.media.youtubeBackground = true;
  job.media.cdgBackground = "youtube-auto";
  job.backgroundState = "requested";
  job.backgroundLastAttemptAt = Date.now();
  const origin = job.origin || PUBLIC_ORIGIN;

  io.to(agent.socketId).emit("agent:background:prepare", {
    traceId: job.traceId,
    roomCode: job.roomCode,
    media: job.media,
    duration: job.duration,
    uploadToken: job.uploadToken,
    uploadUrl: origin + uploadUrl(job.traceId, "background"),
    reason
  });
  diag(job.roomCode, "OVH", "YOUTUBE_BACKGROUND_LIVE_REQUEST_SENT", {
    requestedBy: reason,
    agentCode: job.agentCode,
    jobStatus: job.status,
    nonBlocking: true
  }, job.traceId);
  return true;
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "kitkaraoke-demo-server-lab",
    phase: 4,
    rooms: rooms.size,
    agentsOnline: agents.size,
    mediaJobs: mediaJobs.size,
    uptimeSeconds: Math.floor(process.uptime())
  });
});

app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    phase: 4,
    rooms: Array.from(rooms.values()).map(publicRoomState),
    agentsOnline: Array.from(agents.values()).map((agent) => ({
      code: agent.code,
      name: agent.name,
      version: agent.version,
      summary: agent.summary,
      capabilities: agent.capabilities,
      connectedAt: agent.connectedAt,
      lastSeen: agent.lastSeen
    })),
    mediaJobs: Array.from(mediaJobs.values()).map((job) => ({
      traceId: job.traceId,
      roomCode: job.roomCode,
      status: job.status,
      media: job.media,
      duration: job.duration,
      expected: job.expected,
      optional: job.optional || [],
      backgroundMeta: job.backgroundMeta || null,
      backgroundState: job.backgroundState || "idle",
      files: Object.fromEntries(Object.entries(job.files).map(([k, v]) => [k, { size: v.size }])),
      createdAt: job.createdAt,
      expiresAt: job.expiresAt
    }))
  });
});

app.put("/api/upload/:traceId/:kind", async (req, res) => {
  const traceId = String(req.params.traceId || "");
  const kind = String(req.params.kind || "").toLowerCase();
  const job = mediaJobs.get(traceId);
  const supplied = String(req.get("x-upload-token") || "");

  const allowedKinds = job ? [...job.expected, ...(job.optional || [])] : [];
  if (!job || !allowedKinds.includes(kind)) return res.status(404).json({ ok: false, error: "UPLOAD_NOT_FOUND" });
  if (!supplied || supplied !== job.uploadToken) return res.status(401).json({ ok: false, error: "UPLOAD_TOKEN_INVALID" });

  const declared = Number(req.get("content-length") || 0);
  if (declared > MAX_UPLOAD_BYTES) return res.status(413).json({ ok: false, error: "UPLOAD_TOO_LARGE" });

  const dir = path.join(MEDIA_DIR, traceId);
  await fsp.mkdir(dir, { recursive: true });
  const finalPath = path.join(dir, kind + mediaExtension(kind));
  const tempPath = finalPath + ".part";
  await fsp.unlink(tempPath).catch(() => {});

  const started = Date.now();
  diag(job.roomCode, "OVH", "OVH_UPLOAD_START", {
    kind,
    declaredBytes: declared || null
  }, traceId);

  try {
    await pipeline(req, fs.createWriteStream(tempPath, { flags: "w" }));
    const stat = await fsp.stat(tempPath);
    if (stat.size > MAX_UPLOAD_BYTES) {
      await fsp.unlink(tempPath).catch(() => {});
      return res.status(413).json({ ok: false, error: "UPLOAD_TOO_LARGE" });
    }
    await fsp.rename(tempPath, finalPath);
    job.files[kind] = { file: finalPath, size: stat.size, receivedAt: Date.now() };
    job.updatedAt = Date.now();
    job.expiresAt = Date.now() + MEDIA_TTL_MS;

    diag(job.roomCode, "OVH", "OVH_UPLOAD_COMPLETE", {
      kind,
      bytes: stat.size,
      elapsedMs: Date.now() - started,
      megabytes: Number((stat.size / 1024 / 1024).toFixed(3))
    }, traceId);

    if (kind === "background") {
      job.backgroundState = "uploaded";
      const room = rooms.get(job.roomCode);
      if (room && room.playback.traceId === traceId && room.playback.media) {
        // Solo registramos el archivo aquí. La orden player:background se envía
        // una sola vez cuando llega agent:background:complete con metadata final.
        room.playback.media.urls = {
          ...(room.playback.media.urls || {}),
          background: playbackUrl(job, "background")
        };
        diag(job.roomCode, "OVH", "YOUTUBE_BACKGROUND_UPLOAD_STORED", {
          bytes: stat.size,
          awaitingAgentComplete: true
        }, traceId);
      }
    }

    res.json({ ok: true, traceId, kind, bytes: stat.size });
  } catch (error) {
    await fsp.unlink(tempPath).catch(() => {});
    diag(job.roomCode, "OVH", "OVH_UPLOAD_ERROR", {
      kind,
      error: String(error && error.message ? error.message : error)
    }, traceId, "error");
    res.status(500).json({ ok: false, error: "UPLOAD_FAILED" });
  }
});

app.get("/media/:traceId/:kind", async (req, res) => {
  const traceId = String(req.params.traceId || "");
  const kind = String(req.params.kind || "").toLowerCase();
  const job = mediaJobs.get(traceId);

  if (!job || !job.files[kind]) return res.status(404).end();
  if (String(req.query.token || "") !== job.mediaToken) return res.status(401).end();

  const item = job.files[kind];
  let stat;
  try {
    stat = await fsp.stat(item.file);
  } catch {
    return res.status(404).end();
  }

  job.expiresAt = Date.now() + MEDIA_TTL_MS;
  res.setHeader("Content-Type", mediaMime(kind));
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "private, max-age=900");
  res.setHeader("X-KITKARAOKE-Trace", traceId);

  const range = String(req.headers.range || "");
  if (!range) {
    res.setHeader("Content-Length", stat.size);
    return fs.createReadStream(item.file).pipe(res);
  }

  const match = /^bytes=(\d*)-(\d*)$/i.exec(range);
  if (!match) return res.status(416).end();

  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= stat.size) {
    res.setHeader("Content-Range", "bytes */" + stat.size);
    return res.status(416).end();
  }

  res.status(206);
  res.setHeader("Content-Range", "bytes " + start + "-" + end + "/" + stat.size);
  res.setHeader("Content-Length", end - start + 1);
  return fs.createReadStream(item.file, { start, end }).pipe(res);
});

function sendNoStoreHtml(res, file) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.sendFile(path.join(__dirname, "..", "public", file));
}

app.get("/api/client-version", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    tv: TV_CLIENT_VERSION,
    agent: AGENT_MIN_VERSION,
    phase: 4
  });
});

app.get("/dj", (_req, res) => sendNoStoreHtml(res, "dj.html"));

app.get("/tv", (_req, res) => sendNoStoreHtml(res, "tv.html"));

app.get("/", (req, res) => {
  const host = String(req.hostname || "").toLowerCase();
  const file = host.startsWith("demotv.") ? "tv.html" : "dj.html";
  sendNoStoreHtml(res, file);
});

io.on("connection", (socket) => {
  socket.data.role = null;
  socket.data.roomCode = null;
  socket.data.agentCode = null;
  log("socket_connected", { socketId: socket.id });

  socket.on("room:create", (_payload, ack = () => {}) => {
    if (socket.data.roomCode) return ack({ ok: false, error: "SOCKET_ALREADY_IN_ROOM" });
    const code = makeCode(rooms);
    const room = newRoom(code, socket.id);
    socket.data.role = "dj";
    socket.data.roomCode = code;
    socket.join(code);
    diag(code, "DJ", "ROOM_CREATED", { djSocketId: socket.id });
    emitRoomState(room);
    ack({ ok: true, room: publicRoomState(room) });
  });

  socket.on("room:join", (payload = {}, ack = () => {}) => {
    const code = normalizeCode(payload.roomCode);
    const role = payload.role === "dj" ? "dj" : "tv";
    const room = rooms.get(code);
    if (!room) return ack({ ok: false, error: "ROOM_NOT_FOUND" });
    if (role === "dj" && room.djSocketId && room.djSocketId !== socket.id) {
      return ack({ ok: false, error: "DJ_ALREADY_CONNECTED" });
    }

    socket.data.role = role;
    socket.data.roomCode = code;
    socket.join(code);
    if (role === "dj") room.djSocketId = socket.id;
    else room.tvSocketIds.add(socket.id);
    touch(room);

    const clientVersion = String(payload.clientVersion || "").slice(0, 40);
    diag(code, role.toUpperCase(), "ROOM_JOINED", {
      socketId: socket.id,
      tvCount: room.tvSocketIds.size,
      transportMode: String(payload.transportMode || "SOCKET_IO").slice(0, 40),
      reconnect: Boolean(payload.reconnect),
      clientVersion
    }, room.playback.traceId);

    if (role === "tv" && clientVersion && clientVersion !== TV_CLIENT_VERSION) {
      diag(code, "TV", "TV_CLIENT_STALE", {
        socketId: socket.id,
        clientVersion,
        expectedVersion: TV_CLIENT_VERSION,
        cachePolicy: "NO_STORE"
      }, room.playback.traceId, "warn");
    }

    emitRoomState(room);
    ack({ ok: true, room: publicRoomState(room) });

    if (role === "tv" && room.playback.media && room.playback.media.urls) {
      const reconnectPreservesMedia = Boolean(
        payload.reconnect &&
        payload.mediaReady &&
        payload.currentTraceId &&
        String(payload.currentTraceId) === String(room.playback.traceId || "")
      );

      if (reconnectPreservesMedia) {
        room.readyTvSocketIds.add(socket.id);
        diag(code, "TV", "TV_REJOIN_MEDIA_PRESERVED", {
          socketId: socket.id,
          traceId: room.playback.traceId,
          state: room.playback.state,
          transportMode: String(payload.transportMode || "HTTP_PRELOAD").slice(0, 40)
        }, room.playback.traceId);
        emitRoomState(room);
      } else {
        socket.emit("player:command", {
          command: "LOAD",
          media: room.playback.media,
          traceId: room.playback.traceId,
          sentAt: Date.now()
        });
      }
    }
  });

  socket.on("agent:register", (payload = {}, ack = () => {}) => {
    if (socket.data.roomCode) return ack({ ok: false, error: "ROOM_SOCKET_CANNOT_REGISTER_AGENT" });

    const preferred = normalizeCode(payload.preferredCode);
    let code = preferred;
    if (!code || (agents.has(code) && agents.get(code).socketId !== socket.id)) code = makeCode(agents);
    if (socket.data.agentCode && socket.data.agentCode !== code) agents.delete(socket.data.agentCode);

    const now = Date.now();
    const agent = {
      code,
      socketId: socket.id,
      name: String(payload.name || "KITKARAOKE Agent").slice(0, 80),
      version: String(payload.version || "0.1.0").slice(0, 32),
      summary: safeSummary(payload.summary),
      capabilities: safeObject(payload.capabilities || {}),
      connectedAt: now,
      lastSeen: now
    };

    agents.set(code, agent);
    socket.data.role = "agent";
    socket.data.agentCode = code;
    socket.join("agent:" + code);

    for (const room of rooms.values()) {
      if (room.agentCode === code) {
        diag(room.code, "AGENT", "AGENT_ONLINE", {
          agentCode: code,
          version: agent.version,
          capabilities: agent.capabilities
        });
        emitRoomState(room);
      }
    }

    log("agent_registered", {
      agentCode: code,
      socketId: socket.id,
      name: agent.name,
      version: agent.version
    });
    ack({ ok: true, agent: publicAgentState(code) });
  });

  socket.on("agent:heartbeat", (payload = {}, ack = () => {}) => {
    const code = socket.data.agentCode;
    const agent = code ? agents.get(code) : null;
    if (!agent || agent.socketId !== socket.id) return ack({ ok: false, error: "AGENT_NOT_REGISTERED" });
    agent.lastSeen = Date.now();
    if (payload.summary) agent.summary = safeSummary(payload.summary);
    if (payload.capabilities) agent.capabilities = safeObject(payload.capabilities);
    for (const room of rooms.values()) if (room.agentCode === code) emitRoomState(room);
    ack({ ok: true });
  });

  socket.on("agent:link", (payload = {}, ack = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== "dj") return ack({ ok: false, error: "DJ_ROOM_REQUIRED" });
    const code = normalizeCode(payload.agentCode);
    const agent = agents.get(code);
    if (!agent) return ack({ ok: false, error: "AGENT_NOT_FOUND_OR_OFFLINE" });

    room.agentCode = code;
    touch(room);
    diag(room.code, "DJ", "AGENT_LINKED", {
      agentCode: code,
      name: agent.name,
      version: agent.version,
      summary: agent.summary,
      capabilities: agent.capabilities
    });
    emitRoomState(room);
    ack({ ok: true, room: publicRoomState(room) });
  });

  socket.on("agent:unlink", (_payload, ack = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== "dj") return ack({ ok: false, error: "DJ_ROOM_REQUIRED" });
    diag(room.code, "DJ", "AGENT_UNLINKED", { agentCode: room.agentCode });
    room.agentCode = null;
    touch(room);
    emitRoomState(room);
    ack({ ok: true, room: publicRoomState(room) });
  });

  socket.on("agent:search", (payload = {}, ack = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== "dj") return ack({ ok: false, error: "DJ_ROOM_REQUIRED" });
    const query = String(payload.query || "").trim().slice(0, 180);
    if (query.length < 2) return ack({ ok: false, error: "QUERY_TOO_SHORT" });

    const agent = room.agentCode ? agents.get(room.agentCode) : null;
    if (!agent) return ack({ ok: false, error: "AGENT_OFFLINE" });

    const requestId = crypto.randomUUID();
    pendingSearches.set(requestId, {
      requestId,
      roomCode: room.code,
      djSocketId: socket.id,
      agentSocketId: agent.socketId,
      agentCode: agent.code,
      createdAt: Date.now()
    });

    diag(room.code, "DJ", "SEARCH_SENT", { requestId, query, agentCode: agent.code });
    io.to(agent.socketId).emit("agent:search", {
      requestId,
      query,
      limit: Math.min(80, Math.max(1, Number(payload.limit || 40))),
      roomCode: room.code
    });
    ack({ ok: true, requestId });
  });

  socket.on("agent:search:result", (payload = {}, ack = () => {}) => {
    const requestId = String(payload.requestId || "");
    const pending = pendingSearches.get(requestId);
    if (!pending || socket.data.role !== "agent" || pending.agentSocketId !== socket.id) {
      return ack({ ok: false, error: "INVALID_SEARCH_RESPONSE" });
    }

    pendingSearches.delete(requestId);
    const results = sanitizeResults(payload.results);
    const response = {
      requestId,
      query: String(payload.query || "").slice(0, 180),
      elapsedMs: Math.max(0, Number(payload.elapsedMs || 0)),
      totalMatches: Math.max(results.length, Number(payload.totalMatches || 0)),
      results
    };
    io.to(pending.djSocketId).emit("agent:search:result", response);
    diag(pending.roomCode, "AGENT", "SEARCH_RESULT", {
      requestId,
      query: response.query,
      elapsedMs: response.elapsedMs,
      totalMatches: response.totalMatches,
      returned: results.length
    });
    ack({ ok: true });
  });

  socket.on("media:prepare", (payload = {}, ack = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== "dj") return ack({ ok: false, error: "DJ_ROOM_REQUIRED" });
    const agent = room.agentCode ? agents.get(room.agentCode) : null;
    if (!agent) return ack({ ok: false, error: "AGENT_OFFLINE" });

    const media = payload.media && typeof payload.media === "object" ? payload.media : {};
    if (!media.id || !media.format) return ack({ ok: false, error: "INVALID_MEDIA" });

    const previousTraceId = room.activeTraceId;
    if (previousTraceId && previousTraceId !== room.playback.traceId) {
      const previousJob = mediaJobs.get(previousTraceId);
      if (previousJob && !["ready", "error", "expired", "superseded"].includes(previousJob.status)) {
        previousJob.status = "superseded";
        previousJob.updatedAt = Date.now();
        diag(room.code, "OVH", "MEDIA_PREPARE_SUPERSEDED", {
          replacedBy: "newer-request"
        }, previousTraceId);
      }
    }

    const job = createMediaJob(room, media, payload.duration);
    if (job.media.format === "CDG") {
      room.settings.cdgQuality = job.media.cdgQuality;
      room.settings.cdgBackground = job.media.cdgBackground;
      room.settings.cdgTransparencyMode = job.media.cdgTransparencyMode;
      room.settings.backgroundQuality = job.media.backgroundQuality;
      room.settings.youtubeBlur = job.media.youtubeBlur;
      room.settings.youtubeShade = job.media.youtubeShade;
    } else {
      room.settings.videoQuality = job.media.videoQuality;
    }
    room.activeTraceId = job.traceId;
    room.readyTvSocketIds.clear();
    room.playback = {
      state: "preparing",
      media: job.media,
      position: 0,
      traceId: job.traceId
    };
    touch(room);
    emitRoomState(room);

    diag(room.code, "DJ", "MEDIA_PREPARE_REQUEST", {
      mediaId: job.media.id,
      title: job.media.title,
      format: job.media.format,
      sourceAudio: job.media.audio || null,
      cdgQuality: job.media.cdgQuality || null,
      cdgBackground: job.media.cdgBackground || null,
      backgroundQuality: job.media.backgroundQuality || null,
      videoQuality: job.media.videoQuality || null,
      transportMode: "HTTP_PRELOAD",
      duration: job.duration,
      tvCount: room.tvSocketIds.size,
      agentCode: room.agentCode
    }, job.traceId);

    const origin = String(payload.origin || "").startsWith("https://")
      ? String(payload.origin).replace(/\/$/, "")
      : PUBLIC_ORIGIN;
    job.origin = origin;

    const previousJobForCancel = previousTraceId ? mediaJobs.get(previousTraceId) : null;
    if (
      previousTraceId &&
      previousTraceId !== job.traceId &&
      previousJobForCancel &&
      ["preparing", "uploading"].includes(previousJobForCancel.status)
    ) {
      io.to(agent.socketId).emit("agent:prepare:cancel", {
        traceId: previousTraceId,
        roomCode: room.code,
        replacedByTraceId: job.traceId
      });
    }

    io.to(agent.socketId).emit("agent:prepare", {
      traceId: job.traceId,
      roomCode: room.code,
      media: job.media,
      duration: job.duration,
      uploadToken: job.uploadToken,
      uploads: Object.fromEntries([...job.expected, ...(job.optional || [])].map((kind) => [
        kind,
        origin + uploadUrl(job.traceId, kind)
      ]))
    });

    ack({
      ok: true,
      traceId: job.traceId,
      state: "preparing",
      duration: job.duration
    });
  });

  socket.on("agent:diagnostic", (payload = {}, ack = () => {}) => {
    if (socket.data.role !== "agent") return ack({ ok: false, error: "AGENT_REQUIRED" });
    const traceId = String(payload.traceId || "");
    const job = mediaJobs.get(traceId);
    const roomCode = job ? job.roomCode : String(payload.roomCode || "");
    if (!roomCode) return ack({ ok: false, error: "ROOM_REQUIRED" });

    diag(
      roomCode,
      "AGENT",
      String(payload.event || "AGENT_EVENT").slice(0, 80),
      payload.data || {},
      traceId || null,
      payload.level === "error" ? "error" :
      payload.level === "warn" ? "warn" : "info"
    );
    ack({ ok: true });
  });

  socket.on("agent:background:complete", (payload = {}, ack = () => {}) => {
    const traceId = String(payload.traceId || "");
    const job = mediaJobs.get(traceId);
    if (!job || socket.data.role !== "agent" || socket.data.agentCode !== job.agentCode) {
      return ack({ ok: false, error: "BACKGROUND_JOB_INVALID" });
    }
    job.backgroundMeta = safeYoutubeBackgroundMeta(payload.background || {});
    job.backgroundState = "ready";
    job.media.youtubeBackground = true;
    job.media.youtubeBackgroundMeta = job.backgroundMeta;
    job.updatedAt = Date.now();
    job.expiresAt = Date.now() + MEDIA_TTL_MS;

    diag(job.roomCode, "AGENT", "YOUTUBE_BACKGROUND_READY", {
      background: job.backgroundMeta,
      uploaded: Boolean(job.files.background)
    }, traceId);

    const room = rooms.get(job.roomCode);
    if (room && room.playback.traceId === traceId && room.playback.media) {
      room.playback.media.youtubeBackgroundMeta = job.backgroundMeta;
      if (job.files.background) {
        room.playback.media.urls = {
          ...(room.playback.media.urls || {}),
          background: playbackUrl(job, "background")
        };
        io.to(room.code).emit("player:background", {
          traceId,
          url: playbackUrl(job, "background"),
          meta: job.backgroundMeta,
          blur: room.settings.youtubeBlur,
          shade: room.settings.youtubeShade,
          sentAt: Date.now()
        });
      }
      emitRoomState(room);
    }
    ack({ ok: true });
  });

  socket.on("agent:background:error", (payload = {}, ack = () => {}) => {
    const traceId = String(payload.traceId || "");
    const job = mediaJobs.get(traceId);
    if (!job || socket.data.role !== "agent" || socket.data.agentCode !== job.agentCode) {
      return ack({ ok: false, error: "BACKGROUND_JOB_INVALID" });
    }
    job.backgroundState = "failed";
    job.updatedAt = Date.now();
    diag(job.roomCode, "AGENT", "YOUTUBE_BACKGROUND_ERROR", {
      error: String(payload.error || "Unknown background error").slice(-1200),
      retryable: payload.retryable !== false,
      karaokeContinues: true
    }, traceId, "warn");
    ack({ ok: true });
  });

  socket.on("agent:prepare:complete", (payload = {}, ack = () => {}) => {
    const traceId = String(payload.traceId || "");
    const job = mediaJobs.get(traceId);
    if (!job || socket.data.role !== "agent" || socket.data.agentCode !== job.agentCode) {
      return ack({ ok: false, error: "PREPARE_JOB_INVALID" });
    }

    const room = rooms.get(job.roomCode);
    if (!room || room.activeTraceId !== traceId || job.status === "superseded") {
      job.status = "superseded";
      job.updatedAt = Date.now();
      diag(job.roomCode, "OVH", "MEDIA_PREPARE_IGNORED_STALE", {
        activeTraceId: room ? room.activeTraceId : null
      }, traceId);
      return ack({ ok: true, superseded: true });
    }

    if (!allPartsReady(job)) {
      diag(job.roomCode, "OVH", "MEDIA_CACHE_INCOMPLETE", {
        expected: job.expected,
        received: Object.keys(job.files)
      }, traceId, "error");
      return ack({ ok: false, error: "UPLOAD_PARTS_MISSING" });
    }

    job.status = "ready";
    job.updatedAt = Date.now();
    job.expiresAt = Date.now() + MEDIA_TTL_MS;

    diag(job.roomCode, "OVH", "MEDIA_CACHE_READY", {
      duration: job.duration,
      format: job.media.format,
      parts: Object.fromEntries(Object.entries(job.files).map(([k, v]) => [k, v.size])),
      prepareMetrics: payload.metrics || {}
    }, traceId);

    sendPreparedMedia(job);
    io.to(rooms.get(job.roomCode)?.djSocketId || "").emit("media:prepared", {
      traceId,
      media: job.media,
      duration: job.duration
    });
    ack({ ok: true });
  });

  socket.on("agent:prepare:error", (payload = {}, ack = () => {}) => {
    const traceId = String(payload.traceId || "");
    const job = mediaJobs.get(traceId);
    if (!job) return ack({ ok: false, error: "PREPARE_JOB_NOT_FOUND" });
    job.status = "error";
    job.updatedAt = Date.now();
    diag(job.roomCode, "AGENT", "MEDIA_PREPARE_ERROR", {
      code: String(payload.code || "AGENT_PREPARE_FAILED"),
      error: String(payload.error || "Unknown Agent error")
    }, traceId, "error");
    const room = rooms.get(job.roomCode);
    if (room) {
      room.playback.state = "error";
      emitRoomState(room);
    }
    ack({ ok: true });
  });

  socket.on("transport:ping", (payload = {}, ack = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    ack({
      ok: true,
      serverAt: Date.now(),
      clientAt: Number(payload.clientAt || 0),
      roomCode: room ? room.code : null,
      role: socket.data.role || null
    });
  });

  socket.on("player:settings", (payload = {}, ack = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== "dj") return ack({ ok: false, error: "DJ_ROOM_REQUIRED" });

    const previous = { ...room.settings };
    const next = {
      cdgQuality: payload.cdgQuality == null ? room.settings.cdgQuality : normalizeCdgQuality(payload.cdgQuality),
      cdgBackground: payload.cdgBackground == null ? room.settings.cdgBackground : normalizeCdgBackground(payload.cdgBackground),
      cdgTransparencyMode: payload.cdgTransparencyMode == null ? room.settings.cdgTransparencyMode : normalizeCdgTransparencyMode(payload.cdgTransparencyMode),
      backgroundQuality: payload.backgroundQuality == null ? room.settings.backgroundQuality : normalizeBackgroundQuality(payload.backgroundQuality),
      videoQuality: payload.videoQuality == null ? room.settings.videoQuality : normalizeVideoQuality(payload.videoQuality),
      youtubeBlur: payload.youtubeBlur == null ? room.settings.youtubeBlur : normalizeYoutubeBlur(payload.youtubeBlur),
      youtubeShade: payload.youtubeShade == null ? room.settings.youtubeShade : normalizeYoutubeShade(payload.youtubeShade)
    };
    room.settings = next;

    if (room.playback.media && String(room.playback.media.format || "").toUpperCase() === "CDG") {
      room.playback.media.cdgQuality = next.cdgQuality;
      room.playback.media.cdgBackground = next.cdgBackground;
      room.playback.media.cdgTransparencyMode = next.cdgTransparencyMode;
      room.playback.media.backgroundQuality = next.backgroundQuality;
      room.playback.media.youtubeBlur = next.youtubeBlur;
      room.playback.media.youtubeShade = next.youtubeShade;
      room.playback.media.youtubeBackground = next.cdgBackground === "youtube-auto";
    }

    const currentJob = room.playback.traceId ? mediaJobs.get(room.playback.traceId) : null;
    const explicitlySelectedYoutube = payload.cdgBackground != null &&
      normalizeCdgBackground(payload.cdgBackground) === "youtube-auto";
    if (
      explicitlySelectedYoutube &&
      currentJob &&
      currentJob.media.format === "CDG" &&
      !currentJob.files.background
    ) {
      // Permite que un karaoke preparado con Negro/Ondas/etc. solicite YouTube
      // en vivo sin rehacer el CDG ni bloquear la reproducción.
      if (currentJob.backgroundState === "failed") currentJob.backgroundState = "idle";
      requestYoutubeBackground(
        currentJob,
        room,
        previous.cdgBackground === "youtube-auto" ? "panel-retry" : "panel-live-switch"
      );
    }

    touch(room);
    io.to(room.code).emit("player:settings", {
      settings: next,
      traceId: room.playback.traceId || null,
      sentAt: Date.now()
    });
    emitRoomState(room);
    diag(room.code, "DJ", "PLAYER_SETTINGS_CHANGED", {
      ...next,
      tvCount: room.tvSocketIds.size
    }, room.playback.traceId);
    ack({ ok: true, settings: next, room: publicRoomState(room) });
  });

  socket.on("player:command", (payload = {}, ack = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== "dj") return ack({ ok: false, error: "DJ_ROOM_REQUIRED" });

    const command = String(payload.command || "").toUpperCase();
    if (!["PLAY", "PAUSE", "STOP", "SEEK"].includes(command)) {
      return ack({ ok: false, error: "INVALID_COMMAND" });
    }

    if (command === "PLAY" && !["ready", "paused", "playing"].includes(room.playback.state)) {
      diag(room.code, "DJ", "PLAY_REJECTED_NOT_READY", {
        state: room.playback.state,
        tvReadyCount: room.readyTvSocketIds.size,
        tvCount: room.tvSocketIds.size
      }, room.playback.traceId, "error");
      return ack({ ok: false, error: "MEDIA_NOT_READY", room: publicRoomState(room) });
    }

    if (command === "PLAY") room.playback.state = "playing";
    if (command === "PAUSE") room.playback.state = "paused";
    if (command === "STOP") {
      room.playback.state = room.playback.media ? "ready" : "stopped";
      room.playback.position = 0;
    }
    if (command === "SEEK") room.playback.position = Math.max(0, Number(payload.position || 0));

    touch(room);
    const event = {
      command,
      media: room.playback.media,
      position: command === "SEEK" ? room.playback.position : undefined,
      sentAt: Date.now(),
      traceId: room.playback.traceId
    };
    socket.to(room.code).emit("player:command", event);
    emitRoomState(room);
    diag(room.code, "DJ", "PLAYER_COMMAND_" + command, {
      tvCount: room.tvSocketIds.size,
      position: event.position ?? null
    }, room.playback.traceId);
    ack({ ok: true, room: publicRoomState(room) });
  });

  socket.on("player:status", (payload = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== "tv") return;

    touch(room);
    const state = String(payload.state || "").toLowerCase();
    const traceId = String(payload.traceId || room.playback.traceId || "") || null;

    const eventName = String(payload.event || ("TV_" + (state || "STATUS").toUpperCase())).slice(0, 100);

    // Solo eventos de transporte/reproducción pueden mutar el estado autoritativo.
    // Telemetría visual (renderer, fondo, perf) puede reportar "ready" como contexto
    // sin detener una canción que realmente sigue en PLAY.
    if (eventName === "TV_READY" || eventName === "TV_STOP" || eventName === "TV_ENDED") {
      room.readyTvSocketIds.add(socket.id);
      if (room.tvSocketIds.size > 0 && room.readyTvSocketIds.size >= room.tvSocketIds.size) {
        room.playback.state = "ready";
      }
      emitRoomState(room);
    } else if (eventName === "TV_PLAY") {
      room.playback.state = "playing";
      emitRoomState(room);
    } else if (eventName === "TV_PAUSE") {
      room.playback.state = "paused";
      emitRoomState(room);
    }
    diag(room.code, "TV", eventName, {
      socketId: socket.id,
      state,
      mediaId: payload.mediaId || null,
      elapsedMs: payload.elapsedMs ?? null,
      bytes: payload.bytes ?? null,
      bufferedSeconds: payload.bufferedSeconds ?? null,
      currentTime: payload.currentTime ?? null,
      cdgTime: payload.cdgTime ?? null,
      skewMs: payload.skewMs ?? null,
      rebufferCount: payload.rebufferCount ?? null,
      cdgQuality: payload.cdgQuality || null,
      cdgBackground: payload.cdgBackground || null,
      cdgTransparencyMode: payload.cdgTransparencyMode || null,
      backgroundQuality: payload.backgroundQuality || null,
      videoQuality: payload.videoQuality || null,
      videoWidth: payload.videoWidth ?? null,
      videoHeight: payload.videoHeight ?? null,
      youtubeBackgroundReady: payload.youtubeBackgroundReady ?? null,
      youtubeBackgroundPlaying: payload.youtubeBackgroundPlaying ?? null,
      youtubeBackgroundTime: payload.youtubeBackgroundTime ?? null,
      youtubeVideoId: payload.youtubeVideoId || null,
      youtubeBlur: payload.youtubeBlur ?? null,
      youtubeShade: payload.youtubeShade ?? null,
      rendererMetrics: safeObject(payload.rendererMetrics || {}),
      frameMetrics: safeObject(payload.frameMetrics || {}),
      backgroundMetrics: safeObject(payload.backgroundMetrics || {}),
      transport: safeObject(payload.transport || {}),
      requestedQuality: payload.requestedQuality || null,
      previousQuality: payload.previousQuality || null,
      activeQuality: payload.activeQuality || null,
      reason: payload.reason || null,
      fallbackReason: payload.fallbackReason || null,
      diagnosticSource: payload.source || null,
      attempt: payload.attempt ?? null,
      nextAttempt: payload.nextAttempt ?? null,
      mbps: payload.mbps ?? null,
      rangeSupported: payload.rangeSupported ?? null,
      targetHeight: payload.targetHeight ?? null,
      qualityReachedMs: payload.qualityReachedMs ?? null,
      gapMs: payload.gapMs ?? null,
      stallDurationMs: payload.stallDurationMs ?? null,
      error: payload.error || null
    }, traceId,
      payload.level === "error" ? "error" :
      payload.level === "warn" ? "warn" : "info"
    );

    if (room.djSocketId) {
      io.to(room.djSocketId).emit("player:status", {
        roomCode: room.code,
        socketId: socket.id,
        ...safeObject(payload),
        receivedAt: Date.now()
      });
    }
  });

  socket.on("diagnostics:get", (payload = {}, ack = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== "dj") return ack({ ok: false, error: "DJ_ROOM_REQUIRED" });
    const traceId = String(payload.traceId || "");
    let events = roomDiagnostics.get(room.code) || [];
    if (traceId) events = events.filter((entry) => entry.traceId === traceId);
    ack({
      ok: true,
      room: safeObject(publicRoomState(room)),
      traceId: traceId || null,
      generatedAt: nowIso(),
      events
    });
  });

  socket.on("diagnostics:clear", (_payload, ack = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== "dj") return ack({ ok: false, error: "DJ_ROOM_REQUIRED" });
    roomDiagnostics.set(room.code, []);
    diag(room.code, "DJ", "DIAGNOSTICS_CLEARED", {});
    ack({ ok: true });
  });

  socket.on("disconnect", (reason) => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (room) {
      if (room.djSocketId === socket.id) room.djSocketId = null;
      room.tvSocketIds.delete(socket.id);
      room.readyTvSocketIds.delete(socket.id);
      touch(room);
      emitRoomState(room);
      diag(room.code, String(socket.data.role || "SOCKET").toUpperCase(), "SOCKET_DISCONNECTED", {
        socketId: socket.id,
        reason
      }, room.playback.traceId);
    }

    const agentCode = socket.data.agentCode;
    if (agentCode) {
      const agent = agents.get(agentCode);
      if (agent && agent.socketId === socket.id) {
        agents.delete(agentCode);
        for (const linkedRoom of rooms.values()) {
          if (linkedRoom.agentCode === agentCode) {
            diag(linkedRoom.code, "AGENT", "AGENT_OFFLINE", { agentCode, reason }, linkedRoom.playback.traceId, "error");
            emitRoomState(linkedRoom);
          }
        }
      }
    }

    log("socket_disconnected", {
      socketId: socket.id,
      roomCode: code || null,
      role: socket.data.role || null,
      reason
    });
  });
});

setInterval(async () => {
  const now = Date.now();

  for (const [code, room] of rooms.entries()) {
    if (now - room.lastActivity > SESSION_TTL_MS) {
      io.to(code).emit("room:expired", { roomCode: code });
      rooms.delete(code);
      roomDiagnostics.delete(code);
      log("room_expired", { roomCode: code });
    }
  }

  for (const [requestId, pending] of pendingSearches.entries()) {
    if (now - pending.createdAt > SEARCH_TTL_MS) {
      pendingSearches.delete(requestId);
      io.to(pending.djSocketId).emit("agent:search:error", {
        requestId,
        error: "SEARCH_TIMEOUT"
      });
      diag(pending.roomCode, "OVH", "SEARCH_TIMEOUT", { requestId }, null, "error");
    }
  }

  for (const [traceId, job] of mediaJobs.entries()) {
    if (now > job.expiresAt) {
      await deleteJobFiles(job);
      mediaJobs.delete(traceId);
      diag(job.roomCode, "OVH", "MEDIA_CACHE_EXPIRED", { traceId }, traceId);
    }
  }
}, 30 * 1000).unref();

server.listen(PORT, "0.0.0.0", () => {
  log("server_started", {
    port: PORT,
    phase: 4,
    mediaDir: MEDIA_DIR,
    diagnosticsDir: DIAG_DIR,
    preloadPolicy: "FULL_BEFORE_PLAY"
  });
});
