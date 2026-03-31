// Socket.IO client wrapper
const WS = {
  socket: null,
  listeners: new Map(),

  connect() {
    this.socket = io();
    this.socket.on('connect', () => console.log('[WS] connected:', this.socket.id));
    this.socket.on('disconnect', () => console.log('[WS] disconnected'));
    this.socket.on('error', (err) => console.error('[WS] error:', err));
  },

  joinRoom(roomId, guestId, guestName, asHost = false) {
    if (!this.socket) this.connect();
    this.socket.emit('room:join', { roomId, guestId, guestName, asHost });
  },

  // Queue
  addToQueue(song) { this.socket?.emit('queue:add', song); },
  reorderQueue(queueItemId, newPosition) { this.socket?.emit('queue:reorder', { queueItemId, newPosition }); },
  removeFromQueue(queueItemId) { this.socket?.emit('queue:remove', { queueItemId }); },

  // Playback
  play(queueIdx, fromTime) { this.socket?.emit('playback:play', { queueIdx, fromTime }); },
  pause() { this.socket?.emit('playback:pause'); },
  seek(time) { this.socket?.emit('playback:seek', { time }); },
  control(data) { this.socket?.emit('playback:control', data); },
  next() { this.socket?.emit('playback:next'); },

  // Listen for events
  on(event, callback) {
    if (!this.socket) this.connect();
    this.socket.on(event, callback);
  },

  off(event, callback) {
    this.socket?.off(event, callback);
  },
};