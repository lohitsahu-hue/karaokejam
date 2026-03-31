const { v4: uuid } = require('uuid');
const { generateRoomCode } = require('../utils/shortCode');
const log = require('../utils/logger');

// ── In-memory stores ──
const rooms = new Map();   // roomId → room
const jobs = new Map();    // jobId → job
const codeToRoom = new Map(); // roomCode → roomId

// ── Room operations ──

function createRoom(hostName) {
  const id = uuid();
  let code;
  do { code = generateRoomCode(); } while (codeToRoom.has(code));

  const room = {
    id,
    code,
    hostId: null, // set when host connects via WS
    hostName,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    guests: [],
    queue: [],
    currentQueueIdx: -1,
    playback: {
      state: 'stopped', // stopped | playing | paused
      startedAt: null,   // server timestamp when play was pressed
      offsetSec: 0,      // song position when play was pressed
      keyShift: 0,
      tempoPercent: 100,
      lyricsOffset: 0,
    },
  };

  rooms.set(id, room);
  codeToRoom.set(code, id);
  log.info(`Room created: ${code} (${id}) by ${hostName}`);
  return room;
}

function getRoom(roomId) {
  return rooms.get(roomId) || null;
}

function getRoomByCode(code) {
  const id = codeToRoom.get(code.toUpperCase().replace(/[^A-Z0-9]/g, ''));
  // Also try with dash
  if (!id) {
    const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
    for (const [c, rid] of codeToRoom) {
      if (c.replace('-', '') === normalized) return rooms.get(rid) || null;
    }
  }
  return id ? rooms.get(id) || null : null;
}

function addGuest(roomId, guestId, guestName) {
  const room = rooms.get(roomId);
  if (!room) return null;
  const existing = room.guests.find(g => g.id === guestId);
  if (existing) { existing.name = guestName; return room; }
  room.guests.push({ id: guestId, name: guestName, joinedAt: Date.now() });
  room.lastActivity = Date.now();
  log.info(`Guest ${guestName} joined room ${room.code}`);
  return room;
}

function removeGuest(roomId, guestId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  room.guests = room.guests.filter(g => g.id !== guestId);
  room.lastActivity = Date.now();
  return room;
}

function deleteRoom(roomId) {
  const room = rooms.get(roomId);
  if (room) {
    codeToRoom.delete(room.code);
    rooms.delete(roomId);
    log.info(`Room deleted: ${room.code}`);
  }
}

// ── Queue operations ──

function addToQueue(roomId, item) {
  const room = rooms.get(roomId);
  if (!room) return null;
  const queueItem = {
    id: uuid(),
    songId: item.songId,       // YouTube ID or custom
    title: item.title,
    artist: item.artist,
    thumbnail: item.thumbnail || '',
    duration: item.duration || 0,
    requestedBy: item.requestedBy,
    requestedByName: item.requestedByName || 'Unknown',
    jobId: null,
    lrcData: null,
    status: 'pending', // pending | downloading | separating | ready | playing | played
    createdAt: Date.now(),
  };
  room.queue.push(queueItem);
  room.lastActivity = Date.now();
  log.info(`Queued "${queueItem.title}" in room ${room.code} by ${queueItem.requestedByName}`);
  return queueItem;
}

function removeFromQueue(roomId, queueItemId) {
  const room = rooms.get(roomId);
  if (!room) return false;
  const idx = room.queue.findIndex(q => q.id === queueItemId);
  if (idx < 0) return false;
  room.queue.splice(idx, 1);
  // Adjust currentQueueIdx if needed
  if (idx < room.currentQueueIdx) room.currentQueueIdx--;
  else if (idx === room.currentQueueIdx) room.currentQueueIdx = -1;
  return true;
}

function reorderQueue(roomId, queueItemId, newPosition) {
  const room = rooms.get(roomId);
  if (!room) return false;
  const idx = room.queue.findIndex(q => q.id === queueItemId);
  if (idx < 0) return false;
  const [item] = room.queue.splice(idx, 1);
  const pos = Math.max(0, Math.min(newPosition, room.queue.length));
  room.queue.splice(pos, 0, item);
  return true;
}

function getQueueItem(roomId, queueItemId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  return room.queue.find(q => q.id === queueItemId) || null;
}

function updateQueueItemStatus(roomId, queueItemId, status, extra = {}) {
  const item = getQueueItem(roomId, queueItemId);
  if (!item) return null;
  item.status = status;
  Object.assign(item, extra);
  return item;
}

// ── Job operations ──

function createJob(roomId, queueItemId, type) {
  const id = uuid();
  const job = {
    id,
    roomId,
    queueItemId,
    type, // 'download' | 'separate' | 'lyrics' | 'full_pipeline'
    status: 'pending', // pending | running | completed | failed
    progress: 0,
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    output: null,
    error: null,
  };
  jobs.set(id, job);
  // Link job to queue item
  const item = getQueueItem(roomId, queueItemId);
  if (item) item.jobId = id;
  return job;
}

function getJob(jobId) {
  return jobs.get(jobId) || null;
}

function updateJob(jobId, updates) {
  const job = jobs.get(jobId);
  if (!job) return null;
  Object.assign(job, updates);
  return job;
}

// ── Cleanup ──

function cleanupIdleRooms(maxIdleMs) {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (now - room.lastActivity > maxIdleMs) {
      deleteRoom(id);
    }
  }
}

module.exports = {
  createRoom, getRoom, getRoomByCode, addGuest, removeGuest, deleteRoom,
  addToQueue, removeFromQueue, reorderQueue, getQueueItem, updateQueueItemStatus,
  createJob, getJob, updateJob,
  cleanupIdleRooms,
  // Expose for debugging
  _rooms: rooms, _jobs: jobs,
};