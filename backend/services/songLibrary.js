/**
 * Song Library — persistent catalog of all processed songs.
 * Stores metadata + references to cached stems on disk so we can
 * re-run the chord pipeline without re-running Demucs.
 *
 * Backed by a simple JSON file (library.json) in the storage dir.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const log = require('../utils/logger');

const LIBRARY_PATH = path.resolve(config.storage.stemsDir, '..', 'library.json');

let library = []; // array of song entries

function load() {
  try {
    if (fs.existsSync(LIBRARY_PATH)) {
      library = JSON.parse(fs.readFileSync(LIBRARY_PATH, 'utf-8'));
      log.info(`Song library loaded: ${library.length} songs from ${LIBRARY_PATH}`);
    }
  } catch (e) {
    log.warn(`Failed to load song library: ${e.message}`);
    library = [];
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(LIBRARY_PATH), { recursive: true });
    fs.writeFileSync(LIBRARY_PATH, JSON.stringify(library, null, 2));
  } catch (e) {
    log.warn(`Failed to save song library: ${e.message}`);
  }
}

/**
 * Add or update a song in the library after successful pipeline completion.
 */
function upsert(jobId, { title, artist, stems, keyInfo, timingInfo, chordCount, hasMidi }) {
  // Build stem paths map (relative check — stems are already saved on disk)
  const stemPaths = {};
  if (stems && typeof stems === 'object') {
    for (const [name, filePath] of Object.entries(stems)) {
      if (fs.existsSync(filePath)) {
        stemPaths[name] = filePath;
      }
    }
  }

  const existing = library.find(s => s.jobId === jobId);
  const entry = {
    jobId,
    title: title || 'Unknown',
    artist: artist || '',
    processedAt: new Date().toISOString(),
    stemPaths,
    keyInfo: keyInfo || null,
    timingInfo: timingInfo ? {
      tempo_bpm: timingInfo.tempo_bpm,
      time_signature: timingInfo.time_signature,
      beat_confidence: timingInfo.beat_confidence,
    } : null,
    chordCount: chordCount || 0,
    hasMidi: !!hasMidi,
  };

  if (existing) {
    Object.assign(existing, entry);
  } else {
    library.unshift(entry); // newest first
  }

  save();
  log.info(`Library: ${existing ? 'updated' : 'added'} "${title}" (job ${jobId}, ${Object.keys(stemPaths).length} stems cached)`);
  return entry;
}

/**
 * Get a song entry by jobId.
 */
function get(jobId) {
  return library.find(s => s.jobId === jobId) || null;
}

/**
 * List all songs in the library (newest first).
 */
function list() {
  // Verify stems still exist on disk
  return library.map(entry => ({
    ...entry,
    stemsAvailable: Object.values(entry.stemPaths || {}).every(p => fs.existsSync(p)),
  }));
}

/**
 * Remove a song from the library.
 */
function remove(jobId) {
  const idx = library.findIndex(s => s.jobId === jobId);
  if (idx >= 0) {
    library.splice(idx, 1);
    save();
    return true;
  }
  return false;
}

// Load on startup
load();

module.exports = { upsert, get, list, remove, load };
