// Library View — shows previously processed songs with Regenerate Chords button
const LibraryView = {
  songs: [],
  refreshInterval: null,

  init() {
    this.refresh();
    // Auto-refresh every 30s to pick up newly processed songs
    this.refreshInterval = setInterval(() => this.refresh(), 30000);
  },

  async refresh() {
    try {
      const data = await API.getLibrary();
      this.songs = data.songs || [];
      this.render();
    } catch (e) {
      console.error('[Library] Failed to load:', e);
    }
  },

  render() {
    const container = document.getElementById('library-list');
    const countEl = document.getElementById('library-count');
    if (!container) return;

    countEl.textContent = this.songs.length;

    if (this.songs.length === 0) {
      container.innerHTML = '<div style="color:#666;padding:12px;text-align:center;font-size:13px;">No songs processed yet. Upload a song and it will appear here.</div>';
      return;
    }

    container.innerHTML = this.songs.map(song => {
      const keyStr = song.keyInfo ? `${song.keyInfo.key} ${song.keyInfo.mode}` : '';
      const bpmStr = song.timingInfo && song.timingInfo.tempo_bpm ? `${Math.round(song.timingInfo.tempo_bpm)} BPM` : '';
      const tsStr = song.timingInfo && song.timingInfo.time_signature ? song.timingInfo.time_signature : '';
      const chordsStr = song.chordCount ? `${song.chordCount} chords` : '';
      const stemsOk = song.stemsAvailable !== false;
      const date = song.processedAt ? new Date(song.processedAt).toLocaleDateString() : '';
      
      const midiLink = song.hasMidi ? `<a href="/api/songs/${song.jobId}/midi" download style="color:#a78bfa;text-decoration:none;font-size:11px;">⬇ MIDI</a>` : '';
      const chartLink = `<a href="/api/songs/${song.jobId}/chart.txt" download style="color:#a78bfa;text-decoration:none;font-size:11px;">⬇ Chart</a>`;
      const jsonLink = `<a href="/api/songs/${song.jobId}/chords" download="chords.json" style="color:#a78bfa;text-decoration:none;font-size:11px;">⬇ JSON</a>`;

      const infoParts = [keyStr, bpmStr, tsStr, chordsStr].filter(Boolean).join(' · ');
      const downloadParts = [midiLink, chartLink, jsonLink].filter(Boolean).join(' · ');

      return `
        <div class="library-item" data-job-id="${song.jobId}" style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,0.06);">
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;font-size:13px;color:#e5e7eb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${this.esc(song.title)}</div>
            <div style="font-size:11px;color:#888;margin-top:2px;">${this.esc(song.artist)}${date ? ' · ' + date : ''}</div>
            ${infoParts ? `<div style="font-size:11px;color:#a78bfa;margin-top:2px;">${infoParts}</div>` : ''}
            ${downloadParts ? `<div style="margin-top:3px;">${downloadParts}</div>` : ''}
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0;">
            ${stemsOk ? `<button class="btn-regen" data-job-id="${song.jobId}" style="padding:5px 10px;background:linear-gradient(135deg,#f59e0b,#d97706);border:none;color:#fff;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;">♻ Regenerate</button>` : `<span style="color:#ef4444;font-size:11px;">stems missing</span>`}
          </div>
        </div>
      `;
    }).join('');

    // Wire up regenerate buttons
    container.querySelectorAll('.btn-regen').forEach(btn => {
      btn.addEventListener('click', async () => {
        const jobId = btn.dataset.jobId;
        btn.disabled = true;
        btn.textContent = '⏳ Running...';
        btn.style.background = '#666';
        try {
          await API.regenerateChords(jobId);
          btn.textContent = '✓ Started!';
          btn.style.background = '#22c55e';
          // Poll for completion — refresh library after a delay
          setTimeout(() => this.refresh(), 5000);
          setTimeout(() => this.refresh(), 15000);
          setTimeout(() => this.refresh(), 30000);
          setTimeout(() => this.refresh(), 60000);
        } catch (e) {
          btn.textContent = '✗ Failed';
          btn.style.background = '#ef4444';
          console.error('[Library] Regenerate failed:', e);
          setTimeout(() => {
            btn.textContent = '♻ Regenerate';
            btn.style.background = 'linear-gradient(135deg,#f59e0b,#d97706)';
            btn.disabled = false;
          }, 3000);
        }
      });
    });
  },

  esc(s) { return (s || '').replace(/</g, '&lt;'); },
};
