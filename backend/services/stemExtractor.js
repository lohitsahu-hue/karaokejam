const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const log = require('../utils/logger');

// Ensure storage dirs exist
function ensureDirs() {
  fs.mkdirSync(config.storage.stemsDir, { recursive: true });
  fs.mkdirSync(config.storage.downloadsDir, { recursive: true });
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
  return stems;
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

      return stems;
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
  return stems;
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

  const audioBuffer = fs.readFileSync(audioPath);
  const audioBase64 = audioBuffer.toString('base64');
  log.info(`RunPod (upload): audio file ${(audioBuffer.length / 1024 / 1024).toFixed(1)} MB, sending to GPU...`);
  try { fs.unlinkSync(audioPath); } catch (e) {}

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
      return stems;
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

module.exports = { downloadYouTube, separateStems, fullPipeline, fullPipelineFromFile, getStemPath, runpodPipeline };
