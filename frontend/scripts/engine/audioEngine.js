// ═══════════════════════════════════════════════════════════════════
// Audio Engine — SharedWSOLA real-time pitch/tempo engine
// Ported from the proven karaoke-mixer.html prototype.
//
// Architecture:
//   FIFO          — ring buffer for interleaved stereo audio frames
//   SharedWSOLA   — SoundTouch-style WSOLA + rate transposer
//                   One cross-correlation on stem 0, same segment
//                   boundaries applied to all stems → perfect sync
//   AudioEngine   — public API used by mixerView
//
// Pipeline per process() call:
//   Input FIFOs → WSOLA time-stretch → Rate Transposer → Output FIFOs
//   Net effect: speed = tempo, pitch = pitch (independent control)
// ═══════════════════════════════════════════════════════════════════

'use strict';

// ── FIFO ring buffer for interleaved audio frames ──
class FIFO {
  constructor(ch) {
    this.ch = ch;
    this.buf = new Float32Array(65536 * ch);
    this.s = 0; this.n = 0;
  }
  get frames() { return this.n; }
  clear() { this.s = 0; this.n = 0; }
  _compact() {
    if (this.s > 0 && this.n > 0) {
      const c = this.ch, src = this.s * c, len = this.n * c;
      this.buf.copyWithin(0, src, src + len);
    }
    this.s = 0;
  }
  _grow(need) {
    const total = (this.s + this.n + need) * this.ch;
    if (total <= this.buf.length) return;
    this._compact();
    const need2 = (this.n + need) * this.ch;
    if (need2 > this.buf.length) {
      const nb = new Float32Array(Math.max(need2 * 2, 131072));
      nb.set(this.buf.subarray(0, this.n * this.ch));
      this.buf = nb;
    }
  }
  push(data, frames) {
    this._grow(frames);
    const off = (this.s + this.n) * this.ch;
    this.buf.set(data.subarray(0, frames * this.ch), off);
    this.n += frames;
  }
  at(frameOff) { return this.buf.subarray((this.s + frameOff) * this.ch); }
  drop(frames) {
    frames = Math.min(frames, this.n);
    this.s += frames; this.n -= frames;
    if (this.n === 0) this.s = 0;
    else if (this.s > 32768) this._compact();
  }
  read(output, frames) {
    frames = Math.min(frames, this.n);
    if (frames > 0) output.set(this.buf.subarray(this.s * this.ch, (this.s + frames) * this.ch));
    this.drop(frames);
    return frames;
  }
}


// ── SharedWSOLA: multi-stem WSOLA + rate transposer ──
// Parameters tuned for 44100 Hz (SoundTouch defaults):
//   overlap  = 12 ms  ≈ 529 frames
//   sequence = 82 ms  ≈ 3616 frames
//   seekWin  = 15 ms  ≈ 661 frames
class SharedWSOLA {
  constructor(numCh, sampleRate) {
    this.ch = numCh;
    this.sr = sampleRate;
    this.overlapLen = Math.round(0.012 * sampleRate);
    this.seqLen = Math.round(0.082 * sampleRate);
    this.seekWinLen = Math.round(0.015 * sampleRate);
    this.stemInputs = [];
    this.stemOutputs = [];
    this.stemPrevOvl = [];
    this.transposers = [];
    this._tempo = 1.0;
    this._pitch = 1.0;
    this.nominalSkip = this.seqLen - this.overlapLen;
    this.inputNeeded = this.seekWinLen + this.seqLen;
    this.skipFrac = 0;
    this.fresh = true;
    this.transFrac = 0;
  }

  addStem() {
    this.stemInputs.push(new FIFO(this.ch));
    this.stemOutputs.push(new FIFO(this.ch));
    this.stemPrevOvl.push(new Float32Array(this.overlapLen * this.ch));
    this.transposers.push(new FIFO(this.ch));
  }

  set tempo(v) { this._tempo = Math.max(0.25, Math.min(2.5, v)); this._sync(); }
  get tempo() { return this._tempo; }
  set pitch(v) { this._pitch = Math.max(0.5, Math.min(2.0, v)); this._sync(); }
  get pitch() { return this._pitch; }

  _sync() {
    const sf = this._tempo / this._pitch;
    this.nominalSkip = sf * (this.seqLen - this.overlapLen);
    this.inputNeeded = this.seekWinLen + this.seqLen;
  }

  _allReady() {
    for (let i = 0; i < this.stemInputs.length; i++)
      if (this.stemInputs[i].frames < this.inputNeeded) return false;
    return this.stemInputs.length > 0;
  }

  // Cross-correlate on stem 0 only — same offset for all stems
  _seekBest() {
    const ref = this.stemInputs[0], prev = this.stemPrevOvl[0];
    const ch = this.ch, ovl = this.overlapLen, step = ch > 1 ? 2 : 1;
    let bestC = -1e30, bestO = 0;
    for (let off = 0; off < this.seekWinLen; off++) {
      const src = ref.at(off);
      let c = 0;
      for (let i = 0; i < ovl * ch; i += step) c += src[i] * prev[i];
      if (c > bestC) { bestC = c; bestO = off; }
    }
    return bestO;
  }

  _processSegment() {
    const ch = this.ch, ovl = this.overlapLen, seq = this.seqLen;
    const midLen = seq - 2 * ovl;
    const bestOff = this._seekBest();

    for (let s = 0; s < this.stemInputs.length; s++) {
      const inp = this.stemInputs[s], out = this.stemOutputs[s], prev = this.stemPrevOvl[s];
      const src = inp.at(bestOff);

      // Overlap-add crossfade
      const ovlBuf = new Float32Array(ovl * ch);
      for (let i = 0; i < ovl; i++) {
        const w = i / ovl;
        for (let c2 = 0; c2 < ch; c2++) {
          const idx = i * ch + c2;
          ovlBuf[idx] = prev[idx] * (1 - w) + src[idx] * w;
        }
      }
      out.push(ovlBuf, ovl);

      // Middle section (no crossfade)
      if (midLen > 0) {
        const m = inp.at(bestOff + ovl);
        const mb = new Float32Array(midLen * ch);
        mb.set(m.subarray(0, midLen * ch));
        out.push(mb, midLen);
      }

      // Save tail for next overlap
      const tail = inp.at(bestOff + seq - ovl);
      prev.set(tail.subarray(0, ovl * ch));
    }

    // Advance input by nominalSkip (fractional accumulation)
    const skip = Math.max(1, Math.floor(this.nominalSkip + this.skipFrac + 0.5));
    this.skipFrac += this.nominalSkip - skip;
    for (let s = 0; s < this.stemInputs.length; s++) this.stemInputs[s].drop(skip);
  }

  // Linear interpolation rate transposer — applies the pitch ratio
  _transpose() {
    const rate = this._pitch;
    let minA = Infinity;
    for (let s = 0; s < this.stemOutputs.length; s++)
      minA = Math.min(minA, this.stemOutputs[s].frames);

    // Pitch = 1.0 → passthrough (no interpolation needed)
    if (rate === 1.0) {
      for (let s = 0; s < this.stemOutputs.length; s++) {
        const a = this.stemOutputs[s].frames;
        if (a > 0) {
          const t = new Float32Array(a * this.ch);
          this.stemOutputs[s].read(t, a);
          this.transposers[s].push(t, a);
        }
      }
      return;
    }

    if (minA < 2) return;
    const ch = this.ch, limit = minA - 1;
    let pos = this.transFrac, outCount = 0, tp = pos;
    while (tp < limit) { outCount++; tp += rate; }
    if (outCount === 0) return;

    for (let s = 0; s < this.stemOutputs.length; s++) {
      const src = this.stemOutputs[s].at(0);
      const out = new Float32Array(outCount * ch);
      let p = pos, oi = 0;
      while (p < limit && oi < outCount) {
        const ip = Math.floor(p), f = p - ip, s1 = ip * ch;
        for (let c = 0; c < ch; c++)
          out[oi * ch + c] = src[s1 + c] * (1 - f) + src[s1 + ch + c] * f;
        oi++; p += rate;
      }
      this.transposers[s].push(out, oi);
    }

    const consumed = Math.floor(pos + outCount * rate) - Math.floor(pos);
    this.transFrac = (pos + outCount * rate) - Math.floor(pos + outCount * rate);
    for (let s = 0; s < this.stemOutputs.length; s++) this.stemOutputs[s].drop(consumed);
  }

  process() {
    // Bootstrap: prime the overlap buffer on first call
    if (this.fresh && this._allReady()) {
      const ovl = this.overlapLen, ch = this.ch;
      for (let s = 0; s < this.stemInputs.length; s++) {
        this.stemPrevOvl[s].set(this.stemInputs[s].at(0).subarray(0, ovl * ch));
        this.stemInputs[s].drop(ovl);
      }
      this.fresh = false;
    }
    while (this._allReady()) this._processSegment();
    this._transpose();
  }

  readStem(idx, output, maxF) { return this.transposers[idx].read(output, maxF); }
  stemAvail(idx) { return this.transposers[idx].frames; }

  clear() {
    for (let s = 0; s < this.stemInputs.length; s++) {
      this.stemInputs[s].clear();
      this.stemOutputs[s].clear();
      this.stemPrevOvl[s].fill(0);
      this.transposers[s].clear();
    }
    this.fresh = true;
    this.skipFrac = 0;
    this.transFrac = 0;
  }
}


// ── Public API (used by mixerView.js) ──
const AudioEngine = { FIFO, SharedWSOLA };
