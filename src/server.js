"use strict";

const crypto = require("crypto");
const http = require("http");
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT || 3000);
const SESSION_TTL_MS =
  Number(process.env.SESSION_TTL_MINUTES || 120) * 60 * 1000;
const SEARCH_TTL_MS = 30 * 1000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ["websocket", "polling"],
  maxHttpBufferSize: 2 * 1024 * 1024
});

app.disable("x-powered-by");
app.use(
  helmet({
    contentSecurityPolicy: false
  })
);
app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

const rooms = new Map();
const agents = new Map();
const pendingSearches = new Map();

function log(event, data = {}) {
  process.stdout.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...data
    }) + "\n"
  );
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
    agentCode: null,
    playback: {
      state: "idle",
      media: null,
      position: 0
    }
  };
  rooms.set(code, room);
  return room;
}

function publicAgentState(code) {
  if (!code) return null;
  const agent = agents.get(code);
  if (!agent) {
    return { code, online: false };
  }
  return {
    code,
    online: true,
    name: agent.name,
    version: agent.version,
    summary: agent.summary || null,
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
    hasDj: Boolean(room.djSocketId),
    agent: publicAgentState(room.agentCode),
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
    duration: Number.isFinite(Number(item.duration))
      ? Math.max(0, Number(item.duration))
      : null
  }));
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "kitkaraoke-demo-server-lab",
    phase: 2,
    rooms: rooms.size,
    agentsOnline: agents.size,
    uptimeSeconds: Math.floor(process.uptime())
  });
});

app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    rooms: Array.from(rooms.values()).map(publicRoomState),
    agentsOnline: Array.from(agents.values()).map((agent) => ({
      code: agent.code,
      name: agent.name,
      version: agent.version,
      summary: agent.summary,
      connectedAt: agent.connectedAt,
      lastSeen: agent.lastSeen
    }))
  });
});

app.get("/dj", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "dj.html"));
});

app.get("/tv", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "tv.html"));
});

app.get("/", (req, res) => {
  const host = String(req.hostname || "").toLowerCase();
  if (host.startsWith("demotv.")) {
    return res.sendFile(path.join(__dirname, "..", "public", "tv.html"));
  }
  return res.sendFile(path.join(__dirname, "..", "public", "dj.html"));
});

io.on("connection", (socket) => {
  socket.data.role = null;
  socket.data.roomCode = null;
  socket.data.agentCode = null;

  log("socket_connected", { socketId: socket.id });

  socket.on("room:create", (_payload, ack = () => {}) => {
    if (socket.data.roomCode) {
      return ack({ ok: false, error: "SOCKET_ALREADY_IN_ROOM" });
    }

    const code = makeCode(rooms);
    const room = newRoom(code, socket.id);

    socket.data.role = "dj";
    socket.data.roomCode = code;
    socket.join(code);

    log("room_created", { roomCode: code, djSocketId: socket.id });
    emitRoomState(room);
    return ack({ ok: true, room: publicRoomState(room) });
  });

  socket.on("room:join", (payload = {}, ack = () => {}) => {
    const code = normalizeCode(payload.roomCode);
    const role = payload.role === "dj" ? "dj" : "tv";
    const room = rooms.get(code);

    if (!room) {
      return ack({ ok: false, error: "ROOM_NOT_FOUND" });
    }

    if (role === "dj" && room.djSocketId && room.djSocketId !== socket.id) {
      return ack({ ok: false, error: "DJ_ALREADY_CONNECTED" });
    }

    socket.data.role = role;
    socket.data.roomCode = code;
    socket.join(code);

    if (role === "dj") {
      room.djSocketId = socket.id;
    } else {
      room.tvSocketIds.add(socket.id);
    }

    touch(room);
    log("room_joined", {
      roomCode: code,
      role,
      socketId: socket.id,
      tvCount: room.tvSocketIds.size
    });
    emitRoomState(room);
    return ack({ ok: true, room: publicRoomState(room) });
  });

  socket.on("agent:register", (payload = {}, ack = () => {}) => {
    if (socket.data.roomCode) {
      return ack({ ok: false, error: "ROOM_SOCKET_CANNOT_REGISTER_AGENT" });
    }

    const preferred = normalizeCode(payload.preferredCode);
    let code = preferred;

    if (!code || (agents.has(code) && agents.get(code).socketId !== socket.id)) {
      code = makeCode(agents);
    }

    if (socket.data.agentCode && socket.data.agentCode !== code) {
      agents.delete(socket.data.agentCode);
    }

    const now = Date.now();
    const agent = {
      code,
      socketId: socket.id,
      name: String(payload.name || "KITKARAOKE Agent").slice(0, 80),
      version: String(payload.version || "0.1.0").slice(0, 32),
      summary: safeSummary(payload.summary),
      connectedAt: now,
      lastSeen: now
    };

    agents.set(code, agent);
    socket.data.role = "agent";
    socket.data.agentCode = code;
    socket.join("agent:" + code);

    for (const room of rooms.values()) {
      if (room.agentCode === code) {
        emitRoomState(room);
      }
    }

    log("agent_registered", {
      agentCode: code,
      socketId: socket.id,
      name: agent.name,
      summary: agent.summary
    });

    return ack({
      ok: true,
      agent: publicAgentState(code)
    });
  });

  socket.on("agent:heartbeat", (payload = {}, ack = () => {}) => {
    const code = socket.data.agentCode;
    const agent = code ? agents.get(code) : null;
    if (!agent || agent.socketId !== socket.id) {
      return ack({ ok: false, error: "AGENT_NOT_REGISTERED" });
    }

    agent.lastSeen = Date.now();
    if (payload.summary) {
      agent.summary = safeSummary(payload.summary);
    }

    for (const room of rooms.values()) {
      if (room.agentCode === code) emitRoomState(room);
    }

    return ack({ ok: true });
  });

  socket.on("agent:link", (payload = {}, ack = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== "dj") {
      return ack({ ok: false, error: "DJ_ROOM_REQUIRED" });
    }

    const code = normalizeCode(payload.agentCode);
    const agent = agents.get(code);
    if (!agent) {
      return ack({ ok: false, error: "AGENT_NOT_FOUND_OR_OFFLINE" });
    }

    room.agentCode = code;
    touch(room);
    emitRoomState(room);

    log("agent_linked", {
      roomCode: room.code,
      agentCode: code,
      djSocketId: socket.id
    });

    return ack({ ok: true, room: publicRoomState(room) });
  });

  socket.on("agent:unlink", (_payload, ack = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== "dj") {
      return ack({ ok: false, error: "DJ_ROOM_REQUIRED" });
    }
    room.agentCode = null;
    touch(room);
    emitRoomState(room);
    return ack({ ok: true, room: publicRoomState(room) });
  });

  socket.on("agent:search", (payload = {}, ack = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== "dj") {
      return ack({ ok: false, error: "DJ_ROOM_REQUIRED" });
    }

    const query = String(payload.query || "").trim().slice(0, 180);
    if (query.length < 2) {
      return ack({ ok: false, error: "QUERY_TOO_SHORT" });
    }

    const agent = room.agentCode ? agents.get(room.agentCode) : null;
    if (!agent) {
      return ack({ ok: false, error: "AGENT_OFFLINE" });
    }

    const requestId = crypto.randomUUID();
    pendingSearches.set(requestId, {
      requestId,
      roomCode: room.code,
      djSocketId: socket.id,
      agentSocketId: agent.socketId,
      agentCode: agent.code,
      createdAt: Date.now()
    });

    io.to(agent.socketId).emit("agent:search", {
      requestId,
      query,
      limit: Math.min(80, Math.max(1, Number(payload.limit || 40))),
      roomCode: room.code
    });

    log("agent_search_sent", {
      requestId,
      roomCode: room.code,
      agentCode: agent.code,
      query
    });

    return ack({ ok: true, requestId });
  });

  socket.on("agent:search:result", (payload = {}, ack = () => {}) => {
    const requestId = String(payload.requestId || "");
    const pending = pendingSearches.get(requestId);

    if (
      !pending ||
      socket.data.role !== "agent" ||
      pending.agentSocketId !== socket.id
    ) {
      return ack({ ok: false, error: "INVALID_SEARCH_RESPONSE" });
    }

    pendingSearches.delete(requestId);
    const results = sanitizeResults(payload.results);

    io.to(pending.djSocketId).emit("agent:search:result", {
      requestId,
      query: String(payload.query || "").slice(0, 180),
      elapsedMs: Math.max(0, Number(payload.elapsedMs || 0)),
      totalMatches: Math.max(results.length, Number(payload.totalMatches || 0)),
      results
    });

    log("agent_search_result", {
      requestId,
      roomCode: pending.roomCode,
      agentCode: pending.agentCode,
      results: results.length
    });

    return ack({ ok: true });
  });

  socket.on("player:command", (payload = {}, ack = () => {}) => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);

    if (!room || socket.data.role !== "dj") {
      return ack({ ok: false, error: "DJ_ROOM_REQUIRED" });
    }

    const command = String(payload.command || "").toUpperCase();
    const allowed = new Set(["LOAD", "PLAY", "PAUSE", "STOP", "SEEK"]);

    if (!allowed.has(command)) {
      return ack({ ok: false, error: "INVALID_COMMAND" });
    }

    if (command === "LOAD") {
      room.playback.media = payload.media || null;
      room.playback.position = 0;
      room.playback.state = "loaded";
    } else if (command === "PLAY") {
      room.playback.state = "playing";
    } else if (command === "PAUSE") {
      room.playback.state = "paused";
    } else if (command === "STOP") {
      room.playback.state = "stopped";
      room.playback.position = 0;
    } else if (command === "SEEK") {
      room.playback.position = Math.max(0, Number(payload.position || 0));
    }

    touch(room);

    const event = {
      command,
      media: payload.media || null,
      position: command === "SEEK" ? room.playback.position : undefined,
      sentAt: Date.now()
    };

    socket.to(code).emit("player:command", event);
    emitRoomState(room);

    log("player_command", {
      roomCode: code,
      command,
      djSocketId: socket.id,
      tvCount: room.tvSocketIds.size
    });

    return ack({ ok: true, room: publicRoomState(room) });
  });

  socket.on("player:status", (payload = {}) => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);

    if (!room || socket.data.role !== "tv") {
      return;
    }

    touch(room);
    io.to(room.djSocketId).emit("player:status", {
      roomCode: code,
      socketId: socket.id,
      ...payload,
      receivedAt: Date.now()
    });
  });

  socket.on("disconnect", (reason) => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);

    if (room) {
      if (room.djSocketId === socket.id) {
        room.djSocketId = null;
      }
      room.tvSocketIds.delete(socket.id);
      touch(room);
      emitRoomState(room);
    }

    const agentCode = socket.data.agentCode;
    if (agentCode) {
      const agent = agents.get(agentCode);
      if (agent && agent.socketId === socket.id) {
        agents.delete(agentCode);
        for (const linkedRoom of rooms.values()) {
          if (linkedRoom.agentCode === agentCode) emitRoomState(linkedRoom);
        }
        log("agent_disconnected", {
          agentCode,
          socketId: socket.id,
          reason
        });
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

setInterval(() => {
  const now = Date.now();

  for (const [code, room] of rooms.entries()) {
    if (now - room.lastActivity > SESSION_TTL_MS) {
      io.to(code).emit("room:expired", { roomCode: code });
      rooms.delete(code);
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
    }
  }
}, 30 * 1000).unref();

server.listen(PORT, "0.0.0.0", () => {
  log("server_started", {
    port: PORT,
    phase: 2,
    djUrl: `http://localhost:${PORT}/dj`,
    tvUrl: `http://localhost:${PORT}/tv`
  });
});
