const db = require('../models/inMemory');
const log = require('../utils/logger');

function setupSocketHandlers(io) {
  io.on('connection', (socket) => {
    log.debug(`Socket connected: ${socket.id}`);
    let currentRoomId = null;
    let currentGuestId = null;
    let isHost = false;

    // ── Join room ──
    socket.on('room:join', ({ roomId, guestId, guestName, asHost }) => {
      const room = db.getRoom(roomId);
      if (!room) return socket.emit('error', { message: 'Room not found' });

      currentRoomId = roomId;
      currentGuestId = guestId;
      isHost = !!asHost;

      socket.join(roomId);

      if (asHost) {
        room.hostId = socket.id;
        log.info(`Host connected to room ${room.code} (socket ${socket.id})`);
      } else {
        db.addGuest(roomId, guestId, guestName);
        log.info(`Guest ${guestName} connected to room ${room.code}`);
      }

      // Send current state to joiner
      socket.emit('room:state', {
        room: sanitizeRoom(room),
      });

      // Broadcast to others
      socket.to(roomId).emit('guest:joined', {
        guestId, guestName,
        guests: room.guests,
        guestCount: room.guests.length,
      });
    });

    // ── Queue events ──
    socket.on('queue:add', ({ youtubeId, title, artist, thumbnail, duration }) => {
      if (!currentRoomId) return;
      const room = db.getRoom(currentRoomId);
      if (!room) return;

      const queueItem = db.addToQueue(currentRoomId, {
        songId: youtubeId, title, artist, thumbnail, duration,
        requestedBy: currentGuestId || 'host',
        requestedByName: isHost ? room.hostName : (room.guests.find(g => g.id === currentGuestId)?.name || 'Guest'),
      });

      io.to(currentRoomId).emit('queue:updated', { queue: room.queue });
    });

    socket.on('queue:reorder', ({ queueItemId, newPosition }) => {
      if (!currentRoomId || !isHost) return;
      db.reorderQueue(currentRoomId, queueItemId, newPosition);
      const room = db.getRoom(currentRoomId);
      if (room) io.to(currentRoomId).emit('queue:updated', { queue: room.queue });
    });

    socket.on('queue:remove', ({ queueItemId }) => {
      if (!currentRoomId || !isHost) return;
      db.removeFromQueue(currentRoomId, queueItemId);
      const room = db.getRoom(currentRoomId);
      if (room) io.to(currentRoomId).emit('queue:updated', { queue: room.queue });
    });

    // ── Playback events (host only) ──
    socket.on('playback:play', ({ queueIdx, fromTime }) => {
      if (!currentRoomId || !isHost) return;
      const room = db.getRoom(currentRoomId);
      if (!room) return;

      room.currentQueueIdx = queueIdx ?? room.currentQueueIdx;
      room.playback.state = 'playing';
      room.playback.startedAt = Date.now();
      room.playback.offsetSec = fromTime || 0;

      const currentSong = room.queue[room.currentQueueIdx] || null;
      if (currentSong) currentSong.status = 'playing';

      io.to(currentRoomId).emit('playback:started', {
        currentSong,
        queueIdx: room.currentQueueIdx,
        playback: room.playback,
      });
    });

    socket.on('playback:pause', () => {
      if (!currentRoomId || !isHost) return;
      const room = db.getRoom(currentRoomId);
      if (!room) return;

      // Calculate current position
      if (room.playback.state === 'playing' && room.playback.startedAt) {
        const elapsed = (Date.now() - room.playback.startedAt) / 1000;
        room.playback.offsetSec += elapsed * (room.playback.tempoPercent / 100);
      }
      room.playback.state = 'paused';
      room.playback.startedAt = null;

      io.to(currentRoomId).emit('playback:paused', {
        currentTime: room.playback.offsetSec,
      });
    });

    socket.on('playback:seek', ({ time }) => {
      if (!currentRoomId || !isHost) return;
      const room = db.getRoom(currentRoomId);
      if (!room) return;

      room.playback.offsetSec = time;
      if (room.playback.state === 'playing') {
        room.playback.startedAt = Date.now();
      }

      io.to(currentRoomId).emit('playback:seeked', { time });
    });

    socket.on('playback:control', ({ keyShift, tempoPercent, lyricsOffset }) => {
      if (!currentRoomId || !isHost) return;
      const room = db.getRoom(currentRoomId);
      if (!room) return;

      if (keyShift !== undefined) room.playback.keyShift = keyShift;
      if (tempoPercent !== undefined) room.playback.tempoPercent = tempoPercent;
      if (lyricsOffset !== undefined) room.playback.lyricsOffset = lyricsOffset;

      io.to(currentRoomId).emit('playback:controlUpdate', {
        keyShift: room.playback.keyShift,
        tempoPercent: room.playback.tempoPercent,
        lyricsOffset: room.playback.lyricsOffset,
      });
    });

    // ── Stem mix from participants ──
    socket.on('playback:stemMix', (data) => {
      if (!currentRoomId) return;
      // Forward stem mix request to host so it can adjust audio
      const room = db.getRoom(currentRoomId);
      if (!room || !room.hostId) return;
      io.to(room.hostId).emit('playback:stemMix', {
        fromGuest: currentGuestId,
        leadVocals: data.leadVocals,
        backingVocals: data.backingVocals,
        music: data.music,
      });
    });

    // ── Next song ──
    socket.on('playback:next', () => {
      if (!currentRoomId || !isHost) return;
      const room = db.getRoom(currentRoomId);
      if (!room) return;

      // Mark current as played
      const current = room.queue[room.currentQueueIdx];
      if (current) current.status = 'played';

      // Find next ready song
      let nextIdx = -1;
      for (let i = room.currentQueueIdx + 1; i < room.queue.length; i++) {
        if (room.queue[i].status === 'ready') { nextIdx = i; break; }
      }

      if (nextIdx >= 0) {
        room.currentQueueIdx = nextIdx;
        room.playback.state = 'stopped';
        room.playback.offsetSec = 0;
        room.playback.keyShift = 0;
        room.playback.lyricsOffset = 0;

        io.to(currentRoomId).emit('playback:nextSong', {
          currentSong: room.queue[nextIdx],
          queueIdx: nextIdx,
          queue: room.queue,
        });
      } else {
        room.playback.state = 'stopped';
        io.to(currentRoomId).emit('playback:queueEmpty', {});
      }
    });

    // ── Disconnect ──
    socket.on('disconnect', () => {
      if (currentRoomId) {
        const room = db.getRoom(currentRoomId);
        if (room) {
          if (isHost) {
            log.info(`Host disconnected from room ${room.code}`);
            // Don't delete room — host may reconnect
          } else {
            db.removeGuest(currentRoomId, currentGuestId);
            socket.to(currentRoomId).emit('guest:left', {
              guestId: currentGuestId,
              guests: room.guests,
              guestCount: room.guests.length,
            });
          }
        }
      }
      log.debug(`Socket disconnected: ${socket.id}`);
    });
  });
}

function sanitizeRoom(room) {
  return {
    id: room.id,
    code: room.code,
    hostName: room.hostName,
    guests: room.guests,
    queue: room.queue,
    currentQueueIdx: room.currentQueueIdx,
    playback: room.playback,
  };
}

module.exports = { setupSocketHandlers };