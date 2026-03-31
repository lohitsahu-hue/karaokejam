// Simple fetch wrapper for REST API
const API = {
  base: '', // same origin

  async post(path, body) {
    const res = await fetch(this.base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  },

  async get(path) {
    const res = await fetch(this.base + path);
    return res.json();
  },

  async del(path) {
    const res = await fetch(this.base + path, { method: 'DELETE' });
    return res.json();
  },

  // Room
  createRoom(hostName) { return this.post('/api/rooms', { hostName }); },
  joinRoom(code, guestName) { return this.post('/api/rooms/join', { code, guestName }); },
  getRoom(roomId) { return this.get(`/api/rooms/${roomId}`); },

  // Search
  searchYouTube(query) { return this.post('/api/search/youtube', { query }); },
  searchLyrics(query) { return this.post('/api/search/lyrics', { query }); },

  // Queue
  addToQueue(roomId, song) { return this.post(`/api/rooms/${roomId}/queue`, song); },
  getQueue(roomId) { return this.get(`/api/rooms/${roomId}/queue`); },
  removeFromQueue(roomId, itemId) { return this.del(`/api/rooms/${roomId}/queue/${itemId}`); },

  // Jobs
  getJob(jobId) { return this.get(`/api/jobs/${jobId}`); },

  // Stems
  stemUrl(jobId, stemName) { return `/api/stems/${jobId}/${stemName}`; },
};