// ═══════════════════════════════════════════════════════════════════
// Lyrics Engine — LRC parser, LRCLIB search, Hindi transliteration,
//                  auto-sync via vocal onset detection
// Ported from karaoke-mixer.html prototype.
// ═══════════════════════════════════════════════════════════════════

'use strict';

// ── LRC Parser ──
function parseLRC(text) {
  const lines = text.split('\n');
  const result = [];
  for (const line of lines) {
    const m = line.match(/^\[(\d{2}):(\d{2})\.(\d{2,3})\]\s*(.*)$/);
    if (!m) continue;
    const min = parseInt(m[1]), sec = parseInt(m[2]);
    let ms = parseInt(m[3]); if (m[3].length === 2) ms *= 10;
    const time = min * 60 + sec + ms / 1000;
    const txt = m[4].trim();
    if (txt) result.push({ time, text: txt });
  }
  result.sort((a, b) => a.time - b.time);
  return result;
}


// ── Hindi (Devanagari) → Romanized Transliteration ──
const _DEV_VOWELS = {
  '\u0905':'a','\u0906':'aa','\u0907':'i','\u0908':'ee','\u0909':'u','\u090A':'oo',
  '\u090B':'ri','\u090F':'e','\u0910':'ai','\u0913':'o','\u0914':'au'
};
const _DEV_MATRAS = {
  '\u093E':'aa','\u093F':'i','\u0940':'ee','\u0941':'u','\u0942':'oo',
  '\u0943':'ri','\u0947':'e','\u0948':'ai','\u094B':'o','\u094C':'au'
};
const _DEV_CONS = {
  '\u0915':'k','\u0916':'kh','\u0917':'g','\u0918':'gh','\u0919':'ng',
  '\u091A':'ch','\u091B':'chh','\u091C':'j','\u091D':'jh','\u091E':'ny',
  '\u091F':'t','\u0920':'th','\u0921':'d','\u0922':'dh','\u0923':'n',
  '\u0924':'t','\u0925':'th','\u0926':'d','\u0927':'dh','\u0928':'n',
  '\u092A':'p','\u092B':'ph','\u092C':'b','\u092D':'bh','\u092E':'m',
  '\u092F':'y','\u0930':'r','\u0932':'l','\u0935':'v',
  '\u0936':'sh','\u0937':'sh','\u0938':'s','\u0939':'h'
};
const _DEV_NUQTA = {
  '\u0915\u093C':'q','\u0916\u093C':'kh','\u0917\u093C':'gh',
  '\u091C\u093C':'z','\u092B\u093C':'f','\u0921\u093C':'r','\u0922\u093C':'rh'
};
const HALANT = '\u094D';
const NUQTA = '\u093C';
const _DEV_NASAL = {'\u0902':'n','\u0901':'n','\u0903':'h'};

function isDevanagari(text) { return /[\u0900-\u097F]/.test(text); }

function transliterateHindi(text) {
  let out = '';
  let i = 0;
  const len = text.length;
  while (i < len) {
    const ch = text[i];
    const next = i + 1 < len ? text[i + 1] : '';

    if (_DEV_NUQTA[ch + next]) {
      let cons = _DEV_NUQTA[ch + next];
      i += 2;
      if (text[i] === HALANT) { out += cons; i++; }
      else if (_DEV_MATRAS[text[i]]) { out += cons + _DEV_MATRAS[text[i]]; i++; }
      else { out += cons + 'a'; }
    }
    else if (_DEV_CONS[ch]) {
      let cons = _DEV_CONS[ch];
      i++;
      if (text[i] === NUQTA) i++;
      if (text[i] === HALANT) { out += cons; i++; }
      else if (_DEV_MATRAS[text[i]]) { out += cons + _DEV_MATRAS[text[i]]; i++; }
      else { out += cons + 'a'; }
    }
    else if (_DEV_VOWELS[ch]) { out += _DEV_VOWELS[ch]; i++; }
    else if (_DEV_NASAL[ch]) { out += _DEV_NASAL[ch]; i++; }
    else if (ch === HALANT || ch === NUQTA) { i++; }
    else { out += ch; i++; }
  }
  // Schwa deletion at word boundaries (Hindi convention)
  out = out.replace(/a(\s|$|,|।|!|\?|\.)/g, '$1');
  return out;
}


// ── LRCLIB API Client ──
async function searchLRCLIB(query) {
  const url = 'https://lrclib.net/api/search?q=' + encodeURIComponent(query);
  const res = await fetch(url);
  if (!res.ok) throw new Error('LRCLIB search failed: ' + res.status);
  return res.json();
}


// ── Auto-Sync: detect vocal onset to align lyrics ──
function autoSyncLyrics(lyricsLines, stemBuffers) {
  if (!lyricsLines || lyricsLines.length === 0) return 0;
  if (!stemBuffers || stemBuffers.length === 0) return 0;

  // Find vocal stem, fall back to first stem
  let vi = stemBuffers.findIndex(s => /vocal/i.test(s.name));
  if (vi < 0) vi = 0;

  const buf = stemBuffers[vi].buf;
  const sr = buf.sampleRate;
  const ch = buf.getChannelData(0);

  // Compute RMS energy in 0.3s windows
  const W = 0.3;
  const ws = Math.round(sr * W);
  const nw = Math.floor(ch.length / ws);
  const E = new Float64Array(nw);

  for (let w = 0; w < nw; w++) {
    let sum = 0;
    const off = w * ws;
    for (let i = 0; i < ws; i++) { const v = ch[off + i]; sum += v * v; }
    E[w] = Math.sqrt(sum / ws);
  }

  // Percentile-based threshold
  const sorted = Array.from(E).sort((a, b) => a - b);
  const p25 = sorted[Math.floor(nw * 0.25)];
  const p75 = sorted[Math.floor(nw * 0.75)];
  const threshold = p25 + (p75 - p25) * 0.35;

  // Find first sustained vocal onset: 4+ consecutive windows (1.2s)
  const runNeeded = 4;
  let audioOnsetWin = -1;
  let run = 0;
  for (let w = 0; w < nw; w++) {
    if (E[w] > threshold) {
      run++;
      if (run >= runNeeded) {
        audioOnsetWin = w - runNeeded + 1;
        break;
      }
    } else {
      run = 0;
    }
  }

  if (audioOnsetWin < 0) return 0;

  const audioOnsetSec = audioOnsetWin * W;
  const firstLyricSec = lyricsLines[0].time;

  // Round to 0.5s
  const offset = Math.round((audioOnsetSec - firstLyricSec) * 2) / 2;
  console.log(`Auto-sync: onset=${audioOnsetSec.toFixed(1)}s, firstLyric=${firstLyricSec.toFixed(1)}s, offset=${offset}s`);
  return offset;
}


// ── Script detection for language filtering ──
function isArabicUrdu(text) { return /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text); }
function isLatin(text) { return /[a-zA-Z]/.test(text); }

/**
 * Score a synced lyrics result by script preference.
 * Higher = better. We prefer: Latin (English) > Devanagari (Hindi) > other > Arabic/Urdu
 */
function scoreLyricsScript(syncedLRC) {
  if (!syncedLRC) return -1;
  // Sample a few lines to detect script
  const lines = syncedLRC.split('\n').filter(l => l.match(/^\[/)).slice(0, 10);
  const text = lines.map(l => l.replace(/^\[.*?\]\s*/, '')).join(' ');

  if (isArabicUrdu(text)) return 0;       // Urdu/Arabic — lowest priority
  if (isDevanagari(text)) return 2;        // Hindi Devanagari — great
  if (isLatin(text)) return 3;             // English/Romanized — best
  return 1;                                // Other scripts
}

/**
 * Compute relevance score: how well does this LRCLIB result match the query?
 * Returns 0-1 based on word overlap between query and trackName+artistName.
 */
function scoreRelevance(result, query) {
  if (!query) return 0.5; // no query to compare — neutral
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 1);
  if (queryWords.length === 0) return 0.5;

  const target = ((result.trackName || '') + ' ' + (result.artistName || '') + ' ' + (result.albumName || '')).toLowerCase();

  let matches = 0;
  for (const word of queryWords) {
    if (target.includes(word)) matches++;
  }
  return matches / queryWords.length;
}

/**
 * Pick the best synced lyrics result from LRCLIB results.
 * Filters out Urdu/Arabic, prefers results that match the query, then English > Hindi > other.
 */
function pickBestLyrics(results, query) {
  const candidates = results
    .filter(r => r.syncedLyrics && r.syncedLyrics.trim().length > 0)
    .map(r => ({
      result: r,
      scriptScore: scoreLyricsScript(r.syncedLyrics),
      relevance: scoreRelevance(r, query),
    }))
    .filter(c => c.scriptScore > 0)  // exclude Arabic/Urdu
    // Sort: relevance first (must have >0 word matches), then script score
    .sort((a, b) => {
      // Bucket relevance: high (>=0.5), medium (>0), none (0)
      const relA = a.relevance >= 0.5 ? 2 : a.relevance > 0 ? 1 : 0;
      const relB = b.relevance >= 0.5 ? 2 : b.relevance > 0 ? 1 : 0;
      if (relA !== relB) return relB - relA;  // higher relevance wins
      return b.scriptScore - a.scriptScore;   // then prefer English > Hindi
    });

  if (candidates.length > 0) {
    const best = candidates[0];
    console.log(`[Lyrics] Picked: "${best.result.trackName}" by ${best.result.artistName} (relevance=${best.relevance.toFixed(2)}, script=${best.scriptScore})`);
  }

  return candidates.length > 0 ? candidates[0].result : null;
}


// ── Public API ──
const LyricsEngine = {
  parseLRC,
  isDevanagari,
  transliterateHindi,
  searchLRCLIB,
  autoSyncLyrics,
  pickBestLyrics,

  // Process raw LRC text into enriched lines with transliteration
  processLRC(lrcText) {
    const lines = parseLRC(lrcText);
    for (const line of lines) {
      line.roman = isDevanagari(line.text) ? transliterateHindi(line.text) : '';
    }
    return lines;
  },

  // Find the current lyric line index for a given time
  findLineIndex(lines, timeSec, offset) {
    if (!lines || lines.length === 0) return -1;
    const adjusted = timeSec - (offset || 0);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (adjusted >= lines[i].time) return i;
    }
    return -1;
  },
};
