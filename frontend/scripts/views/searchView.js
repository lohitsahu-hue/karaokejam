// Search View — YouTube song search
const SearchView = {
  init() {
    document.getElementById('btn-search').addEventListener('click', () => this.doSearch());
    document.getElementById('search-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.doSearch();
    });
  },

  // Build a map of youtubeId → queue item for songs already in the queue
  _getQueueMap() {
    const map = {};
    try {
      // Get room queue from the last known state
      if (App.roomId) {
        const room = this._cachedRoom;
        if (room && room.queue) {
          for (let i = 0; i < room.queue.length; i++) {
            const item = room.queue[i];
            // Only map songs that have usable stems (ready, playing, or played)
            if (['ready', 'playing', 'played'].includes(item.status)) {
              map[item.songId] = { idx: i, item };
            }
          }
        }
      }
    } catch (e) {}
    return map;
  },

  async doSearch() {
    const query = document.getElementById('search-input').value.trim();
    if (!query) return;

    const container = document.getElementById('search-results');
    container.innerHTML = '<div style="text-align:center;color:#888;padding:20px;">Searching...</div>';

    try {
      // Fetch search results and room state in parallel
      const [data, room] = await Promise.all([
        API.searchYouTube(query),
        App.roomId ? API.getRoom(App.roomId) : Promise.resolve(null),
      ]);
      this._cachedRoom = room;
      this.renderResults(data.results || []);
    } catch (e) {
      container.innerHTML = `<div style="color:#ef4444;padding:12px;">Search failed: ${e.message}</div>`;
    }
  },

  renderResults(results) {
    const container = document.getElementById('search-results');
    if (results.length === 0) {
      container.innerHTML = '<div style="text-align:center;color:#888;padding:20px;">No results found</div>';
      return;
    }

    const queueMap = this._getQueueMap();

    container.innerHTML = results.map(r => {
      const existing = queueMap[r.youtubeId];
      let actionBtn;
      if (existing) {
        actionBtn = `<button class="btn btn-sm btn-play-ready" data-queue-idx="${existing.idx}" style="background:#22c55e;color:#fff;font-weight:700;">▶ Ready</button>`;
      } else {
        actionBtn = `<button class="btn btn-primary btn-sm btn-add-queue">+ Queue</button>`;
      }

      return `
      <div class="search-result" data-yt-id="${r.youtubeId}" data-title="${this.esc(r.title)}" data-channel="${this.esc(r.channel)}" data-thumb="${r.thumbnail}" data-dur="${r.duration}">
        <img src="${r.thumbnail}" alt="">
        <div class="search-result-info">
          <div class="search-result-title">${this.esc(r.title)}</div>
          <div class="search-result-channel">${this.esc(r.channel)}${existing ? ' <span style="color:#22c55e;font-size:11px;">★ stems ready</span>' : ''}</div>
        </div>
        <span class="search-result-duration">${this.fmtDur(r.duration)}</span>
        ${actionBtn}
      </div>
    `;
    }).join('');

    // "+ Queue" buttons for new songs
    container.querySelectorAll('.btn-add-queue').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const row = btn.closest('.search-result');
        this.addToQueue(row);
        btn.textContent = '✓ Added';
        btn.disabled = true;
        btn.style.opacity = '0.5';
      });
    });

    // "▶ Ready" buttons for already-split songs — play directly
    container.querySelectorAll('.btn-play-ready').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.queueIdx);
        App.playSong(idx);
      });
    });
  },

  async addToQueue(row) {
    const song = {
      youtubeId: row.dataset.ytId,
      title: row.dataset.title,
      artist: row.dataset.channel,
      thumbnail: row.dataset.thumb,
      duration: parseInt(row.dataset.dur) || 0,
      requestedBy: App.guestId || 'host',
      requestedByName: App.userName,
    };

    try {
      await API.addToQueue(App.roomId, song);
    } catch (e) {
      console.error('Failed to add to queue:', e);
    }
  },

  esc(s) { return (s || '').replace(/"/g, '&quot;').replace(/</g, '&lt;'); },
  fmtDur(s) {
    if (!s) return '';
    const m = Math.floor(s / 60), sec = s % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
  },
};