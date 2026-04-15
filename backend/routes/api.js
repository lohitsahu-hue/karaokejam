const express = require('express');
const router = express.Router();
const { v4: uuid } = require('uuid');
const path = require('path');
const multer = require('multer');
const db = require('../models/inMemory');
const { searchYouTube } = require('../services/youtubeService');
const { fetchLyrics } = require('../services/lyricService');
const { fullPipeline, fullPipelineFromFile, getStemPath, getChordsPath, getMidiPath } = require('../services/stemExtractor');
const fs = require('fs');
const config = require('../config');
const log = require('../utils/logger');

// Configure multer for audio file uploads
const upload = multer({
  dest: path.join(config.storage.downloadsDir || '/tmp/karaoke-downloads'),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/flac', 'audio/ogg', 'audio/aac', 'audio/m4a', 'audio/x-m4a', 'audio/mp4'];
    if (allowed.includes(file.mimetype) || /\.(mp3|wav|flac|ogg|aac|m4a|wma)$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed (MP3, WAV, FLAC, OGG, AAC, M4A)'));
    }
  },
});

// ── Health check ──
router.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ── Room endpoints ──

// Create a new room
router.post('/rooms', (req, res) => {
  const { hostName } = req.body;
  if (!hostName) return res.status(400).json({ error: 'hostName required' });
  const room = db.createRoom(hostName);
  res.json({
    roomId: room.id,
    roomCode: room.code,
    hostName: room.hostName,
  });
});

// Get room state
router.get('/rooms/:roomId', (req, res) => {
  const room = db.getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json(room);
});

// Join room by code
router.post('/rooms/join', (req, res) => {
  const { code, guestName } = req.body;
  if (!code || !guestName) return res.status(400).json({ error: 'code and guestName required' });
  const room = db.getRoomByCode(code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const guestId = uuid();
  db.addGuest(room.id, guestId, guestName);
  res.json({
    roomId: room.id,
    roomCode: room.code,
    guestId,
    hostName: room.hostName,
    queue: room.queue,
    guests: room.guests,
  });
});

// ── YouTube search ──

router.post('/search/youtube', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });
  try {
    const results = await searchYouTube(query);
    res.json({ results });
  } catch (e) {
    log.error('YouTube search error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Queue / Song Pipeline ──

// Add song to queue + start pipeline
router.post('/rooms/:roomId/queue', async (req, res) => {
  const room = db.getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const { youtubeId, title, artist, thumbnail, duration, requestedBy, requestedByName } = req.body;
  if (!youtubeId || !title) return res.status(400).json({ error: 'youtubeId and title required' });

  // Add to queue
  const queueItem = db.addToQueue(room.id, {
    songId: youtubeId,
    title, artist, thumbnail, duration,
    requestedBy: requestedBy || 'host',
    requestedByName: requestedByName || room.hostName,
  });

  // Create job
  const job = db.createJob(room.id, queueItem.id, 'full_pipeline');
  queueItem.status = 'downloading';

  // Broadcast queue update immediately so all clients see the new song
  const io = require('../server').io;
  if (io) io.to(room.id).emit('queue:updated', { queue: room.queue });

  res.json({ queueItem, jobId: job.id });

  // Run pipeline in background (don't await in request handler)
  runPipeline(room.id, queueItem.id, job.id, youtubeId, title, artist);
});

// ── Upload audio file + add to queue ──
router.post('/rooms/:roomId/upload', upload.single('audio'), async (req, res) => {
  const room = db.getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (!req.file) return res.status(400).json({ error: 'No audio file uploaded' });

  const { title, artist, requestedBy, requestedByName } = req.body;
  const songTitle = title || path.basename(req.file.originalname, path.extname(req.file.originalname));
  const songArtist = artist || '';
  const uploadId = `upload_${uuid().slice(0, 8)}`;

  const queueItem = db.addToQueue(room.id, {
    songId: uploadId,
    title: songTitle,
    artist: songArtist,
    thumbnail: '',
    duration: null,
    requestedBy: requestedBy || 'host',
    requestedByName: requestedByName || room.hostName,
  });

  const job = db.createJob(room.id, queueItem.id, 'upload_pipeline');
  queueItem.status = 'downloading';

  const io = require('../server').io;
  if (io) io.to(room.id).emit('queue:updated', { queue: room.queue });
  res.json({ queueItem, jobId: job.id });

  runUploadPipeline(room.id, queueItem.id, job.id, req.file.path, songTitle, songArtist);
});

// Background pipeline for uploaded files
async function runUploadPipeline(roomId, queueItemId, jobId, audioPath, title, artist) {
  const io = require('../server').io;
  const room = db.getRoom(roomId);
  try {
    db.updateJob(jobId, { status: 'running', startedAt: Date.now() });
    db.updateQueueItemStatus(roomId, queueItemId, 'downloading');
    if (io && room) io.to(roomId).emit('queue:updated', { queue: room.queue });

    const { runpodPipeline } = require('../services/stemExtractor');
    if (typeof runpodPipeline === 'function') {
      runpodPipeline._onProgress = ({ phase, elapsed }) => {
        if (io) io.to(roomId).emit('job:progress', { queueItemId, jobId, phase, elapsed });
      };
    }

    const pipelineResult = await fullPipelineFromFile(audioPath, jobId);
    const { stems, chords, keyInfo, chordCount, midiPath } = pipelineResult;
    db.updateQueueItemStatus(roomId, queueItemId, 'ready', {
      stems,
      chords,
      keyInfo,
      chordCount,
      hasMidi: !!midiPath,
      jobId,
    });
    db.updateJob(jobId, { status: 'completed', completedAt: Date.now(), output: { stems, chordCount, keyInfo } });

    try {
      const lyrics = await fetchLyrics(title, artist);
      if (lyrics) {
        db.updateQueueItemStatus(roomId, queueItemId, 'ready', { lrcData: lyrics });
        log.info(`Lyrics found for uploaded "${title}"`);
      }
    } catch (e) {
      log.warn(`Lyrics fetch failed for uploaded "${title}":`, e.message);
    }

    if (io && room) {
      io.to(roomId).emit('queue:updated', { queue: db.getRoom(roomId).queue });
      io.to(roomId).emit('job:ready', { queueItemId, jobId });
    }
    log.info(`Upload pipeline complete for "${title}" (job ${jobId})`);
  } catch (e) {
    log.error(`Upload pipeline failed for "${title}" (job ${jobId}):`, e.message);
    db.updateQueueItemStatus(roomId, queueItemId, 'error');
    db.updateJob(jobId, { status: 'failed', error: e.message });
    if (io && room) {
      io.to(roomId).emit('queue:updated', { queue: db.getRoom(roomId)?.queue || [] });
      io.to(roomId).emit('job:error', { jobId, queueItemId, error: e.message });
    }
  }
}

// Background pipeline runner
async function runPipeline(roomId, queueItemId, jobId, youtubeId, title, artist) {
  const io = require('../server').io; // lazy require to avoid circular
  const room = db.getRoom(roomId);

  try {
    // Step 1: Download + separate
    db.updateJob(jobId, { status: 'running', startedAt: Date.now() });
    db.updateQueueItemStatus(roomId, queueItemId, 'downloading');
    if (io && room) io.to(roomId).emit('queue:updated', { queue: room.queue });

    // Set up progress callback to broadcast status to room
    const { runpodPipeline } = require('../services/stemExtractor');
    if (typeof runpodPipeline === 'function') {
      runpodPipeline._onProgress = ({ phase, elapsed }) => {
        if (io) {
          io.to(roomId).emit('job:progress', { queueItemId, jobId, phase, elapsed });
        }
      };
    }

    const pipelineResult = await fullPipeline(youtubeId, jobId);
    const { stems, chords, keyInfo, chordCount, midiPath } = pipelineResult;

    db.updateQueueItemStatus(roomId, queueItemId, 'ready', {
      stems,
      chords,
      keyInfo,
      chordCount,
      hasMidi: !!midiPath,
      jobId,
    });
    db.updateJob(jobId, { status: 'completed', completedAt: Date.now(), output: { stems, chordCount, keyInfo } });

    // Step 2: Fetch lyrics (parallel-ish, non-blocking)
    try {
      const lyrics = await fetchLyrics(title, artist);
      if (lyrics) {
        db.updateQueueItemStatus(roomId, queueItemId, 'ready', { lrcData: lyrics });
        log.info(`Lyrics found for "${title}"`);
      } else {
        log.warn(`No lyrics found for "${title}"`);
      }
    } catch (e) {
      log.warn(`Lyrics fetch failed for "${title}":`, e.message);
    }

    // Notify room
    if (io && room) {
      io.to(roomId).emit('queue:updated', { queue: db.getRoom(roomId).queue });
      io.to(roomId).emit('job:ready', { queueItemId, jobId });
    }

    log.info(`Pipeline complete for "${title}" (job ${jobId})`);
  } catch (e) {
    log.error(`Pipeline failed for "${title}" (job ${jobId}):`, e.message);
    db.updateQueueItemStatus(roomId, queueItemId, 'error');
    db.updateJob(jobId, { status: 'failed', error: e.message });
    if (io && room) {
      io.to(roomId).emit('queue:updated', { queue: db.getRoom(roomId)?.queue || [] });
      io.to(roomId).emit('job:error', { jobId, queueItemId, error: e.message });
    }
  }
}

// Get queue
router.get('/rooms/:roomId/queue', (req, res) => {
  const room = db.getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ queue: room.queue });
});

// Remove from queue
router.delete('/rooms/:roomId/queue/:itemId', (req, res) => {
  const ok = db.removeFromQueue(req.params.roomId, req.params.itemId);
  if (!ok) return res.status(404).json({ error: 'Item not found' });
  const room = db.getRoom(req.params.roomId);
  res.json({ queue: room.queue });
});

// ── Stem serving ──

router.get('/stems/:jobId/:stemName', (req, res) => {
  const stemPath = getStemPath(req.params.jobId, req.params.stemName);
  if (!stemPath) return res.status(404).json({ error: 'Stem not found' });
  const contentType = stemPath.endsWith('.ogg') ? 'audio/ogg' : 'audio/wav';
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(stemPath);
});

// ── Chord detection artifacts ──

router.get('/songs/:jobId/chords', (req, res) => {
  const p = getChordsPath(req.params.jobId);
  if (!p) return res.status(404).json({ error: 'Chords not found for this job' });
  res.setHeader('Cache-Control', 'public, max-age=3600');
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Failed to read chord file: ' + e.message });
  }
});

router.get('/songs/:jobId/midi', (req, res) => {
  const p = getMidiPath(req.params.jobId);
  if (!p) return res.status(404).json({ error: 'MIDI not found for this job' });
  res.setHeader('Content-Type', 'audio/midi');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.jobId}.mid"`);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(p);
});

// ── Job status ──

router.get('/jobs/:jobId', (req, res) => {
  const job = db.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ── Lyrics search (direct from LRCLIB) ──

router.post('/search/lyrics', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });
  try {
    const lyrics = await fetchLyrics(query, '');
    res.json({ lyrics });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
