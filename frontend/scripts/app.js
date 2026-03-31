// Main App Controller
const App = {
  roomId: null,
  roomCode: null,
  guestId: null,
  userName: '',
  isHost: false,
  currentView: 'landing',

  init() {
    // Init sub-views
    SearchView.init();
    QueueView.init();
    RoomView.init();
    MixerView.init();

    // Landing actions
    document.getElementById('btn-create-room').addEventListener('click', () => this.createRoom());
    document.getElementById('btn-join-room').addEventListener('click', () => this.joinRoom());
    document.getElementById('input-room-code').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.joinRoom();
    });

    // Check URL for room code (e.g., ?room=KRK-4A7B)
    const params = new URLSearchParams(window.location.search);
    const roomCode = params.get('room');    if (roomCode) {
      document.getElementById('input-room-code').value = roomCode;
    }

    // Load saved name
    const savedName = localStorage.getItem('karaoke-name') || '';
    document.getElementById('input-name').value = savedName;

    // Restore session if page was refreshed
    this.restoreSession();

    console.log('[App] Karaoke Party initialized');
  },

  getName() {
    const name = document.getElementById('input-name').value.trim();
    if (!name) {
      document.getElementById('input-name').focus();
      document.getElementById('input-name').style.borderColor = '#ef4444';
      return null;
    }
    localStorage.setItem('karaoke-name', name);
    this.userName = name;
    return name;
  },
  // Save session state so refresh doesn't lose host status
  saveSession() {
    const session = {
      roomId: this.roomId,
      roomCode: this.roomCode,
      guestId: this.guestId,
      userName: this.userName,
      isHost: this.isHost,
    };
    try { sessionStorage.setItem('karaoke-session', JSON.stringify(session)); } catch (e) {}
  },

  restoreSession() {
    try {
      const raw = sessionStorage.getItem('karaoke-session');
      if (!raw) return;
      const session = JSON.parse(raw);
      if (!session.roomId || !session.roomCode) return;

      // Verify room still exists
      API.getRoom(session.roomId).then(room => {
        if (!room || room.error) {
          sessionStorage.removeItem('karaoke-session');
          return;
        }
        this.roomId = session.roomId;
        this.roomCode = session.roomCode;
        this.guestId = session.guestId;
        this.userName = session.userName;
        this.isHost = session.isHost;

        // Reconnect WebSocket
        WS.connect();
        WS.joinRoom(this.roomId, this.guestId, this.userName, this.isHost);

        RoomView.show({ code: room.code, hostName: room.hostName, guests: room.guests || [] });
        QueueView.render(room.queue || []);
        this.showView('room');

        // If a song is currently playing, auto-open the mixer
        const playingSong = (room.queue || []).find(s => s.status === 'playing');
        if (playingSong && playingSong.jobId) {
          console.log(`[App] Resuming playing song: ${playingSong.title}`);
          this.showView('mixer');
          MixerView.loadAndPlay(playingSong);
        }

        console.log(`[App] Session restored: ${room.code} (host=${this.isHost})`);
      }).catch(() => {
        sessionStorage.removeItem('karaoke-session');
      });
    } catch (e) {
      sessionStorage.removeItem('karaoke-session');
    }
  },
  async createRoom() {
    const name = this.getName();
    if (!name) return;

    try {
      const data = await API.createRoom(name);
      this.roomId = data.roomId;
      this.roomCode = data.roomCode;
      this.isHost = true;

      // Connect via WebSocket as host
      WS.connect();
      WS.joinRoom(this.roomId, null, name, true);

      this.saveSession();

      RoomView.show({ code: data.roomCode, hostName: name, guests: [] });
      this.showView('room');

      // Update URL for sharing
      history.pushState(null, '', `?room=${data.roomCode}`);

      console.log(`[App] Room created: ${data.roomCode}`);
    } catch (e) {
      alert('Failed to create room: ' + e.message);
    }
  },
  async joinRoom() {
    const name = this.getName();
    if (!name) return;

    const code = document.getElementById('input-room-code').value.trim();
    if (!code) return;

    try {
      const data = await API.joinRoom(code, name);
      this.roomId = data.roomId;
      this.roomCode = data.roomCode;
      this.guestId = data.guestId;
      this.isHost = false;

      // Connect via WebSocket as guest
      WS.connect();
      WS.joinRoom(this.roomId, this.guestId, name, false);

      this.saveSession();

      RoomView.show({ code: data.roomCode, hostName: data.hostName, guests: data.guests });
      QueueView.render(data.queue || []);
      this.showView('room');

      history.pushState(null, '', `?room=${data.roomCode}`);

      console.log(`[App] Joined room: ${data.roomCode} as ${name}`);
    } catch (e) {
      alert('Failed to join room: ' + (e.message || 'Room not found'));
    }
  },
  playSong(queueIdx) {
    WS.play(queueIdx, 0);

    // Load stems and play locally — switch to mixer
    API.getRoom(this.roomId).then(r => {
      const song = r.queue[queueIdx];
      if (song && song.jobId) {
        this.showView('mixer');
        MixerView.loadAndPlay(song);
      }
    });
  },

  showView(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const el = document.getElementById(`view-${name}`);
    if (el) el.classList.add('active');
    this.currentView = name;
  },
};

// Boot
document.addEventListener('DOMContentLoaded', () => App.init());