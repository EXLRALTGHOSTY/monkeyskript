const express = require('express');
const http = require('http');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

// ─── Database ────────────────────────────────────────────────────────────────
function getDataDir() {
  if (process.env.RENDER) {
    try {
      fs.mkdirSync('/data', { recursive: true });
      fs.accessSync('/data', fs.constants.W_OK);
      console.log('✅ Using persistent disk at /data');
      return '/data';
    } catch(e) {
      console.warn('⚠️  /data not writable — using temp dir. Add a Render disk at /data to persist data!');
    }
  }
  return path.join(__dirname, 'data');
}

const DATA_DIR = getDataDir();
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
  getPresence:    db.prepare(`SELECT user_name, user_color, editing_file FROM presence WHERE room_id = ? AND last_seen > strftime('%s','now') - 15`),
  deletePresence: db.prepare('DELETE FROM presence WHERE room_id = ? AND user_name = ?'),
};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'MONK-';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ─── SSE Client Registry ─────────────────────────────────────────────────────
// Map of roomId -> Set of { res, userName }
const roomClients = new Map();

function getRoomClients(roomId) {
  if (!roomClients.has(roomId)) roomClients.set(roomId, new Set());
  return roomClients.get(roomId);
}

function broadcast(roomId, senderUserName, eventName, data) {
  const clients = getRoomClients(roomId);
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    if (client.userName === senderUserName) continue; // don't echo back to sender
    try { client.res.write(payload); } catch(e) {}
  }
}

function broadcastAll(roomId, eventName, data) {
  const clients = getRoomClients(roomId);
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try { client.res.write(payload); } catch(e) {}
  }
}

// ─── Middleware ───────────────────────────────────────────────────────────────
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

// ─── SSE Stream ──────────────────────────────────────────────────────────────
app.get('/api/rooms/:id/stream', (req, res) => {
  const roomId = req.params.id.toUpperCase();
  if (!stmts.roomExists.get(roomId)) return res.status(404).json({ error: 'Room not found' });

  const userName = req.query.userName || 'Unknown';

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // important for Render/nginx
  res.flushHeaders();

  // Send a heartbeat comment every 20s to keep connection alive
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch(e) {}
  }, 20000);

  // Register this client
  const client = { res, userName };
  getRoomClients(roomId).add(client);

  // Send current room state immediately on connect
  const files = stmts.getRoomFiles.all(roomId);
  const fileMap = {};
  files.forEach(f => fileMap[f.filename] = f.content);
  res.write(`event: init\ndata: ${JSON.stringify({ files: fileMap })}\n\n`);

  // Notify others that this user joined
  broadcastAll(roomId, 'presence', {
    users: stmts.getPresence.all(roomId)
  });

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    getRoomClients(roomId).delete(client);
    // Remove presence
    stmts.deletePresence.run(roomId, userName);
    // Notify others
    broadcastAll(roomId, 'presence', {
      users: stmts.getPresence.all(roomId)
    });
  });
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
  const { filename, content, userName } = req.body;
  stmts.upsertFile.run(roomId, filename, content || '');
  // Push change instantly to all other clients in the room
  broadcast(roomId, userName, 'file:update', { filename, content: content || '' });
  res.json({ ok: true });
});

app.delete('/api/rooms/:id/files/:filename', (req, res) => {
  const roomId = req.params.id.toUpperCase();
  const { userName } = req.body || {};
  stmts.deleteFile.run(roomId, req.params.filename);
  broadcast(roomId, userName, 'file:delete', { filename: req.params.filename });
  res.json({ ok: true });
});

app.post('/api/rooms/:id/files/:filename/rename', (req, res) => {
  const roomId = req.params.id.toUpperCase();
  const { newName, userName } = req.body;
  stmts.renameFile.run(newName, roomId, req.params.filename);
  broadcast(roomId, userName, 'file:rename', { oldName: req.params.filename, newName });
  res.json({ ok: true });
});

// ─── Presence ────────────────────────────────────────────────────────────────
app.post('/api/rooms/:id/presence', (req, res) => {
  const roomId = req.params.id.toUpperCase();
  if (!stmts.roomExists.get(roomId)) return res.status(404).json({ error: 'Room not found' });
  const { userName, userColor, editingFile } = req.body;
  stmts.upsertPresence.run(roomId, userName, userColor, editingFile || '');
  // Push presence update to everyone in room including sender
  broadcastAll(roomId, 'presence', {
    users: stmts.getPresence.all(roomId)
  });
  res.json({ ok: true });
});

app.delete('/api/rooms/:id/presence/:userName', (req, res) => {
  const roomId = req.params.id.toUpperCase();
  stmts.deletePresence.run(roomId, req.params.userName);
  broadcastAll(roomId, 'presence', {
    users: stmts.getPresence.all(roomId)
  });
  res.json({ ok: true });
});

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🐒 MonkeySkript server running on http://localhost:${PORT}`);
});
