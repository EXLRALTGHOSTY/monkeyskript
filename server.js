const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// ─── Database ────────────────────────────────────────────────────────────────
const DATA_DIR = process.env.RENDER
  ? '/opt/render/project/src/data'
  : path.join(__dirname, 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'monkeyskript.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    content TEXT DEFAULT '',
    updated_at INTEGER DEFAULT (strftime('%s','now')),
    UNIQUE(room_id, filename),
    FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE
  );
`);

// Prepared statements
const stmts = {
  getRoomFiles: db.prepare('SELECT filename, content FROM files WHERE room_id = ?'),
  upsertFile:   db.prepare(`
    INSERT INTO files (room_id, filename, content, updated_at)
    VALUES (?, ?, ?, strftime('%s','now'))
    ON CONFLICT(room_id, filename) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
  `),
  deleteFile:   db.prepare('DELETE FROM files WHERE room_id = ? AND filename = ?'),
  createRoom:   db.prepare('INSERT OR IGNORE INTO rooms (id) VALUES (?)'),
  roomExists:   db.prepare('SELECT id FROM rooms WHERE id = ?'),
  renameFile:   db.prepare(`
    UPDATE files SET filename = ?, updated_at = strftime('%s','now')
    WHERE room_id = ? AND filename = ?
  `),
};

// ─── In-memory room state ─────────────────────────────────────────────────────
const rooms = {};

function getRoomUsers(roomId) {
  if (!rooms[roomId]) return [];
  return Object.values(rooms[roomId].users);
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'MONK-';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ─── REST API ─────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Create a new room
app.post('/api/rooms', (req, res) => {
  let id;
  do { id = generateRoomCode(); } while (stmts.roomExists.get(id));
  stmts.createRoom.run(id);
  rooms[id] = { users: {} };
  res.json({ roomId: id });
});

// Check if room exists
app.get('/api/rooms/:id', (req, res) => {
  const room = stmts.roomExists.get(req.params.id.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ roomId: room.id });
});

// Get all files in a room
app.get('/api/rooms/:id/files', (req, res) => {
  const roomId = req.params.id.toUpperCase();
  const room = stmts.roomExists.get(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const files = stmts.getRoomFiles.all(roomId);
  const result = {};
  files.forEach(f => result[f.filename] = f.content);
  res.json(result);
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentRoom = null;
  let currentUser = null;

  // ── Join Room ──────────────────────────────────────────────────────────────
  socket.on('join-room', ({ roomId, userName, userColor }, callback) => {
    roomId = roomId.toUpperCase();

    const room = stmts.roomExists.get(roomId);
    if (!room) {
      callback({ error: 'Room not found! Check the code.' });
      return;
    }

    if (currentRoom) socket.leave(currentRoom);

    currentRoom = roomId;
    currentUser = { name: userName, color: userColor, editingFile: null };

    if (!rooms[roomId]) rooms[roomId] = { users: {} };
    rooms[roomId].users[socket.id] = currentUser;

    socket.join(roomId);

    const files = stmts.getRoomFiles.all(roomId);
    const fileMap = {};
    files.forEach(f => fileMap[f.filename] = f.content);

    callback({ success: true, files: fileMap, users: getRoomUsers(roomId) });

    socket.to(roomId).emit('user-joined', { name: userName, color: userColor, users: getRoomUsers(roomId) });
  });

  // ── File Change ─────────────────────────────────────────────────────────────
  socket.on('file-change', ({ filename, content }) => {
    if (!currentRoom) return;
    stmts.upsertFile.run(currentRoom, filename, content);
    if (currentUser) currentUser.editingFile = filename;
    socket.to(currentRoom).emit('file-updated', { filename, content, by: currentUser?.name });
  });

  // ── New File ────────────────────────────────────────────────────────────────
  socket.on('file-create', ({ filename, content }) => {
    if (!currentRoom) return;
    stmts.upsertFile.run(currentRoom, filename, content || '');
    io.to(currentRoom).emit('file-created', { filename, content: content || '', by: currentUser?.name });
  });

  // ── Delete File ─────────────────────────────────────────────────────────────
  socket.on('file-delete', ({ filename }) => {
    if (!currentRoom) return;
    stmts.deleteFile.run(currentRoom, filename);
    io.to(currentRoom).emit('file-deleted', { filename, by: currentUser?.name });
  });

  // ── Rename File ─────────────────────────────────────────────────────────────
  socket.on('file-rename', ({ oldName, newName }) => {
    if (!currentRoom) return;
    stmts.renameFile.run(newName, currentRoom, oldName);
    io.to(currentRoom).emit('file-renamed', { oldName, newName, by: currentUser?.name });
  });

  // ── Cursor Presence ──────────────────────────────────────────────────────────
  socket.on('cursor-move', ({ filename, line, col }) => {
    if (!currentRoom || !currentUser) return;
    currentUser.editingFile = filename;
    socket.to(currentRoom).emit('cursor-update', { name: currentUser.name, color: currentUser.color, filename, line, col });
  });

  // ── Disconnect ───────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const userName = currentUser?.name;
    delete rooms[currentRoom].users[socket.id];
    const remaining = getRoomUsers(currentRoom);
    io.to(currentRoom).emit('user-left', { name: userName, users: remaining });
    if (remaining.length === 0) delete rooms[currentRoom];
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🐒 MonkeySkript server running on http://localhost:${PORT}`);
});
