const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const config = require('./config');
const log = require('./utils/logger');
const apiRoutes = require('./routes/api');
const { setupSocketHandlers } = require('./routes/ws');
const db = require('./models/inMemory');

// ── Express app ──
const app = express();
app.use(cors());
app.use(express.json());

// ── Serve frontend ──
const frontendDir = path.join(__dirname, '../frontend');
app.use(express.static(frontendDir));

// ── API routes ──
app.use('/api', apiRoutes);

// ── View routes ──
// TV Display: /tv/ROOM-CODE
app.get('/tv/:roomCode', (req, res) => {
  res.sendFile(path.join(frontendDir, 'tv.html'));
});

// Participant: /join/ROOM-CODE
app.get('/join/:roomCode', (req, res) => {
  res.sendFile(path.join(frontendDir, 'join.html'));
});

// Host: / or /host (existing SPA)
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(frontendDir, 'index.html'));
  }
});

// ── HTTP + WebSocket server ──
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// Export io for use in routes
module.exports.io = io;

// ── Socket.IO handlers ──
setupSocketHandlers(io);

// ── Room cleanup (every 10 minutes) ──
setInterval(() => {
  db.cleanupIdleRooms(config.room.idleTimeoutMs);
}, 10 * 60 * 1000);

// ── Start ──
server.listen(config.port, () => {
  log.info(`🎤 Karaoke Party Server running on http://localhost:${config.port}`);
  log.info(`   Environment: ${config.env}`);
  log.info(`   YouTube API: ${config.youtube.apiKey ? 'configured' : 'NOT configured'}`);
  log.info(`   Demucs mode: ${config.demucs.mode}`);
});