const express = require('express');
const router = express.Router();
const { v4: uuid } = require('uuid');
const path = require('path');
const multer = require('multer');
const db = require('../models/inMemory');
const { searchYouTube } = require('../services/youtubeService');
const { fetchLyrics } = require('../services/lyricService');
const { fullPipeline, fullPipelineFromFile, getStemPath, getChordsPath, getMidiPath, regenerateChords } = require('../services/stemExtractor');
const fs = require('fs');
const config = require('../config');
const log = require('../utils/logger');
const songLibrary = require('../services/songLibrary');

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
    const { stems, chords, keyInfo, chordCount, midiPath, timingInfo } = pipelineResult;
    db.updateQueueItemStatus(roomId, queueItemId, 'ready', {
      stems,
      chords,
      keyInfo,
      chordCount,
      timingInfo,
      hasMidi: !!midiPath,
      jobId,
    });
    db.updateJob(jobId, { status: 'completed', completedAt: Date.now(), output: { stems, chordCount, keyInfo, timingInfo } });

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
    // Save to song library for chord regeneration later
    songLibrary.upsert(jobId, { title, artist, stems, keyInfo, timingInfo, chordCount, hasMidi: !!midiPath });

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
    const { stems, chords, keyInfo, chordCount, midiPath, timingInfo } = pipelineResult;

    db.updateQueueItemStatus(roomId, queueItemId, 'ready', {
      stems,
      chords,
      keyInfo,
      chordCount,
      timingInfo,
      hasMidi: !!midiPath,
      jobId,
    });
    db.updateJob(jobId, { status: 'completed', completedAt: Date.now(), output: { stems, chordCount, keyInfo, timingInfo } });

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

    // Save to song library for chord regeneration later
    songLibrary.upsert(jobId, { title, artist, stems, keyInfo, timingInfo, chordCount, hasMidi: !!midiPath });

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

// Human-readable chord chart — plain text. Shows chords with timing + bar
// grouping (if time signature is known). Great for a quick glance or for
// a musician to print out and play along with.
router.get('/songs/:jobId/chart.txt', (req, res) => {
  const p = getChordsPath(req.params.jobId);
  if (!p) return res.status(404).send('Chord chart not found for this job');
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const chords = data.chords_quantized || data.chords || [];
    const keyInfo = data.key_info;
    const timing = data.timing_info;

    const lines = [];
    lines.push(`Chord Chart — job ${req.params.jobId}`);
    lines.push('='.repeat(50));
    if (keyInfo && keyInfo.key) {
      lines.push(`Key: ${keyInfo.key} ${keyInfo.mode} (confidence ${keyInfo.confidence})`);
    }
    if (timing && timing.tempo_bpm) {
      lines.push(`Tempo: ${Math.round(timing.tempo_bpm)} BPM · Time signature: ${timing.time_signature || 'unknown'}`);
    }
    lines.push(`Total chord segments: ${chords.length}`);
    lines.push('');
    lines.push('Time          Duration  Chord');
    lines.push('-'.repeat(50));

    function fmtTime(s) {
      const m = Math.floor(s / 60);
      const sec = (s % 60).toFixed(2).padStart(5, '0');
      return `${m}:${sec}`;
    }

    for (const c of chords) {
      const dur = (c.end - c.start).toFixed(2);
      lines.push(`${fmtTime(c.start).padEnd(13)} ${dur.padStart(6)}s   ${c.chord}`);
    }

    // Bar-grouped view at the end, if we have timing info
    if (timing && timing.downbeats && timing.downbeats.length > 1) {
      lines.push('');
      lines.push('Bar-by-bar view');
      lines.push('-'.repeat(50));
      const downbeats = timing.downbeats;
      for (let i = 0; i < downbeats.length; i++) {
        const barStart = downbeats[i];
        const barEnd = i + 1 < downbeats.length ? downbeats[i + 1] : (chords.length ? chords[chords.length - 1].end : barStart + 2);
        // Chords that intersect this bar
        const barChords = chords.filter(c => c.start < barEnd && c.end > barStart);
        const labels = barChords.map(c => c.chord).filter((v, idx, arr) => idx === 0 || v !== arr[idx - 1]);
        lines.push(`Bar ${(i + 1).toString().padStart(3)} [${fmtTime(barStart)}]  | ${labels.join(' | ')} |`);
      }
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.jobId}_chart.txt"`);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(lines.join('\n'));
  } catch (e) {
    res.status(500).send('Failed to build chart: ' + e.message);
  }
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


// ── Song Library (cached stems for chord regeneration) ──

// List all processed songs
router.get('/library', (req, res) => {
  const songs = songLibrary.list();
  res.json({ songs });
});

// Get a single library entry
router.get('/library/:jobId', (req, res) => {
  const song = songLibrary.get(req.params.jobId);
  if (!song) return res.status(404).json({ error: 'Song not found in library' });
  res.json(song);
});

// Regenerate chords for a cached song (skips Demucs)
router.post('/library/:jobId/regenerate', async (req, res) => {
  const song = songLibrary.get(req.params.jobId);
  if (!song) return res.status(404).json({ error: 'Song not found in library' });

  // Verify stems exist on disk
  const missingStems = Object.entries(song.stemPaths || {})
    .filter(([_, p]) => !fs.existsSync(p));
  if (missingStems.length > 0) {
    return res.status(400).json({
      error: 'Some stems are missing from disk',
      missing: missingStems.map(([name]) => name),
    });
  }

  res.json({ status: 'started', jobId: req.params.jobId, message: 'Regenerating chords (Demucs skipped)...' });

  // Run in background
  try {
    const result = await regenerateChords(req.params.jobId, song.stemPaths);
    // Update library entry with new chord info
    songLibrary.upsert(req.params.jobId, {
      title: song.title,
      artist: song.artist,
      stems: song.stemPaths,
      keyInfo: result.keyInfo,
      timingInfo: result.timingInfo,
      chordCount: result.chordCount,
      hasMidi: !!result.midiPath,
    });
    log.info(`Library: regenerated chords for "${song.title}" → ${result.chordCount} chords`);
  } catch (e) {
    log.error(`Library: regenerate failed for "${song.title}": ${e.message}`);
  }
});

// Delete a song from the library
router.delete('/library/:jobId', (req, res) => {
  const ok = songLibrary.remove(req.params.jobId);
  if (!ok) return res.status(404).json({ error: 'Song not found' });
  res.json({ status: 'deleted' });
});

module.exports = router;
