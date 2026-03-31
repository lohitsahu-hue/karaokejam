// MicEngine — Phone-side mic capture with studio-quality audio processing
// Streams enhanced audio to host via WebRTC
//
// Audio chain: High-pass (80Hz) → Noise Gate → Compressor → Presence EQ →
//              Low-mid cut → De-esser → Reverb → Output

const MicEngine = {
  state: 'off',  // 'off' | 'local' | 'connecting' | 'live'
  socket: null,
  stream: null,
  ctx: null,
  sourceNode: null,
  analyser: null,

  // Processing nodes
  highPass: null,
  compressor: null,
  presenceEQ: null,
  lowMidCut: null,
  deesser: null,
  reverbSend: null,
  reverbReturn: null,
  convolver: null,
  dryGain: null,
  wetGain: null,
  masterGain: null,
  noiseGate: null,

  // WebRTC
  pc: null,
  monitorGain: null,

  // Callbacks
  onStateChange: null,
  onLevelChange: null,

  // Settings
  enhancementOn: true,
  reverbMix: 0.15,
  monitorVol: 0,

  init(socket) {
    this.socket = socket;
  },

  async startMic() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
        },
        video: false,
      });

      this.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
      this.sourceNode = this.ctx.createMediaStreamSource(this.stream);

      this._buildAudioChain();
      this._setState('local');
    } catch (err) {
      console.error('[MicEngine] Failed to get mic:', err);
      throw err;
    }
  },

  _buildAudioChain() {
    const ctx = this.ctx;

    // 1. High-pass filter — remove rumble below 80Hz
    this.highPass = ctx.createBiquadFilter();
    this.highPass.type = 'highpass';
    this.highPass.frequency.value = 80;
    this.highPass.Q.value = 0.7;

    // 2. Noise gate (using a gain node controlled by analyser)
    this.noiseGate = ctx.createGain();
    this.noiseGate.gain.value = 1;

    // 3. Compressor — tame dynamics (3:1 ratio)
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -24;
    this.compressor.knee.value = 12;
    this.compressor.ratio.value = 3;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.15;

    // 4. Presence EQ — add clarity at 3.5kHz (+4dB)
    this.presenceEQ = ctx.createBiquadFilter();
    this.presenceEQ.type = 'peaking';
    this.presenceEQ.frequency.value = 3500;
    this.presenceEQ.gain.value = 4;
    this.presenceEQ.Q.value = 1.2;

    // 5. Low-mid cut — reduce muddiness at 300Hz (-2dB)
    this.lowMidCut = ctx.createBiquadFilter();
    this.lowMidCut.type = 'peaking';
    this.lowMidCut.frequency.value = 300;
    this.lowMidCut.gain.value = -2;
    this.lowMidCut.Q.value = 1.0;

    // 6. De-esser — tame sibilance at 6kHz
    this.deesser = ctx.createBiquadFilter();
    this.deesser.type = 'peaking';
    this.deesser.frequency.value = 6000;
    this.deesser.gain.value = -3;
    this.deesser.Q.value = 2.0;

    // 7. Reverb (convolver with programmatic impulse response)
    this.convolver = ctx.createConvolver();
    this.convolver.buffer = this._createReverbImpulse(0.8, 2.0);

    this.dryGain = ctx.createGain();
    this.dryGain.gain.value = 1 - this.reverbMix;

    this.wetGain = ctx.createGain();
    this.wetGain.gain.value = this.reverbMix;

    // Master output gain
    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = 1.0;

    // Monitor (local playback through earbuds)
    this.monitorGain = ctx.createGain();
    this.monitorGain.gain.value = this.monitorVol;

    // Analyser for level metering
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.8;

    // Wire the chain
    this.sourceNode.connect(this.highPass);
    this.highPass.connect(this.noiseGate);
    this.noiseGate.connect(this.compressor);
    this.compressor.connect(this.presenceEQ);
    this.presenceEQ.connect(this.lowMidCut);
    this.lowMidCut.connect(this.deesser);

    // Split into dry + wet (reverb)
    this.deesser.connect(this.dryGain);
    this.deesser.connect(this.convolver);
    this.convolver.connect(this.wetGain);

    // Merge dry + wet into master
    this.dryGain.connect(this.masterGain);
    this.wetGain.connect(this.masterGain);

    // Master → analyser + monitor
    this.masterGain.connect(this.analyser);
    this.masterGain.connect(this.monitorGain);
    this.monitorGain.connect(ctx.destination);

    // Start level metering
    this._startLevelMeter();

    // Start noise gate processing
    this._startNoiseGate();
  },

  _createReverbImpulse(duration, decay) {
    const ctx = this.ctx;
    const sampleRate = ctx.sampleRate;
    const length = sampleRate * duration;
    const impulse = ctx.createBuffer(2, length, sampleRate);

    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        // Early reflections (first 30ms)
        const earlyEnd = sampleRate * 0.03;
        if (i < earlyEnd) {
          // Sparse early reflections
          if (i % Math.floor(sampleRate * 0.005) < 2) {
            data[i] = (Math.random() * 2 - 1) * 0.6;
          }
        }
        // Diffuse tail with exponential decay
        data[i] += (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
        // Stereo spread — slight offset between channels
        if (ch === 1 && i > 2) {
          data[i] = data[i] * 0.95 + data[i - 2] * 0.05;
        }
      }
    }
    return impulse;
  },

  _noiseGateRAF: null,
  _startNoiseGate() {
    const bufLen = this.analyser.frequencyBinCount;
    const dataArr = new Uint8Array(bufLen);
    const threshold = -50; // dB
    let gateOpen = true;

    const check = () => {
      if (this.state === 'off') return;
      this.analyser.getByteFrequencyData(dataArr);
      let sum = 0;
      for (let i = 0; i < bufLen; i++) sum += dataArr[i];
      const avg = sum / bufLen;
      const dB = avg > 0 ? 20 * Math.log10(avg / 255) : -100;

      if (dB < threshold && gateOpen) {
        gateOpen = false;
        this.noiseGate.gain.linearRampToValueAtTime(0.01, this.ctx.currentTime + 0.02);
      } else if (dB >= threshold && !gateOpen) {
        gateOpen = true;
        this.noiseGate.gain.linearRampToValueAtTime(1.0, this.ctx.currentTime + 0.005);
      }
      this._noiseGateRAF = requestAnimationFrame(check);
    };
    check();
  },

  _levelRAF: null,
  _startLevelMeter() {
    const bufLen = this.analyser.frequencyBinCount;
    const dataArr = new Uint8Array(bufLen);

    const meter = () => {
      if (this.state === 'off') return;
      this.analyser.getByteFrequencyData(dataArr);
      let sum = 0;
      for (let i = 0; i < bufLen; i++) sum += dataArr[i];
      const level = sum / (bufLen * 255); // 0-1
      if (this.onLevelChange) this.onLevelChange(level);
      this._levelRAF = requestAnimationFrame(meter);
    };
    meter();
  },

  async connectToHost() {
    if (!this.socket || !this.masterGain) return;
    this._setState('connecting');

    // Create a MediaStream from our processed audio
    const dest = this.ctx.createMediaStreamDestination();
    this.masterGain.connect(dest);

    // Create WebRTC peer connection with STUN + TURN for reliability
    this.pc = new RTCPeerConnection({
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

    // Add audio track to peer connection
    const audioTrack = dest.stream.getAudioTracks()[0];
    this.pc.addTrack(audioTrack, dest.stream);

    // ICE candidate handling
    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.socket.emit('mic:ice-candidate', {
          candidate: e.candidate,
          targetSocketId: '_host_',
        });
      }
    };

    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'connected') {
        this._setState('live');
      } else if (s === 'disconnected' || s === 'failed' || s === 'closed') {
        this._setState('local');
      }
    };

    // Listen for answer from host
    this.socket.on('mic:answer', ({ answer }) => {
      if (this.pc && this.pc.signalingState !== 'stable') {
        this.pc.setRemoteDescription(new RTCSessionDescription(answer));
      }
    });

    this.socket.on('mic:ice-candidate', ({ candidate }) => {
      if (this.pc && candidate) {
        this.pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
    });

    // Create and send offer
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    this.socket.emit('mic:offer', {
      offer: this.pc.localDescription,
      targetSocketId: '_host_',
    });
  },

  stopMic() {
    // Stop WebRTC
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }

    // Notify server
    if (this.socket) {
      this.socket.emit('mic:stop');
      this.socket.off('mic:answer');
      this.socket.off('mic:ice-candidate');
    }

    // Stop animations
    if (this._noiseGateRAF) cancelAnimationFrame(this._noiseGateRAF);
    if (this._levelRAF) cancelAnimationFrame(this._levelRAF);

    // Disconnect audio nodes
    if (this.sourceNode) {
      try { this.sourceNode.disconnect(); } catch (e) {}
    }

    // Stop mic stream tracks
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }

    // Close audio context
    if (this.ctx && this.ctx.state !== 'closed') {
      this.ctx.close();
      this.ctx = null;
    }

    this._setState('off');
  },

  setMonitorVolume(val) {
    this.monitorVol = val;
    if (this.monitorGain) {
      this.monitorGain.gain.value = val;
    }
  },

  setReverbMix(val) {
    this.reverbMix = val;
    if (this.dryGain) this.dryGain.gain.value = 1 - val;
    if (this.wetGain) this.wetGain.gain.value = val;
  },

  setEnhancement(on) {
    this.enhancementOn = on;
    if (!this.ctx) return;

    if (on) {
      // Re-enable processing
      this.presenceEQ.gain.value = 4;
      this.lowMidCut.gain.value = -2;
      this.deesser.gain.value = -3;
      this.compressor.threshold.value = -24;
    } else {
      // Bypass processing (flatten EQ, disable compression)
      this.presenceEQ.gain.value = 0;
      this.lowMidCut.gain.value = 0;
      this.deesser.gain.value = 0;
      this.compressor.threshold.value = 0;
    }
  },

  get isLive() {
    return this.state === 'live';
  },

  _setState(newState) {
    this.state = newState;
    if (this.onStateChange) this.onStateChange(newState);
  },
};
