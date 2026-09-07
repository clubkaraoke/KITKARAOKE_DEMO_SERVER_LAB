"use strict";

const http = require("http");
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT || 3000);
const SESSION_TTL_MS =
  Number(process.env.SESSION_TTL_MINUTES || 120) * 60 * 1000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ["websocket", "polling"],
  maxHttpBufferSize: 1024 * 1024
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

function log(event, data = {}) {
  process.stdout.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...data
    }) + "\n"
  );
}

function normalizeRoomCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
}

function makeRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = "";
    for (let i = 0; i < 6; i += 1) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
  } while (rooms.has(code));
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
    playback: {
      state: "idle",
      media: null,
      position: 0
    }
  };
  rooms.set(code, room);
  return room;
}

function publicRoomState(room) {
  return {
    code: room.code,
    createdAt: room.createdAt,
    lastActivity: room.lastActivity,
    tvCount: room.tvSocketIds.size,
    hasDj: Boolean(room.djSocketId),
    playback: room.playback
  };
}

function touch(room) {
  room.lastActivity = Date.now();
}

function emitRoomState(room) {
  io.to(room.code).emit("room:state", publicRoomState(room));
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "kitkaraoke-demo-server-lab",
    phase: 1,
    rooms: rooms.size,
    uptimeSeconds: Math.floor(process.uptime())
  });
});

app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    rooms: Array.from(rooms.values()).map(publicRoomState)
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

  log("socket_connected", { socketId: socket.id });

  socket.on("room:create", (_payload, ack = () => {}) => {
    if (socket.data.roomCode) {
      return ack({ ok: false, error: "SOCKET_ALREADY_IN_ROOM" });
    }

    const code = makeRoomCode();
    const room = newRoom(code, socket.id);

    socket.data.role = "dj";
    socket.data.roomCode = code;
    socket.join(code);

    log("room_created", { roomCode: code, djSocketId: socket.id });
    emitRoomState(room);
    return ack({ ok: true, room: publicRoomState(room) });
  });

  socket.on("room:join", (payload = {}, ack = () => {}) => {
    const code = normalizeRoomCode(payload.roomCode);
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
      position:
        command === "SEEK"
          ? room.playback.position
          : undefined,
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
}, 60 * 1000).unref();

server.listen(PORT, "0.0.0.0", () => {
  log("server_started", {
    port: PORT,
    phase: 1,
    djUrl: `http://localhost:${PORT}/dj`,
    tvUrl: `http://localhost:${PORT}/tv`
  });
});
