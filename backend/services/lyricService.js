const https = require('https');
const log = require('../utils/logger');

// Search LRCLIB for synced lyrics
function searchLyrics(query) {
  return new Promise((resolve, reject) => {
    const url = `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`;

    https.get(url, { headers: { 'User-Agent': 'KaraokePartyApp/0.1' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const results = JSON.parse(data);
          // Filter to only those with synced lyrics
          const synced = results
            .filter(r => r.syncedLyrics)
            .map(r => ({
              id: r.id,
              title: r.trackName,
              artist: r.artistName,
              album: r.albumName,
              duration: r.duration,
              syncedLyrics: r.syncedLyrics,
            }));
          log.debug(`LRCLIB: "${query}" → ${synced.length} synced results`);
          resolve(synced);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Parse LRC format into [{time, text}]
function parseLRC(lrcText) {
  const lines = [];
  for (const line of lrcText.split('\n')) {
    const m = line.match(/^\[(\d{2}):(\d{2})\.(\d{2,3})\]\s*(.*)/);
    if (m) {
      const time = parseInt(m[1]) * 60 + parseInt(m[2]) + parseInt(m[3]) / (m[3].length === 3 ? 1000 : 100);
      const text = m[4].trim();
      if (text) lines.push({ time, text });
    }
  }
  return lines;
}

// Auto-fetch best matching lyrics for a song
async function fetchLyrics(title, artist) {
  const queries = [
    `${title} ${artist}`,
    title,
  ];

  for (const q of queries) {
    try {
      const results = await searchLyrics(q);
      if (results.length > 0) {
        const best = results[0];
        return {
          title: best.title,
          artist: best.artist,
          lines: parseLRC(best.syncedLyrics),
          rawLRC: best.syncedLyrics,
        };
      }
    } catch (e) {
      log.warn(`LRCLIB search failed for "${q}":`, e.message);
    }
  }
  return null;
}

module.exports = { searchLyrics, parseLRC, fetchLyrics };