const express = require('express');
const http = require('http');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

// ─── Database ────────────────────────────────────────────────────────────────
const DATA_DIR = process.env.RENDER
  ? '/data'
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
  CREATE TABLE IF NOT EXISTS presence (
    room_id TEXT NOT NULL,
    user_name TEXT NOT NULL,
    user_color TEXT NOT NULL,
    editing_file TEXT DEFAULT '',
    last_seen INTEGER DEFAULT (strftime('%s','now')),
    PRIMARY KEY(room_id, user_name)
  );
`);

const stmts = {
  getRoomFiles:   db.prepare('SELECT filename, content FROM files WHERE room_id = ?'),
  upsertFile:     db.prepare(`INSERT INTO files (room_id, filename, content, updated_at) VALUES (?, ?, ?, strftime('%s','now')) ON CONFLICT(room_id, filename) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`),
  deleteFile:     db.prepare('DELETE FROM files WHERE room_id = ? AND filename = ?'),
  renameFile:     db.prepare(`UPDATE files SET filename = ?, updated_at = strftime('%s','now') WHERE room_id = ? AND filename = ?`),
  createRoom:     db.prepare('INSERT OR IGNORE INTO rooms (id) VALUES (?)'),
  roomExists:     db.prepare('SELECT id FROM rooms WHERE id = ?'),
  upsertPresence: db.prepare(`INSERT INTO presence (room_id, user_name, user_color, editing_file, last_seen) VALUES (?, ?, ?, ?, strftime('%s','now')) ON CONFLICT(room_id, user_name) DO UPDATE SET user_color=excluded.user_color, editing_file=excluded.editing_file, last_seen=strftime('%s','now')`),
  getPresence:    db.prepare(`SELECT user_name, user_color, editing_file FROM presence WHERE room_id = ? AND last_seen > strftime('%s','now') - 10`),
  deletePresence: db.prepare('DELETE FROM presence WHERE room_id = ? AND user_name = ?'),
  filesSince:     db.prepare('SELECT filename, content FROM files WHERE room_id = ? AND updated_at > ?'),
};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'MONK-';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Rooms ───────────────────────────────────────────────────────────────────
app.post('/api/rooms', (req, res) => {
  let id;
  do { id = generateRoomCode(); } while (stmts.roomExists.get(id));
  stmts.createRoom.run(id);
  res.json({ roomId: id });
});

app.get('/api/rooms/:id', (req, res) => {
  const room = stmts.roomExists.get(req.params.id.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ roomId: room.id });
});

// ─── Files ───────────────────────────────────────────────────────────────────
app.get('/api/rooms/:id/files', (req, res) => {
  const roomId = req.params.id.toUpperCase();
  if (!stmts.roomExists.get(roomId)) return res.status(404).json({ error: 'Room not found' });
  const files = stmts.getRoomFiles.all(roomId);
  const result = {};
  files.forEach(f => result[f.filename] = f.content);
  res.json(result);
});

app.post('/api/rooms/:id/files', (req, res) => {
  const roomId = req.params.id.toUpperCase();
  if (!stmts.roomExists.get(roomId)) return res.status(404).json({ error: 'Room not found' });
  const { filename, content } = req.body;
  stmts.upsertFile.run(roomId, filename, content || '');
  res.json({ ok: true });
});

app.delete('/api/rooms/:id/files/:filename', (req, res) => {
  const roomId = req.params.id.toUpperCase();
  stmts.deleteFile.run(roomId, req.params.filename);
  res.json({ ok: true });
});

app.post('/api/rooms/:id/files/:filename/rename', (req, res) => {
  const roomId = req.params.id.toUpperCase();
  stmts.renameFile.run(req.body.newName, roomId, req.params.filename);
  res.json({ ok: true });
});

// ─── Poll — returns files changed since timestamp + active users ──────────────
app.get('/api/rooms/:id/poll', (req, res) => {
  const roomId = req.params.id.toUpperCase();
  if (!stmts.roomExists.get(roomId)) return res.status(404).json({ error: 'Room not found' });
  const since = parseInt(req.query.since) || 0;
  const changedFiles = stmts.filesSince.all(roomId, since);
  const users = stmts.getPresence.all(roomId);
  res.json({ changedFiles, users, serverTime: Math.floor(Date.now() / 1000) });
});

// ─── Presence ────────────────────────────────────────────────────────────────
app.post('/api/rooms/:id/presence', (req, res) => {
  const roomId = req.params.id.toUpperCase();
  if (!stmts.roomExists.get(roomId)) return res.status(404).json({ error: 'Room not found' });
  const { userName, userColor, editingFile } = req.body;
  stmts.upsertPresence.run(roomId, userName, userColor, editingFile || '');
  res.json({ ok: true });
});

app.delete('/api/rooms/:id/presence/:userName', (req, res) => {
  stmts.deletePresence.run(req.params.id.toUpperCase(), req.params.userName);
  res.json({ ok: true });
});

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🐒 MonkeySkript server running on http://localhost:${PORT}`);
});
