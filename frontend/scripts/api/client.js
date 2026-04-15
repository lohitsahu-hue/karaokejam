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

  // Upload audio file (FormData)
  async uploadAudio(roomId, formData) {
    const res = await fetch(this.base + `/api/rooms/${roomId}/upload`, {
      method: 'POST',
      body: formData, // browser sets multipart Content-Type
    });
    if (!res.ok) {
      let msg = 'Upload failed';
      try { const j = await res.json(); msg = j.error || msg; } catch (e) {}
      throw new Error(msg);
    }
    return res.json();
  },

  // Jobs
  getJob(jobId) { return this.get(`/api/jobs/${jobId}`); },

  // Stems
  stemUrl(jobId, stemName) { return `/api/stems/${jobId}/${stemName}`; },
};