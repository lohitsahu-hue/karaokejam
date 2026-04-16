const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const log = require('../utils/logger');

// Ensure storage dirs exist
function ensureDirs() {
  fs.mkdirSync(config.storage.stemsDir, { recursive: true });
  fs.mkdirSync(config.storage.downloadsDir, { recursive: true });
  if (config.storage.chordsDir) fs.mkdirSync(config.storage.chordsDir, { recursive: true });
  if (config.storage.midiDir) fs.mkdirSync(config.storage.midiDir, { recursive: true });
}

/**
 * Save chord JSON + MIDI + timing info returned by the RunPod handler.
 * Returns { chordsPath, midiPath, keyInfo, chordCount, timingInfo }.
 */
function saveChordArtifacts(jobId, output) {
  const result = {
    chordsPath: null,
    midiPath: null,
    keyInfo: null,
    chordCount: 0,
    timingInfo: null,
  };
  try {
    const hasChords = Array.isArray(output.chords) && output.chords.length > 0;
    const hasTiming = !!output.timing_info;
    if (hasChords || hasTiming) {
      fs.mkdirSync(config.storage.chordsDir, { recursive: true });
      const chordsPath = path.join(config.storage.chordsDir, `${jobId}.json`);
      fs.writeFileSync(chordsPath, JSON.stringify({
        chords: output.chords || [],
        chords_quantized: output.chords_quantized || null,
        key_info: output.key_info || null,
        timing_info: output.timing_info || null,
        generated_at: new Date().toISOString(),
      }, null, 2));
      result.chordsPath = chordsPath;
      result.chordCount = hasChords ? output.chords.length : 0;
      log.info(`Chords+timing: saved ${result.chordCount} chords + timing=${hasTiming} → ${chordsPath}`);
    }
    if (output.chord_midi_base64) {
      fs.mkdirSync(config.storage.midiDir, { recursive: true });
      const midiPath = path.join(config.storage.midiDir, `${jobId}.mid`);
      fs.writeFileSync(midiPath, Buffer.from(output.chord_midi_base64, 'base64'));
      result.midiPath = midiPath;
      log.info(`MIDI: saved ${fs.statSync(midiPath).size} bytes → ${midiPath}`);
    }
    if (output.key_info) {
      result.keyInfo = output.key_info;
      log.info(`Key: ${output.key_info.key} ${output.key_info.mode} (conf=${output.key_info.confidence})`);
    }
    if (output.timing_info) {
      result.timingInfo = output.timing_info;
      const ti = output.timing_info;
      log.info(`Timing: ${ti.tempo_bpm} BPM, ${ti.time_signature}, ${(ti.beats || []).length} beats (conf=${ti.beat_confidence})`);
    }
  } catch (e) {
    log.warn(`saveChordArtifacts failed: ${e.message}`);
  }
  return result;
}

// ─────────────────────────────────────────────
//  LOCAL MODE (yt-dlp + Demucs on this machine)
// ─────────────────────────────────────────────

async function downloadYouTube(youtubeId, jobId) {
  ensureDirs();
  const outPath = path.join(config.storage.downloadsDir, `${jobId}.wav`);

  // Write YouTube cookies to file if available (bypasses bot detection on server IPs)
  const cookiesPath = path.join(config.storage.downloadsDir, 'yt_cookies.txt');
  if (process.env.YT_COOKIES_B64 && !fs.existsSync(cookiesPath)) {
    try {
      const cookieData = Buffer.from(process.env.YT_COOKIES_B64, 'base64').toString('utf-8');
      fs.writeFileSync(cookiesPath, cookieData);
      log.info(`yt-dlp: wrote YouTube cookies file (${cookieData.length} bytes)`);
    } catch (e) {
      log.warn(`yt-dlp: failed to write cookies file: ${e.message}`);
    }
  }

  // yt-dlp with cookies + EJS challenge solver
  return new Promise((resolve, reject) => {
    const url = `https://www.youtube.com/watch?v=${youtubeId}`;
    const args = [
      '--js-runtimes', 'node',
      '--remote-components', 'ejs:github',
      '--extractor-args', 'youtube:player_client=web',
    ];
    // Add cookies if available
    if (fs.existsSync(cookiesPath)) {
      args.push('--cookies', cookiesPath);
      log.info('yt-dlp: using YouTube cookies');
    }
    args.push(
      '-x',
      '--audio-format', 'wav',
      '--audio-quality', '0',
      '-o', outPath,
      '--no-playlist',
      url,
    );
    log.info(`yt-dlp: downloading ${youtubeId}...`);
    const proc = spawn('python3', ['-m', 'yt_dlp', ...args]);

    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.stdout.on('data', d => { log.debug('yt-dlp:', d.toString().trim()); });

    proc.on('close', (code) => {
      if (code !== 0) {
        log.error(`yt-dlp failed (code ${code}):`, stderr);
        return reject(new Error(`yt-dlp exited with code ${code}: ${stderr.slice(-200)}`));
      }
      if (fs.existsSync(outPath)) {
        log.info(`yt-dlp: downloaded → ${outPath}`);
        return resolve(outPath);
      }
      const files = fs.readdirSync(config.storage.downloadsDir);
      const match = files.find(f => f.startsWith(jobId));
      if (match) {
        const fullPath = path.join(config.storage.downloadsDir, match);
        log.info(`yt-dlp: downloaded → ${fullPath}`);
        return resolve(fullPath);
      }
      reject(new Error('yt-dlp: output file not found'));
    });

    proc.on('error', (err) => {
      reject(new Error(`python3/yt-dlp not found: ${err.message}`));
    });
  });
}

function separateStems(audioPath, jobId) {
  const outDir = path.join(config.storage.stemsDir, jobId);
  fs.mkdirSync(outDir, { recursive: true });

  return new Promise((resolve, reject) => {
    // Full 4-stem mode (no --two-stems)
    const args = [
      '-n', config.demucs.model,
      '--out', outDir,
      audioPath,
    ];

    log.info(`Demucs: separating 4 stems for job ${jobId}...`);
    const proc = spawn('python3', ['-m', 'demucs', ...args]);

    let stderr = '';
    proc.stderr.on('data', d => {
      const line = d.toString().trim();
      if (line) log.debug('Demucs:', line);
      stderr += line + '\n';
    });
    proc.stdout.on('data', d => { log.debug('Demucs:', d.toString().trim()); });

    proc.on('close', (code) => {
      if (code !== 0) {
        log.error(`Demucs failed (code ${code})`);
        return reject(new Error(`Demucs exited with code ${code}`));
      }

      const modelDir = path.join(outDir, config.demucs.model);
      if (!fs.existsSync(modelDir)) {
        return reject(new Error('Demucs output directory not found'));
      }
      const songDirs = fs.readdirSync(modelDir);
      if (songDirs.length === 0) {
        return reject(new Error('Demucs produced no output'));
      }

      const stemDir = path.join(modelDir, songDirs[0]);
      const stemFiles = fs.readdirSync(stemDir);
      const stems = {};
      for (const f of stemFiles) {
        const name = path.basename(f, path.extname(f));
        stems[name] = path.join(stemDir, f);
      }

      log.info(`Demucs: done → ${Object.keys(stems).join(', ')}`);
      resolve(stems);
    });

    proc.on('error', (err) => {
      reject(new Error(`python3/demucs not found: ${err.message}`));
    });
  });
}

/**
 * Mid-side split: extract lead (center) and backing (sides) from vocals.
 * Uses ffmpeg pan filter. Requires stereo input.
 */
function midSideSplit(vocalsPath, outputDir) {
  const leadPath = path.join(outputDir, 'lead_vocals.wav');
  const backingPath = path.join(outputDir, 'backing_vocals.wav');

  return new Promise((resolve, reject) => {
    // Mid: (L+R)/2
    const midProc = spawn('ffmpeg', [
      '-y', '-i', vocalsPath,
      '-af', 'pan=mono|c0=0.5*c0+0.5*c1',
      leadPath,
    ]);

    let midErr = '';
    midProc.stderr.on('data', d => { midErr += d.toString(); });

    midProc.on('close', (code) => {
      if (code !== 0) {
        log.warn('Mid-side: mid extraction failed, using full vocals as lead');
        try { fs.copyFileSync(vocalsPath, leadPath); } catch (e) {}
      }

      // Side: (L-R)/2
      const sideProc = spawn('ffmpeg', [
        '-y', '-i', vocalsPath,
        '-af', 'pan=mono|c0=0.5*c0-0.5*c1',
        backingPath,
      ]);

      let sideErr = '';
      sideProc.stderr.on('data', d => { sideErr += d.toString(); });

      sideProc.on('close', (sideCode) => {
        if (sideCode !== 0) {
          log.warn('Mid-side: side extraction failed');
        }

        const result = {};
        if (fs.existsSync(leadPath)) result.lead_vocals = leadPath;
        if (fs.existsSync(backingPath)) result.backing_vocals = backingPath;

        log.info(`Mid-side split: ${Object.keys(result).join(', ')}`);
        resolve(result);
      });
      sideProc.on('error', () => resolve({}));
    });

    midProc.on('error', () => resolve({}));
  });
}

async function localPipeline(youtubeId, jobId) {
  const audioPath = await downloadYouTube(youtubeId, jobId);
  const stems = await separateStems(audioPath, jobId);

  // Mid-side split on vocals
  if (stems.vocals) {
    const stemDir = path.dirname(stems.vocals);
    const splits = await midSideSplit(stems.vocals, stemDir);
    delete stems.vocals;
    Object.assign(stems, splits);
  }

  try { fs.unlinkSync(audioPath); } catch (e) { /* ignore */ }
  // Local mode doesn't do chord detection — return the same shape with nulls
  return { stems, chords: null, chordsPath: null, midiPath: null, keyInfo: null, chordCount: 0 };
}

// ─────────────────────────────────────────────
//  RUNPOD MODE (serverless GPU endpoint)
// ─────────────────────────────────────────────

async function runpodPipeline(youtubeId, jobId) {
  ensureDirs();

  const { apiKey, endpointId } = config.runpod;
  if (!apiKey || !endpointId) {
    throw new Error('RunPod API key and endpoint ID are required. Set RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID in .env');
  }
  const baseUrl = `https://api.runpod.ai/v2/${endpointId}`;
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  // 1. Download audio locally first (avoids YouTube bot detection on RunPod datacenter IPs)
  log.info(`RunPod: downloading audio for ${youtubeId} locally...`);
  if (runpodPipeline._onProgress) {
    runpodPipeline._onProgress({ phase: 'Downloading audio...', elapsed: 0, status: 'DOWNLOADING' });
  }
  const audioPath = await downloadYouTube(youtubeId, jobId);
  const audioBuffer = fs.readFileSync(audioPath);
  const audioBase64 = audioBuffer.toString('base64');
  log.info(`RunPod: audio downloaded (${(audioBuffer.length / 1024 / 1024).toFixed(1)} MB), sending to GPU...`);

  // Clean up local audio file
  try { fs.unlinkSync(audioPath); } catch (e) { /* ignore */ }

  // 2. Submit the job with audio data
  log.info(`RunPod: submitting job ${jobId} with audio data...`);
  const submitRes = await fetch(`${baseUrl}/run`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      input: {
        audio_base64: audioBase64,
        job_id: jobId,
        model: config.demucs.model,
      },
    }),
  });

  if (!submitRes.ok) {
    const errText = await submitRes.text();
    throw new Error(`RunPod submit failed (${submitRes.status}): ${errText}`);
  }

  const submitData = await submitRes.json();
  const runpodJobId = submitData.id;
  log.info(`RunPod: job submitted → ${runpodJobId}`);

  // 2. Poll for completion
  const POLL_INTERVAL = 5000;
  const MAX_WAIT = 10 * 60 * 1000;
  const startTime = Date.now();
  while (Date.now() - startTime < MAX_WAIT) {
    await sleep(POLL_INTERVAL);

    let statusRes;
    try {
      statusRes = await fetch(`${baseUrl}/status/${runpodJobId}`, { headers });
    } catch (fetchErr) {
      log.warn(`RunPod: status fetch error: ${fetchErr.message}`);
      continue;
    }
    if (!statusRes.ok) {
      const errBody = await statusRes.text().catch(() => '');
      log.warn(`RunPod: status check failed (${statusRes.status}): ${errBody}`);
      continue;
    }

    const statusData = await statusRes.json();
    const status = statusData.status;

    if (status === 'IN_QUEUE' || status === 'IN_PROGRESS') {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const phase = status === 'IN_QUEUE' ? 'Waiting for GPU...' : 'Separating stems...';
      log.info(`RunPod: ${status} (${elapsed}s elapsed)...`);
      // Emit progress event if callback provided
      if (runpodPipeline._onProgress) {
        runpodPipeline._onProgress({ phase, elapsed, status });
      }
      continue;
    }

    if (status === 'COMPLETED') {
      const output = statusData.output;

      // Guard: RunPod may strip output if payload exceeds ~20 MB
      if (!output) {
        throw new Error(
          'RunPod job completed but returned no output (payload likely exceeded 20 MB limit). ' +
          'Try a shorter song or check that the handler encodes stems as mono OGG.'
        );
      }

      if (output.error) {
        throw new Error(`RunPod job error: ${output.error}`);
      }

      if (!output.stems || !output.stem_names) {
        throw new Error(`RunPod job returned unexpected output format: ${JSON.stringify(Object.keys(output))}`);
      }

      // 3. Decode base64 OGG stems and save to disk
      log.info(`RunPod: job complete, decoding ${output.stem_names.length} stems...`);
      const stems = {};

      for (const [stemName, stemData] of Object.entries(output.stems)) {
        const stemDir = path.join(config.storage.stemsDir, jobId, 'runpod');
        fs.mkdirSync(stemDir, { recursive: true });
        const ext = stemData.format || 'ogg';
        const stemPath = path.join(stemDir, `${stemName}.${ext}`);
        const buffer = Buffer.from(stemData.base64, 'base64');
        fs.writeFileSync(stemPath, buffer);
        stems[stemName] = stemPath;
        log.info(`RunPod: saved ${stemName} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
      }

      const chordArtifacts = saveChordArtifacts(jobId, output);
      return { stems, ...chordArtifacts, chords: output.chords || null };
    }

    if (status === 'FAILED' || status === 'CANCELLED' || status === 'TIMED_OUT') {
      throw new Error(`RunPod job ${status}: ${JSON.stringify(statusData.error || statusData.output)}`);
    }
  }

  throw new Error(`RunPod: job timed out after ${MAX_WAIT / 1000}s`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────
//  PUBLIC API — routes to local or RunPod
// ─────────────────────────────────────────────

async function fullPipeline(youtubeId, jobId) {
  if (config.demucs.mode === 'runpod') {
    return runpodPipeline(youtubeId, jobId);
  }
  return localPipeline(youtubeId, jobId);
}

// Pipeline for uploaded audio files (skips YouTube download)
async function fullPipelineFromFile(audioPath, jobId) {
  ensureDirs();

  if (config.demucs.mode === 'runpod') {
    return runpodPipelineFromFile(audioPath, jobId);
  }
  // Local mode: just run separation directly
  const stems = await separateStems(audioPath, jobId);
  if (stems.vocals) {
    const stemDir = path.dirname(stems.vocals);
    const splits = await midSideSplit(stems.vocals, stemDir);
    delete stems.vocals;
    Object.assign(stems, splits);
  }
  try { fs.unlinkSync(audioPath); } catch (e) {}
  return { stems, chords: null, chordsPath: null, midiPath: null, keyInfo: null, chordCount: 0 };
}

/**
 * Transcode any audio file to a compact OGG (Vorbis) suitable for sending to
 * RunPod within its 10 MiB request body limit. Demucs handles OGG fine and
 * resamples internally, so 128 kbps stereo is plenty for stem separation.
 *
 * Returns the path to the transcoded file (caller should delete after use).
 * Falls back to original file if ffmpeg is not available.
 */
function transcodeForRunpod(audioPath, jobId) {
  return new Promise((resolve) => {
    const outPath = path.join(config.storage.downloadsDir, `${jobId}_compact.ogg`);
    fs.mkdirSync(config.storage.downloadsDir, { recursive: true });

    const proc = spawn('ffmpeg', [
      '-y',
      '-i', audioPath,
      '-c:a', 'libvorbis',
      '-b:a', '128k',          // 128 kbps stereo Vorbis
      '-ac', '2',              // stereo (Demucs needs it for mid-side)
      '-ar', '44100',          // 44.1 kHz (Demucs native rate)
      '-vn',                   // strip any video/cover art
      outPath,
    ]);

    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code !== 0 || !fs.existsSync(outPath)) {
        log.warn(`ffmpeg transcode failed (code ${code}), using original. stderr: ${stderr.slice(-200)}`);
        return resolve(audioPath);
      }
      const origSize = fs.statSync(audioPath).size;
      const newSize = fs.statSync(outPath).size;
      log.info(`Transcoded for RunPod: ${(origSize/1024/1024).toFixed(1)} MB → ${(newSize/1024/1024).toFixed(1)} MB`);
      resolve(outPath);
    });

    proc.on('error', (err) => {
      log.warn(`ffmpeg not available, sending original: ${err.message}`);
      resolve(audioPath);
    });
  });
}

// RunPod pipeline for uploaded files
async function runpodPipelineFromFile(audioPath, jobId) {
  const { apiKey, endpointId } = config.runpod;
  if (!apiKey || !endpointId) {
    throw new Error('RunPod API key and endpoint ID required');
  }
  const baseUrl = `https://api.runpod.ai/v2/${endpointId}`;
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  // Transcode to compact OGG to fit under RunPod's 10 MiB request body limit.
  // Base64 inflates by ~33%, so raw payload must stay below ~7.5 MB.
  const compactPath = await transcodeForRunpod(audioPath, jobId);
  const audioBuffer = fs.readFileSync(compactPath);
  const audioBase64 = audioBuffer.toString('base64');
  log.info(`RunPod (upload): payload ${(audioBuffer.length / 1024 / 1024).toFixed(1)} MB raw, ${(audioBase64.length / 1024 / 1024).toFixed(1)} MB base64, sending to GPU...`);
  // Clean up both the original upload and the transcoded copy
  try { fs.unlinkSync(audioPath); } catch (e) {}
  if (compactPath !== audioPath) { try { fs.unlinkSync(compactPath); } catch (e) {} }

  if (runpodPipeline._onProgress) {
    runpodPipeline._onProgress({ phase: 'Sending to GPU...', elapsed: 0, status: 'UPLOADING' });
  }

  const submitRes = await fetch(`${baseUrl}/run`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      input: {
        audio_base64: audioBase64,
        job_id: jobId,
        model: config.demucs.model,
      },
    }),
  });

  if (!submitRes.ok) {
    const errText = await submitRes.text();
    throw new Error(`RunPod submit failed (${submitRes.status}): ${errText}`);
  }

  const submitData = await submitRes.json();
  const runpodJobId = submitData.id;
  log.info(`RunPod (upload): job submitted → ${runpodJobId}`);

  // Poll for completion
  const POLL_INTERVAL = 5000;
  const MAX_WAIT = 10 * 60 * 1000;
  const startTime = Date.now();
  while (Date.now() - startTime < MAX_WAIT) {
    await sleep(POLL_INTERVAL);
    let statusRes;
    try {
      statusRes = await fetch(`${baseUrl}/status/${runpodJobId}`, { headers });
    } catch (fetchErr) {
      log.warn(`RunPod: status fetch error: ${fetchErr.message}`);
      continue;
    }
    if (!statusRes.ok) continue;

    const statusData = await statusRes.json();
    const status = statusData.status;

    if (status === 'IN_QUEUE' || status === 'IN_PROGRESS') {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const phase = status === 'IN_QUEUE' ? 'Waiting for GPU...' : 'Separating stems...';
      log.info(`RunPod: ${status} (${elapsed}s elapsed)...`);
      if (runpodPipeline._onProgress) {
        runpodPipeline._onProgress({ phase, elapsed, status });
      }
      continue;
    }

    if (status === 'COMPLETED') {
      const output = statusData.output;
      if (!output) throw new Error('RunPod returned no output');
      if (output.error) throw new Error(`RunPod error: ${output.error}`);
      if (!output.stems) throw new Error('RunPod returned no stems');

      log.info(`RunPod: job complete, decoding ${output.stem_names.length} stems...`);
      const stems = {};
      for (const [stemName, stemData] of Object.entries(output.stems)) {
        const stemDir = path.join(config.storage.stemsDir, jobId, 'runpod');
        fs.mkdirSync(stemDir, { recursive: true });
        const stemPath = path.join(stemDir, `${stemName}.ogg`);
        const buf = Buffer.from(stemData.base64, 'base64');
        fs.writeFileSync(stemPath, buf);
        log.info(`RunPod: saved ${stemName} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
        stems[stemName] = stemPath;
      }
      const chordArtifacts = saveChordArtifacts(jobId, output);
      return { stems, ...chordArtifacts, chords: output.chords || null };
    }

    if (status === 'FAILED') {
      const errMsg = statusData.output?.error || statusData.error || 'Unknown error';
      throw new Error(`RunPod job FAILED: ${JSON.stringify(errMsg)}`);
    }
  }
  throw new Error('RunPod job timed out');
}

function getStemPath(jobId, stemName) {
  const stemDir = path.join(config.storage.stemsDir, jobId);
  if (!fs.existsSync(stemDir)) return null;

  function findFile(dir, name) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = findFile(fullPath, name);
        if (found) return found;
      } else if (entry.name.startsWith(name) && (entry.name.endsWith('.wav') || entry.name.endsWith('.ogg'))) {
        return fullPath;
      }
    }
    return null;
  }

  return findFile(stemDir, stemName);
}

function getChordsPath(jobId) {
  if (!config.storage.chordsDir) return null;
  const p = path.join(config.storage.chordsDir, `${jobId}.json`);
  return fs.existsSync(p) ? p : null;
}

function getMidiPath(jobId) {
  if (!config.storage.midiDir) return null;
  const p = path.join(config.storage.midiDir, `${jobId}.mid`);
  return fs.existsSync(p) ? p : null;
}

module.exports = {
  downloadYouTube,
  separateStems,
  fullPipeline,
  fullPipelineFromFile,
  getStemPath,
  getChordsPath,
  getMidiPath,
  runpodPipeline,
};

// ─────────────────────────────────────────────
//  REGENERATE CHORDS ONLY (skip Demucs)
// ─────────────────────────────────────────────

/**
 * Send cached stems back to RunPod with chords_only=true.
 * RunPod skips Demucs and re-runs: harmony mix → BTC → madmom → CREPE → MIDI.
 * Returns the same shape as fullPipelineFromFile.
 */
async function regenerateChords(jobId, stemPaths) {
  ensureDirs();
  const { apiKey, endpointId } = config.runpod;
  if (!apiKey || !endpointId) {
    throw new Error('RunPod API key and endpoint ID required');
  }
  const baseUrl = `https://api.runpod.ai/v2/${endpointId}`;
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  // Read and base64-encode only the stems needed for chord detection:
  // bass, other, vocals (or lead_vocals), drums (for beat tracking)
  const stemsPayload = {};
  const stemNames = ['bass', 'other', 'lead_vocals', 'backing_vocals', 'drums'];
  for (const name of stemNames) {
    const filePath = stemPaths[name];
    if (filePath && fs.existsSync(filePath)) {
      const buf = fs.readFileSync(filePath);
      stemsPayload[name] = buf.toString('base64');
      log.info(`Regenerate: loaded ${name} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
    }
  }

  if (!stemsPayload.bass || !stemsPayload.other) {
    throw new Error('Cannot regenerate: bass and other stems are required');
  }

  log.info(`Regenerate: sending ${Object.keys(stemsPayload).length} cached stems to RunPod (chords_only)...`);

  const submitRes = await fetch(`${baseUrl}/run`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      input: {
        chords_only: true,
        stems_base64: stemsPayload,
        job_id: jobId,
      },
    }),
  });

  if (!submitRes.ok) {
    const errText = await submitRes.text();
    throw new Error(`RunPod submit failed (${submitRes.status}): ${errText}`);
  }

  const submitData = await submitRes.json();
  const runpodJobId = submitData.id;
  log.info(`Regenerate: job submitted → ${runpodJobId}`);

  // Poll for completion (shorter timeout — no Demucs = much faster)
  const POLL_INTERVAL = 3000;
  const MAX_WAIT = 5 * 60 * 1000;
  const startTime = Date.now();

  if (regenerateChords._onProgress) {
    regenerateChords._onProgress({ phase: 'Regenerating chords...', elapsed: 0, status: 'IN_PROGRESS' });
  }

  while (Date.now() - startTime < MAX_WAIT) {
    await sleep(POLL_INTERVAL);
    let statusRes;
    try {
      statusRes = await fetch(`${baseUrl}/status/${runpodJobId}`, { headers });
    } catch (e) {
      log.warn(`Regenerate: status fetch error: ${e.message}`);
      continue;
    }
    if (!statusRes.ok) continue;

    const statusData = await statusRes.json();
    const status = statusData.status;

    if (status === 'IN_QUEUE' || status === 'IN_PROGRESS') {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      log.info(`Regenerate: ${status} (${elapsed}s)...`);
      if (regenerateChords._onProgress) {
        regenerateChords._onProgress({ phase: status === 'IN_QUEUE' ? 'Waiting for GPU...' : 'Analyzing chords...', elapsed, status });
      }
      continue;
    }

    if (status === 'COMPLETED') {
      const output = statusData.output;
      if (!output) throw new Error('RunPod returned no output');
      if (output.error) throw new Error(`RunPod error: ${output.error}`);

      log.info(`Regenerate: complete! ${(output.chords || []).length} chords detected.`);
      const chordArtifacts = saveChordArtifacts(jobId, output);
      return { chords: output.chords || null, ...chordArtifacts };
    }

    if (status === 'FAILED') {
      throw new Error(`RunPod job FAILED: ${JSON.stringify(statusData.output?.error || statusData.error)}`);
    }
  }
  throw new Error('Regenerate: job timed out');
}

module.exports.regenerateChords = regenerateChords;
