// Queue View — display and manage song queue
const QueueView = {
  init() {
    // Listen for queue updates from server
    WS.on('queue:updated', (data) => this.render(data.queue));
    WS.on('job:ready', (data) => {
      console.log('[Queue] Song ready:', data.queueItemId);
    });
    WS.on('job:error', (data) => {
      console.error('[Queue] Job failed:', data.error);
    });
    WS.on('job:progress', (data) => {
      const statusEl = document.querySelector(`.queue-item-status.downloading`);
      if (statusEl) {
        statusEl.textContent = `${data.phase} (${data.elapsed}s)`;
      }
    });
  },

  render(queue) {
    const container = document.getElementById('queue-list');
    const countEl = document.getElementById('queue-count');
    countEl.textContent = queue.length;

    if (queue.length === 0) {
      container.innerHTML = '<div class="queue-empty">No songs yet — search and add one!</div>';
      return;
    }

    container.innerHTML = queue.map((item, i) => `
      <div class="queue-item ${item.status === 'playing' ? 'playing' : ''} ${item.status === 'downloading' || item.status === 'separating' ? 'downloading' : ''}" data-id="${item.id}">        <span class="queue-item-num">${i + 1}</span>
        <div class="queue-item-info">
          <div class="queue-item-title">${this.esc(item.title)}</div>
          <div class="queue-item-meta">${this.esc(item.requestedByName)}</div>
        </div>
        ${item.status === 'ready' ? `<button class="btn btn-primary btn-play-now pulse-glow" data-idx="${i}">▶ Play</button>` : item.status === 'playing' ? `<button class="btn btn-primary btn-open-mixer pulse-glow" data-idx="${i}">▶ Open Mixer</button>` : item.status === 'played' ? `<button class="btn btn-sm btn-replay" data-idx="${i}">↻ Replay</button>` : `<span class="queue-item-status ${item.status}">${this.statusLabel(item.status)}</span>`}
        ${App.isHost ? `<button class="btn btn-sm btn-remove" data-id="${item.id}" style="color:#ef4444;">&times;</button>` : ''}
      </div>
    `).join('');

    // Play buttons
    container.querySelectorAll('.btn-play-now').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        App.playSong(idx);
      });
    });

    // Open Mixer buttons (for songs already playing — e.g. after page refresh)
    container.querySelectorAll('.btn-open-mixer').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        App.playSong(idx);
      });
    });

    // Replay buttons (for songs already played)
    container.querySelectorAll('.btn-replay').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        App.playSong(idx);
      });
    });

    // Remove buttons
    container.querySelectorAll('.btn-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        WS.removeFromQueue(btn.dataset.id);
      });
    });
  },

  statusLabel(s) {
    const labels = {
      pending: 'Pending',
      downloading: 'Downloading...',      separating: 'Separating stems...',
      ready: 'Ready',
      playing: '♪ Playing',
      played: 'Played',
      error: 'Error',
    };
    return labels[s] || s;
  },

  esc(s) { return (s || '').replace(/</g, '&lt;'); },
};