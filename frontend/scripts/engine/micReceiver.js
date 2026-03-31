// MicReceiver — Host-side WebRTC receiver for live singer mics
// Receives audio streams from participants and routes them into the mixer

const MicReceiver = {
  socket: null,
  audioCtx: null,
  destination: null,  // GainNode to connect mic audio into
  mics: {},           // { socketId: { pc, stream, source, gain, guestName, guestId } }

  // Callbacks
  onMicConnected: null,    // (socketId, guestName, guestId)
  onMicDisconnected: null, // (socketId, guestName, guestId)

  init(socket, audioContext, destinationNode) {
    this.socket = socket;
    this.audioCtx = audioContext;
    this.destination = destinationNode;

    // Listen for WebRTC offers from singers
    socket.on('mic:offer', async ({ offer, fromSocketId, guestName, guestId }) => {
      console.log(`[MicReceiver] Incoming mic from ${guestName} (${fromSocketId})`);
      await this._handleOffer(offer, fromSocketId, guestName, guestId);
    });

    // ICE candidates from singers
    socket.on('mic:ice-candidate', ({ candidate, fromSocketId }) => {
      const mic = this.mics[fromSocketId];
      if (mic && mic.pc && candidate) {
        mic.pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
    });

    // Singer stopped their mic
    socket.on('mic:stopped', ({ socketId, guestName, guestId }) => {
      console.log(`[MicReceiver] Mic stopped: ${guestName}`);
      this._removeMic(socketId, guestName, guestId);
    });
  },

  async _handleOffer(offer, fromSocketId, guestName, guestId) {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        {
          urls: 'turn:openrelay.metered.ca:80',
          username: 'openrelayproject',
          credential: 'openrelayproject',
        },
        {
          urls: 'turn:openrelay.metered.ca:443',
          username: 'openrelayproject',
          credential: 'openrelayproject',
        },
      ],
    });

    // Store mic info
    this.mics[fromSocketId] = { pc, stream: null, source: null, gain: null, guestName, guestId };

    // ICE candidate → send back to singer
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.socket.emit('mic:ice-candidate', {
          candidate: e.candidate,
          targetSocketId: fromSocketId,
        });
      }
    };

    // When we receive the audio track
    pc.ontrack = (e) => {
      const stream = e.streams[0];
      const mic = this.mics[fromSocketId];
      if (!mic) return;

      mic.stream = stream;
      mic.source = this.audioCtx.createMediaStreamSource(stream);
      mic.gain = this.audioCtx.createGain();
      mic.gain.gain.value = 0.8; // default mic volume

      mic.source.connect(mic.gain);
      mic.gain.connect(this.destination);

      console.log(`[MicReceiver] ${guestName} mic audio routed to mixer`);
      if (this.onMicConnected) {
        this.onMicConnected(fromSocketId, guestName, guestId);
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        this._removeMic(fromSocketId, guestName, guestId);
      }
    };

    // Set remote offer and create answer
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    this.socket.emit('mic:answer', {
      answer: pc.localDescription,
      targetSocketId: fromSocketId,
    });
  },

  _removeMic(socketId, guestName, guestId) {
    const mic = this.mics[socketId];
    if (!mic) return;

    if (mic.source) try { mic.source.disconnect(); } catch (e) {}
    if (mic.gain) try { mic.gain.disconnect(); } catch (e) {}
    if (mic.pc) mic.pc.close();

    delete this.mics[socketId];

    if (this.onMicDisconnected) {
      this.onMicDisconnected(socketId, guestName, guestId);
    }
  },

  setMicVolume(socketId, value) {
    const mic = this.mics[socketId];
    if (mic && mic.gain) {
      mic.gain.gain.value = value;
    }
  },

  setAllMicVolume(value) {
    Object.values(this.mics).forEach(mic => {
      if (mic.gain) mic.gain.gain.value = value;
    });
  },

  getMics() {
    return Object.entries(this.mics).map(([id, m]) => ({
      socketId: id,
      guestName: m.guestName,
      guestId: m.guestId,
    }));
  },

  disconnectAll() {
    Object.keys(this.mics).forEach(id => {
      const m = this.mics[id];
      this._removeMic(id, m.guestName, m.guestId);
    });
  },
};
