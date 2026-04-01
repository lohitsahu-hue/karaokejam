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

// Clean YouTube title to extract just the song name
function cleanTitle(raw) {
  if (!raw) return '';
  let t = raw;
  // Remove common YouTube suffixes/prefixes in parens/brackets
  t = t.replace(/\s*[\(\[](official\s*(music\s*)?video|full\s*video|lyric\s*video|audio|hd|hq|4k|1080p|visualizer|mv|ft\.?[^)\]]*|feat\.?[^)\]]*|video\s*song|with\s*lyrics)[\)\]]/gi, '');
  // Remove text after pipes (usually movie/channel info)
  t = t.replace(/\s*[|].*$/g, '');
  // Remove "Full Video - MovieName" pattern
  t = t.replace(/\s*full\s*video\s*[-–—]\s*.*/gi, '');
  // Remove "Full Song" / "Full Video Song" / "Full Audio" / "Video Song"
  t = t.replace(/\s*(full\s+)?(video\s+)?song(\s+video)?/gi, '');
  t = t.replace(/\s*full\s+audio/gi, '');
  // Remove "Lyrical Video", "Lyrical", "With Lyrics", "Lyrics Video" etc.
  t = t.replace(/\s*lyrical(\s+video)?/gi, '');
  t = t.replace(/\s*(with\s+)?lyrics\s*(video)?/gi, '');
  // Remove "HD", "HQ", "4K", "1080p" standalone
  t = t.replace(/\s*\b(hd|hq|4k|1080p|720p)\b\s*/gi, '');
  // Remove actor/cast names after pipe or dash (e.g. "| Ranveer Singh, Sonakshi Sinha")
  // Already handled by pipe removal above
  // Remove trailing " - Artist Name" if it looks like channel/meta info
  t = t.replace(/\s*[-–—]\s*(official|lyric|audio|video|full|hd|hq|visuali).*/gi, '');
  // Remove emojis and special unicode
  t = t.replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FEFF}]/gu, '');
  // Remove quotes
  t = t.replace(/["""'']/g, '');
  // Collapse whitespace
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

// Extract artist from YouTube channel name or title
function cleanArtist(artist, title) {
  if (!artist) return '';
  let a = artist;
  // Remove "- Topic" suffix from YouTube Music auto-generated channels
  a = a.replace(/\s*-\s*Topic$/i, '');
  // Remove "VEVO" suffix
  a = a.replace(/VEVO$/i, '').trim();
  return a;
}

// Auto-fetch best matching lyrics for a song
async function fetchLyrics(title, artist) {
  const cleaned = cleanTitle(title);
  const cleanedArtist = cleanArtist(artist, title);

  // Try multiple query strategies from specific to broad
  const queries = [];
  if (cleanedArtist && cleaned) queries.push(`${cleaned} ${cleanedArtist}`);
  if (cleaned) queries.push(cleaned);
  // Also try first part before dash (often "Artist - Song" format)
  const dashParts = cleaned.split(/\s*[-–—]\s*/);
  if (dashParts.length >= 2) {
    queries.push(dashParts[1]); // song name
    queries.push(`${dashParts[1]} ${dashParts[0]}`); // song + artist
  }
  // Fallback: raw title (first 40 chars)
  if (title && title !== cleaned) queries.push(title.substring(0, 40));

  log.info(`Lyrics search queries: ${JSON.stringify(queries)}`);

  for (const q of queries) {
    try {
      const results = await searchLyrics(q);
      if (results.length > 0) {
        const best = results[0];
        log.info(`Lyrics found: "${best.title}" by ${best.artist} (query: "${q}")`);
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