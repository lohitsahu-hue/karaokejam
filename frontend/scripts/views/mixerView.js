// Mixer View — full karaoke mixer using real-time SharedWSOLA engine + lyrics
//
// Architecture:
//   One ScriptProcessorNode processes ALL stems through SharedWSOLA.
//   Key change is INSTANT — just sets engine.pitch, no offline processing.
//   Per-stem volume via gain multipliers in the audio callback.
//   Lyrics auto-fetched from LRCLIB, displayed in cinematic overlay.

const MixerView = {
  ctx: null,
  stems: [],             // { name, label, buf, defaultVol, volume }
  engine: null,          // SharedWSOLA instance
  scriptNode: null,      // ScriptProcessorNode
  masterGain: null,
  playing: false,
  readPos: 0,            // current read position in source frames
  playStartCtxTime: 0,   // ctx.currentTime when playback started
  playStartSrcTime: 0,   // source-time (seconds) when playback started
  lastTempo: 100,
  duration: 0,
  currentSemitones: 0,
  seekTimer: null,
  currentSong: null,
  _feedBuf: new Float32Array(0),
  _mixBuf: new Float32Array(0),

  // Lyrics state
  lyricsLines: [],       // [{time, text, roman}]
  lyricsLoaded: false,
  lyricsOverlayOn: false,
  currentLyricIdx: -1,
  lyricsOffset: 0,

  SCRIPT_BUF: 4096,
  FEED_CHUNK: 2048,
  NUM_CH: 2,

  stemConfig: {
    lead_vocals:    { label: '🎤 Lead Vocals',    defaultVol: 100 },
    backing_vocals: { label: '🎵 Backing Vocals', defaultVol: 60 },
    drums:          { label: '🥁 Drums',           defaultVol: 100 },
    bass:           { label: '🎸 Bass',            defaultVol: 100 },
    other:          { label: '🎹 Other',           defaultVol: 100 },
  },
  stemConfigLegacy: {
    vocals:    { label: '🎤 Vocals',       defaultVol: 100 },
    no_vocals: { label: '🎵 Instrumental', defaultVol: 100 },
  },

  init() {
    document.getElementById('btn-open-mixer').addEventListener('click', () => App.showView('mixer'));
    document.getElementById('btn-back-to-room').addEventListener('click', () => {
      this.stop();
      App.showView('room');
    });
    document.getElementById('btn-next-song').addEventListener('click', () => WS.next());

    // Lyrics overlay controls
    document.getElementById('lo-close').addEventListener('click', () => this._hideLyricsOverlay());
    document.getElementById('lo-playpause').addEventListener('click', () => this.togglePlayPause());
    document.getElementById('lo-restart').addEventListener('click', () => this.seek(0));
    document.getElementById('lo-skip').addEventListener('click', () => WS.next());
    document.getElementById('lo-sync-minus').addEventListener('click', () => this._adjustLyricsOffset(-0.5));
    document.getElementById('lo-sync-plus').addEventListener('click', () => this._adjustLyricsOffset(0.5));
    document.getElementById('lo-sync-reset').addEventListener('click', () => this._resetLyricsOffset());
    document.getElementById('lo-sync-auto').addEventListener('click', () => this._autoSyncLyrics());
    document.getElementById('lo-progress-wrap').addEventListener('click', (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      this.seek(pct * this.duration);
    });

    WS.on('playback:nextSong', (data) => {
      this.currentSong = data.currentSong;
      document.getElementById('np-title').textContent = data.currentSong.title;
      document.getElementById('np-artist').textContent = data.currentSong.requestedByName;
      this.loadAndPlay(data.currentSong);
    });

    WS.on('playback:queueEmpty', () => {
      document.getElementById('now-playing').style.display = 'none';
      this.stop();
    });
  },

  async loadAndPlay(song) {
    if (!song.jobId) { console.error('No jobId for song'); return; }

    this.stop();
    this.currentSong = song;
    this.currentSemitones = 0;
    this.lyricsLines = [];
    this.lyricsLoaded = false;
    this.lyricsOffset = 0;
    this.currentLyricIdx = -1;

    const container = document.getElementById('mixer-container');
    container.innerHTML = '<div class="mixer-loading">Loading stems...</div>';

    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();

      let stemNames = Object.keys(this.stemConfig);
      let config = this.stemConfig;
      let buffers = await this._loadStems(song.jobId, stemNames);

      if (buffers.length === 0) {
        stemNames = Object.keys(this.stemConfigLegacy);
        config = this.stemConfigLegacy;
        buffers = await this._loadStems(song.jobId, stemNames);
      }

      if (buffers.length === 0) {
        container.innerHTML = '<div class="mixer-error">Failed to load stems</div>';
        return;
      }

      this.stems = buffers.map(({ name, buffer }) => ({
        name,
        label: config[name]?.label || name,
        defaultVol: config[name]?.defaultVol || 100,
        volume: (config[name]?.defaultVol || 100) / 100,
        buf: buffer,
      }));

      this.duration = Math.max(...this.stems.map(s => s.buf.duration));
      this.readPos = 0;
      this.playStartSrcTime = 0;

      this._renderUI(song);
      this._play(0);

      document.getElementById('now-playing').style.display = 'flex';
      document.getElementById('np-title').textContent = song.title;
      document.getElementById('np-artist').textContent = song.requestedByName;

      // Auto-fetch lyrics in background
      this._fetchLyrics(song.title);

    } catch (e) {
      console.error('Mixer load error:', e);
      container.innerHTML = `<div class="mixer-error">Error: ${e.message}</div>`;
    }
  },

  async _loadStems(jobId, stemNames) {
    const buffers = [];
    for (const name of stemNames) {
      try {
        const url = API.stemUrl(jobId, name);
        const res = await fetch(url);
        if (!res.ok) continue;
        const arrayBuf = await res.arrayBuffer();
        const audioBuf = await this.ctx.decodeAudioData(arrayBuf);
        buffers.push({ name, buffer: audioBuf });
      } catch (e) {
        console.warn(`Stem ${name} not available:`, e.message);
      }
    }
    return buffers;
  },

  // ─── Lyrics fetching ───
  async _fetchLyrics(songTitle) {
    const statusEl = document.getElementById('lyrics-status');
    const btn = document.getElementById('btn-lyrics-toggle');
    if (statusEl) statusEl.textContent = 'Searching lyrics...';
    if (btn) btn.classList.add('loading');

    try {
      // Clean up YouTube title → just the song name for LRCLIB search
      let query = songTitle
        .replace(/\(.*?\)/g, '')           // remove (Lyrics), (From "..."), etc.
        .replace(/\[.*?\]/g, '')           // remove [Official Video], etc.
        .replace(/[|]/g, ' ')             // pipes to spaces (not strip — song name may come after pipe)
        .replace(/lyrics?/gi, '')
        .replace(/official.*video/gi, '')
        .replace(/full\s*(video\s*)?song/gi, '')
        .replace(/audio/gi, '')
        .replace(/coke\s*studio/gi, '')    // remove common channel/show names
        .replace(/season\s*\d+/gi, '')
        .replace(/episode\s*\d+/gi, '')
        .replace(/t-?\s*series/gi, '')
        .replace(/[-–—:]/g, ' ')          // dashes & colons to spaces
        .replace(/\s{2,}/g, ' ')          // collapse multiple spaces
        .trim();

      // If query is too short after cleanup, use first 3 words of original title
      if (query.length < 3) {
        query = songTitle.split(/\s+/).slice(0, 3).join(' ');
      }

      console.log(`[Lyrics] Search query: "${query}" (from: "${songTitle}")`);

      const results = await LyricsEngine.searchLRCLIB(query);
      // Pick best result: matches query words, prefers English > Hindi, filters out Urdu/Arabic
      const synced = LyricsEngine.pickBestLyrics(results, query);

      if (synced) {
        this.lyricsLines = LyricsEngine.processLRC(synced.syncedLyrics);
        this.lyricsLoaded = this.lyricsLines.length > 0;

        if (this.lyricsLoaded) {
          // Auto-sync: detect vocal onset to align lyrics
          this.lyricsOffset = LyricsEngine.autoSyncLyrics(this.lyricsLines, this.stems);
          this._updateSyncUI();

          if (statusEl) {
            statusEl.textContent = `♪ ${this.lyricsLines.length} lines loaded`;
            statusEl.style.color = '#34d399';
          }
          if (btn) { btn.classList.remove('loading'); btn.disabled = false; }

          // Update overlay song info
          document.getElementById('lo-title').textContent = synced.trackName || songTitle;
          document.getElementById('lo-artist').textContent = synced.artistName || '';
        }
      } else {
        if (statusEl) { statusEl.textContent = 'No synced lyrics found'; statusEl.style.color = '#888'; }
        if (btn) { btn.classList.remove('loading'); }
      }
    } catch (e) {
      console.warn('Lyrics fetch failed:', e);
      if (statusEl) { statusEl.textContent = 'Lyrics search failed'; statusEl.style.color = '#ef4444'; }
      if (btn) { btn.classList.remove('loading'); }
    }
  },

  // ─── Real-time audio callback ───
  _audioProcess(e) {
    const outL = e.outputBuffer.getChannelData(0);
    const outR = e.outputBuffer.getChannelData(1);
    const outLen = outL.length;
    outL.fill(0); outR.fill(0);

    if (!this.engine || !this.playing || this.stems.length === 0) return;

    const maxSrc = Math.round(this.duration * this.ctx.sampleRate);
    let minAvail = Infinity;
    for (let s = 0; s < this.stems.length; s++)
      minAvail = Math.min(minAvail, this.engine.stemAvail(s));

    let safety = 0;
    while (minAvail < outLen && this.readPos < maxSrc && safety < 40) {
      safety++;
      const toFeed = Math.min(this.FEED_CHUNK, maxSrc - this.readPos);
      if (toFeed <= 0) break;

      if (this._feedBuf.length < toFeed * 2) this._feedBuf = new Float32Array(toFeed * 2);

      for (let s = 0; s < this.stems.length; s++) {
        const buf = this.stems[s].buf;
        const ch0 = buf.getChannelData(0);
        const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0;
        const end = Math.min(this.readPos + toFeed, buf.length);
        const actual = end - this.readPos;

        for (let i = 0; i < actual; i++) {
          this._feedBuf[i * 2] = ch0[this.readPos + i];
          this._feedBuf[i * 2 + 1] = ch1[this.readPos + i];
        }
        for (let i = actual; i < toFeed; i++) {
          this._feedBuf[i * 2] = 0;
          this._feedBuf[i * 2 + 1] = 0;
        }

        this.engine.stemInputs[s].push(this._feedBuf, toFeed);
      }

      this.readPos += toFeed;
      this.engine.process();

      minAvail = Infinity;
      for (let s = 0; s < this.stems.length; s++)
        minAvail = Math.min(minAvail, this.engine.stemAvail(s));
    }

    if (this._mixBuf.length < outLen * 2) this._mixBuf = new Float32Array(outLen * 2);

    for (let s = 0; s < this.stems.length; s++) {
      const gain = this.stems[s].volume;
      const avail = this.engine.readStem(s, this._mixBuf, outLen);
      if (gain > 0) {
        for (let i = 0; i < avail; i++) {
          outL[i] += this._mixBuf[i * 2] * gain;
          outR[i] += this._mixBuf[i * 2 + 1] * gain;
        }
      }
    }
  },

  // ─── Playback controls ───
  _play(seekSec) {
    this._stopPlayback();
    if (!this.ctx) return;

    const sr = this.ctx.sampleRate;
    if (seekSec !== undefined) {
      this.readPos = Math.max(0, Math.min(Math.round(seekSec * sr), Math.round(this.duration * sr)));
      this.playStartSrcTime = this.readPos / sr;
    }

    this.engine = new AudioEngine.SharedWSOLA(this.NUM_CH, sr);
    this.engine.pitch = Math.pow(2, this.currentSemitones / 12);
    this.engine.tempo = 1.0;
    this.lastTempo = 100;

    for (let i = 0; i < this.stems.length; i++) this.engine.addStem();

    this.scriptNode = this.ctx.createScriptProcessor(this.SCRIPT_BUF, 2, 2);
    this.scriptNode.onaudioprocess = (e) => this._audioProcess(e);

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 1.0;
    this.scriptNode.connect(this.masterGain);
    this.masterGain.connect(this.ctx.destination);

    this.playStartCtxTime = this.ctx.currentTime;
    this.playing = true;
    this._updateTransportButton();
    this._startProgressTimer();
  },

  _stopPlayback() {
    if (this.scriptNode) {
      this.scriptNode.disconnect();
      this.scriptNode.onaudioprocess = null;
      this.scriptNode = null;
    }
    if (this.masterGain) {
      this.masterGain.disconnect();
      this.masterGain = null;
    }
    this.engine = null;
    this.playing = false;
    this._updateTransportButton();
    this._stopProgressTimer();
  },

  togglePlayPause() {
    if (this.playing) this.pause();
    else this.resume();
  },

  pause() {
    if (!this.playing) return;
    this.playStartSrcTime = this._getCurrentTime();
    this._stopPlayback();
  },

  resume() {
    if (this.playing || !this.ctx) return;
    this._play(this.playStartSrcTime);
  },

  seek(time) {
    time = Math.max(0, Math.min(time, this.duration));
    if (this.playing) {
      this._play(time);
    } else {
      this.playStartSrcTime = time;
      this.readPos = this.ctx ? Math.round(time * this.ctx.sampleRate) : 0;
      this._updateTimeUI(time);
    }
  },

  stop() {
    this._stopPlayback();
    this._hideLyricsOverlay();
    this.stems = [];
    this.readPos = 0;
    this.playStartSrcTime = 0;
    this.lyricsLines = [];
    this.lyricsLoaded = false;
    this.currentLyricIdx = -1;
    this._stopProgressTimer();
    if (this.ctx) { try { this.ctx.close(); } catch (e) {} this.ctx = null; }
  },

  // ─── Key change — INSTANT ───
  _applyKeyChange(semitones) {
    if (semitones === this.currentSemitones) return;
    this.currentSemitones = semitones;
    if (this.engine) this.engine.pitch = Math.pow(2, semitones / 12);

    const statusEl = document.getElementById('mixer-key-status');
    if (statusEl) {
      statusEl.textContent = semitones === 0 ? '' : `Key ${semitones > 0 ? '+' : ''}${semitones}`;
      statusEl.style.color = '#22c55e';
    }
  },

  // ─── Lyrics overlay ───
  _showLyricsOverlay() {
    if (!this.lyricsLoaded) return;
    this.lyricsOverlayOn = true;
    document.getElementById('lyrics-overlay').classList.add('show');
    const btn = document.getElementById('btn-lyrics-toggle');
    if (btn) btn.classList.add('on');
    this._updateLyricsDisplay(this.currentLyricIdx);
  },

  _hideLyricsOverlay() {
    this.lyricsOverlayOn = false;
    document.getElementById('lyrics-overlay').classList.remove('show');
    const btn = document.getElementById('btn-lyrics-toggle');
    if (btn) btn.classList.remove('on');
  },

  _toggleLyricsOverlay() {
    if (this.lyricsOverlayOn) this._hideLyricsOverlay();
    else this._showLyricsOverlay();
  },

  _updateLyricsDisplay(idx) {
    if (!this.lyricsOverlayOn) return;

    const prevEl = document.getElementById('lo-prev');
    const currEl = document.getElementById('lo-curr');
    const nextEl = document.getElementById('lo-next');
    if (!prevEl) return;

    const setLine = (el, line) => {
      el.querySelector('.lo-text').textContent = line ? line.text : '';
      el.querySelector('.lo-roman').textContent = line ? line.roman : '';
    };

    setLine(prevEl, idx > 0 ? this.lyricsLines[idx - 1] : null);
    setLine(currEl, idx >= 0 ? this.lyricsLines[idx] : null);
    setLine(nextEl, idx >= 0 && idx + 1 < this.lyricsLines.length ? this.lyricsLines[idx + 1] : null);
  },

  _updateLyricsForTime(timeSec) {
    if (!this.lyricsLoaded || this.lyricsLines.length === 0) return;

    const idx = LyricsEngine.findLineIndex(this.lyricsLines, timeSec, this.lyricsOffset);
    if (idx !== this.currentLyricIdx) {
      this.currentLyricIdx = idx;
      this._updateLyricsDisplay(idx);
    }
  },

  _adjustLyricsOffset(delta) {
    this.lyricsOffset = Math.round((this.lyricsOffset + delta) * 10) / 10;
    this._updateSyncUI();
    this.currentLyricIdx = -999; // force re-evaluate
    if (this.playing) this._updateLyricsForTime(this._getCurrentTime());
  },

  _resetLyricsOffset() {
    this.lyricsOffset = 0;
    this._updateSyncUI();
    this.currentLyricIdx = -999;
    if (this.playing) this._updateLyricsForTime(this._getCurrentTime());
  },

  _autoSyncLyrics() {
    if (!this.lyricsLoaded) return;
    this.lyricsOffset = LyricsEngine.autoSyncLyrics(this.lyricsLines, this.stems);
    this._updateSyncUI();
    this.currentLyricIdx = -999;
    if (this.playing) this._updateLyricsForTime(this._getCurrentTime());
  },

  _updateSyncUI() {
    const txt = this.lyricsOffset === 0 ? '0.0s' : (this.lyricsOffset > 0 ? '+' : '') + this.lyricsOffset.toFixed(1) + 's';
    const el = document.getElementById('lo-sync-value');
    if (el) el.textContent = 'Sync: ' + txt;
  },

  // ─── Time tracking ───
  _getCurrentTime() {
    if (!this.ctx) return 0;
    if (!this.playing) return this.playStartSrcTime;
    const realElapsed = this.ctx.currentTime - this.playStartCtxTime;
    const srcElapsed = realElapsed * (this.lastTempo / 100);
    return Math.max(0, Math.min(this.playStartSrcTime + srcElapsed, this.duration));
  },

  // ─── UI ───
  _renderUI(song) {
    const container = document.getElementById('mixer-container');
    container.innerHTML = `
      <div class="mixer-panel">
        <h2 class="mixer-title">♪ ${song.title}</h2>

        <!-- Progress bar -->
        <div class="mixer-progress-wrap" id="mixer-progress-wrap">
          <div class="mixer-progress-bar" id="mixer-progress-bar"></div>
          <span class="mixer-time" id="mixer-time">0:00 / ${this._fmtTime(this.duration)}</span>
        </div>

        <!-- Transport controls -->
        <div class="mixer-transport">
          <button class="btn btn-sm" id="btn-mixer-restart">⏮</button>
          <button class="btn btn-primary" id="btn-mixer-playpause">⏸ Pause</button>
          <button class="btn btn-sm" id="btn-mixer-skip">⏭</button>
        </div>

        <!-- Stem volume sliders -->
        <div class="mixer-stems">
          ${this.stems.map(s => `
            <div class="mixer-stem-row" data-stem="${s.name}">
              <span class="stem-label">${s.label}</span>
              <input type="range" min="0" max="100" value="${s.defaultVol}"
                class="stem-slider" data-stem="${s.name}">
              <span class="stem-vol-label">${s.defaultVol}%</span>
            </div>
          `).join('')}
        </div>

        <!-- Key change -->
        <div class="mixer-key-section">
          <div class="mixer-key-header">
            <span class="mixer-key-label">Key</span>
            <span class="mixer-key-value" id="mixer-key-value">0</span>
          </div>
          <div class="mixer-key-row">
            <span class="key-bound">-6</span>
            <input type="range" min="-6" max="6" value="0" step="1"
              class="key-slider" id="mixer-key-slider">
            <span class="key-bound">+6</span>
          </div>
          <div class="mixer-key-status" id="mixer-key-status"></div>
        </div>

        <!-- Lyrics toggle -->
        <div class="mixer-lyrics-row">
          <button class="btn-lyrics" id="btn-lyrics-toggle" disabled>♪ Lyrics</button>
        </div>
        <div class="lyrics-status" id="lyrics-status"></div>
      </div>
    `;

    // Wire up transport
    document.getElementById('btn-mixer-playpause').addEventListener('click', () => this.togglePlayPause());
    document.getElementById('btn-mixer-restart').addEventListener('click', () => this.seek(0));
    document.getElementById('btn-mixer-skip').addEventListener('click', () => WS.next());

    // Progress bar click-to-seek
    document.getElementById('mixer-progress-wrap').addEventListener('click', (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      this.seek(pct * this.duration);
    });

    // Volume sliders
    container.querySelectorAll('.stem-slider').forEach(slider => {
      slider.addEventListener('input', () => {
        const stem = this.stems.find(s => s.name === slider.dataset.stem);
        if (stem) stem.volume = slider.value / 100;
        slider.nextElementSibling.textContent = slider.value + '%';
      });
    });

    // Key change slider
    document.getElementById('mixer-key-slider').addEventListener('input', (e) => {
      const semitones = parseInt(e.target.value);
      document.getElementById('mixer-key-value').textContent =
        (semitones >= 0 ? '+' : '') + semitones;
      this._applyKeyChange(semitones);
    });

    // Lyrics toggle button
    document.getElementById('btn-lyrics-toggle').addEventListener('click', () => {
      this._toggleLyricsOverlay();
    });
  },

  _startProgressTimer() {
    this._stopProgressTimer();
    const update = () => {
      const t = this._getCurrentTime();
      if (t >= this.duration) {
        this._stopPlayback();
        this.readPos = 0;
        this.playStartSrcTime = 0;
        this._updateTimeUI(0);
        this._hideLyricsOverlay();
        return;
      }
      this._updateTimeUI(t);

      // Update lyrics
      if (this.lyricsLoaded) this._updateLyricsForTime(t);

      // Update overlay progress bar + transport
      if (this.lyricsOverlayOn) {
        const loBar = document.getElementById('lo-progress-bar');
        const loTime = document.getElementById('lo-time');
        if (loBar) loBar.style.width = `${(t / this.duration) * 100}%`;
        if (loTime) loTime.textContent = `${this._fmtTime(t)} / ${this._fmtTime(this.duration)}`;
        const loPP = document.getElementById('lo-playpause');
        if (loPP) loPP.textContent = this.playing ? '⏸' : '▶';
      }

      if (this.playing) this.seekTimer = requestAnimationFrame(update);
    };
    this.seekTimer = requestAnimationFrame(update);
  },

  _stopProgressTimer() {
    if (this.seekTimer) cancelAnimationFrame(this.seekTimer);
    this.seekTimer = null;
  },

  _updateTimeUI(t) {
    const bar = document.getElementById('mixer-progress-bar');
    const timeEl = document.getElementById('mixer-time');
    if (bar) bar.style.width = `${(t / this.duration) * 100}%`;
    if (timeEl) timeEl.textContent = `${this._fmtTime(t)} / ${this._fmtTime(this.duration)}`;
  },

  _updateTransportButton() {
    const btn = document.getElementById('btn-mixer-playpause');
    if (btn) btn.textContent = this.playing ? '⏸ Pause' : '▶ Play';
    const loPP = document.getElementById('lo-playpause');
    if (loPP) loPP.textContent = this.playing ? '⏸' : '▶';
  },

  _fmtTime(secs) {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  },
};
