// Synthesised sound: layered SFX through stereo panning, a generated-impulse reverb and a
// compressor/limiter, procedural synthwave music (folk metal in boss fights), weather ambience and an engine loop.
// Nothing is loaded from disk.

const FIELD = 208;
/** effects bus trim: the make-up gain the shared compressor used to add (effects now skip it) */
const SFX_TRIM = 1.68;
/** in front of the limiter: cancels its automatic make-up gain (see build()) */
const LIM_PRE = 0.76;
const rnd = Math.random;
const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** 'play' = arcade stages; 'region' = a campaign region's own theme (setRegionMusic) */
export type MusicMode = 'off' | 'menu' | 'play' | 'calm' | 'boss' | 'region';
/** Region themes in campaign order (REGION_TABLE kinds) */
export const REGION_THEMES = ['farm', 'rail', 'delta', 'ruins', 'winter'];

export class Sound {
  ctx: AudioContext | null = null;
  muted: boolean;
  sfxVol = 0.8;
  musicVol = 0.45;
  private c!: BaseAudioContext;
  private master!: GainNode;
  private sfx!: GainNode;
  private mus!: GainNode;
  private revIn!: GainNode;
  private white!: AudioBuffer;
  private brown!: AudioBuffer;
  private pink!: AudioBuffer;
  private curve!: Float32Array<ArrayBuffer>;
  private music: Music | null = null;
  private wantMusic: MusicMode = 'off';
  private wantTheme = 0;
  private wantFight = false;
  private eng: { bus: GainNode; osc: GainNode; rum: GainNode; clat: GainNode; o1: OscillatorNode; o2: OscillatorNode; lfo: OscillatorNode } | null = null;
  private amb: { rain: GainNode; wind: GainNode; drops: GainNode[] } | null = null;
  private wantAmb = 'none';
  private ambOn = '';
  private rainLevel = 0;
  private rainNext = 0;
  private rainTimer: number | null = null;
  private duckEnd = 0;
  private duckAmt = 1;
  /** boss-charge: beeps of one warning so far, and when the last one sounded (it rises over the warning) */
  private chargeN = 0;
  private chargeT = -1;

  constructor(muted: boolean) {
    this.muted = muted;
    const unlock = () => this.init();
    window.addEventListener('keydown', unlock);
    window.addEventListener('pointerdown', unlock);
  }

  init(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.build(this.ctx);
      this.setRegionMusic(this.wantTheme, this.wantFight);
      this.setMusic(this.wantMusic);
      this.ambience(this.wantAmb);
    } catch {
      this.ctx = null;
    }
  }

  /** Builds the mixer on any context (also used for offline level tests). */
  build(c: BaseAudioContext): void {
    this.c = c;
    // the compressor is for music only: effects go straight to the limiter, so shots keep their punch and the
    // music no longer pumps with every shot (ducking does that job, on purpose and gently)
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    // limiter: hard above -6 dB. Web Audio adds its own make-up gain to every compressor (here about +3.4 dB),
    // so LIM_PRE takes that back off in front of it: below the ceiling the gain is what it was, peaks stop near 0.78
    const lim = c.createDynamicsCompressor();
    lim.threshold.value = -6;
    lim.knee.value = 2;
    lim.ratio.value = 20;
    lim.attack.value = 0.001;
    lim.release.value = 0.25;
    const limPre = c.createGain();
    limPre.gain.value = LIM_PRE;
    this.master = c.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    this.master.connect(limPre).connect(lim).connect(c.destination);
    comp.connect(this.master);
    this.sfx = c.createGain();
    this.sfx.gain.value = this.sfxVol;
    // the compressor's automatic make-up gain used to lift every effect by about 4.5 dB: this restores it
    const sfxTrim = c.createGain();
    sfxTrim.gain.value = SFX_TRIM;
    this.sfx.connect(sfxTrim).connect(this.master);
    this.mus = c.createGain();
    this.mus.gain.value = this.musicVol * 0.55;
    this.mus.connect(comp);
    const rev = c.createConvolver();
    rev.buffer = this.impulse(2.4);
    this.revIn = c.createGain();
    const revOut = c.createGain();
    revOut.gain.value = 0.42 * SFX_TRIM; // effects and music both send here, and both used to pass the compressor
    this.revIn.connect(rev).connect(revOut).connect(this.master);
    this.white = this.noiseBuf(false);
    this.brown = this.noiseBuf(true);
    this.pink = this.pinkBuf();
    const n = 1024;
    this.curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      this.curve[i] = Math.tanh(x * 2.2) / Math.tanh(2.2);
    }
    this.music = new Music(this, c, this.mus, this.revIn);
  }

  private impulse(sec: number): AudioBuffer {
    const c = this.c;
    const len = Math.floor(c.sampleRate * sec);
    const b = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        lp += (rnd() * 2 - 1 - lp) * (0.6 - t * 0.45);
        d[i] = lp * Math.pow(1 - t, 2.6) * (i < c.sampleRate * 0.012 ? i / (c.sampleRate * 0.012) : 1);
      }
    }
    return b;
  }

  /** 4 s of noise that loops without a step (brown noise is detrended so its ends meet). */
  private noiseBuf(brown: boolean): AudioBuffer {
    const c = this.c;
    const b = c.createBuffer(1, c.sampleRate * 4, c.sampleRate);
    const d = b.getChannelData(0);
    const n = d.length;
    let last = 0;
    for (let i = 0; i < n; i++) {
      const w = rnd() * 2 - 1;
      if (brown) {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      } else d[i] = w;
    }
    if (brown) {
      const drift = d[n - 1] - d[0];
      let mean = 0;
      for (let i = 0; i < n; i++) {
        d[i] -= (drift * i) / (n - 1);
        mean += d[i];
      }
      mean /= n;
      for (let i = 0; i < n; i++) d[i] -= mean;
    }
    return b;
  }

  /** 4 s of pink noise, cross-faded at the ends so it loops without a seam. */
  private pinkBuf(): AudioBuffer {
    const c = this.c;
    const n = c.sampleRate * 4;
    const m = 4096;
    const raw = new Float32Array(n + m);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < raw.length; i++) {
      const w = rnd() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      raw[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
    }
    const b = c.createBuffer(1, n, c.sampleRate);
    const d = b.getChannelData(0);
    d.set(raw.subarray(0, n));
    for (let i = 0; i < m; i++) d[i] = d[i] * (i / m) + raw[n + i] * (1 - i / m);
    return b;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.03);
  }

  setVolumes(sfx: number, music: number): void {
    this.sfxVol = sfx;
    this.musicVol = music;
    if (!this.ctx) return;
    this.sfx.gain.setTargetAtTime(sfx, this.ctx.currentTime, 0.05);
    this.mus.gain.setTargetAtTime(music * 0.55, this.ctx.currentTime, 0.05);
  }

  setMusic(m: MusicMode): void {
    this.wantMusic = m;
    if (this.ctx && this.music) this.music.setMode(m);
  }

  /** Campaign region music ('region' mode): the region's theme (index into REGION_THEMES) and whether a fight is
   *  on. In a fight the drums and bass come in on the next beat; out of one they stop at the next bar line. */
  setRegionMusic(theme: number, fight: boolean): void {
    this.wantTheme = theme;
    this.wantFight = fight;
    if (this.ctx && this.music) this.music.setRegion(theme, fight);
  }

  // ---------- voice helpers ----------
  /** A per-sound channel: gain -> stereo pan -> sfx bus, plus a reverb send. */
  private bus(x: number, v: number, wet: number): GainNode {
    const c = this.c;
    const g = c.createGain();
    g.gain.value = v;
    const p = c.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, (x / FIELD) * 2 - 1)) * 0.7;
    g.connect(p).connect(this.sfx);
    if (wet > 0) {
      const s = c.createGain();
      s.gain.value = wet;
      g.connect(s).connect(this.revIn);
    }
    return g;
  }

  private shaper(out: AudioNode): WaveShaperNode {
    const s = this.c.createWaveShaper();
    s.curve = this.curve;
    s.connect(out);
    return s;
  }

  private osc(out: AudioNode, t: number, type: OscillatorType, f0: number, f1: number, peak: number, dur: number, att = 0.003, glide = dur, detune = 0): OscillatorNode {
    const c = this.c;
    const o = c.createOscillator();
    o.type = type;
    o.detune.value = detune;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + glide);
    const g = c.createGain();
    g.gain.value = 0; // silent before t too: a voice starting between samples otherwise leaks one sample at gain 1
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + att);
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(att + 0.01, dur));
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + dur + 0.05);
    return o;
  }

  private nz(out: AudioNode, t: number, dur: number, peak: number, type: BiquadFilterType, f0: number, f1: number, q = 0.7, att = 0.002, brown = false): void {
    const c = this.c;
    const src = c.createBufferSource();
    src.buffer = brown ? this.brown : this.white;
    src.loop = true;
    const f = c.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = c.createGain();
    g.gain.value = 0; // silent before t too: a voice starting between samples otherwise leaks one sample at gain 1
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + att);
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(att + 0.01, dur));
    src.connect(f).connect(g).connect(out);
    src.start(t, rnd() * Math.max(0, 3.9 - dur));
    src.stop(t + dur + 0.05);
  }

  /** The impact crack: noise band-passed into 700-1800 Hz (the band small speakers still play), full level from
   *  the first millisecond, falling in pitch. Band-passed, never high-passed: round 3's crackle was a high-pass layer. */
  private crack(out: AudioNode, t: number, dur: number, peak: number, tone: number): void {
    this.nz(out, t, dur, peak, 'bandpass', 1500 * tone, 750 * tone, 1.1, 0.0008);
    this.nz(out, t, dur * 0.6, peak * 0.55, 'bandpass', 1000 * tone, 750 * tone, 1.6, 0.0008);
  }

  private bell(out: AudioNode, t: number, base: number, ratios: number[], amps: number[], decays: number[]): void {
    ratios.forEach((r, i) => this.osc(out, t, 'sine', base * r, base * r, amps[i], decays[i], 0.001));
  }

  private chord(out: AudioNode, t: number, notes: number[], dur: number, peak: number, cutoff: number, cutoffEnd = cutoff, att = 0.01): void {
    const c = this.c;
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 1.2;
    f.frequency.setValueAtTime(cutoff, t);
    f.frequency.exponentialRampToValueAtTime(cutoffEnd, t + dur);
    f.connect(out);
    for (const hz of notes) {
      this.osc(f, t, 'sawtooth', hz, hz, peak, dur, att, dur, -8);
      this.osc(f, t, 'sawtooth', hz, hz, peak, dur, att, dur, 8);
    }
  }

  duck(amount: number, dur: number): void {
    if (!this.ctx) return;
    const t = this.c.currentTime;
    // a light duck (the player's gun) never cuts short a deeper one still holding (an explosion)
    if (t < this.duckEnd && amount > this.duckAmt) return;
    this.duckEnd = t + dur;
    this.duckAmt = amount;
    const base = this.musicVol * 0.55;
    this.mus.gain.cancelScheduledValues(t);
    this.mus.gain.setTargetAtTime(base * amount, t, 0.02);
    this.mus.gain.setTargetAtTime(base, t + dur, 0.35);
  }

  // ---------- sounds ----------
  play(name: string, x = FIELD / 2, v = 1, delay = 0): void {
    if (!this.c || (this.muted && this.ctx)) return;
    const t = this.c.currentTime + 0.004 + delay;
    switch (name) {
      case 'shoot': {
        // every shot a little different: pitch +/-4%, crack level +/-15%
        const p = 1 + (rnd() * 2 - 1) * 0.04;
        const k = 1 + (rnd() * 2 - 1) * 0.15;
        const o = this.bus(x, 0.36 * v, 0.16);
        this.nz(o, t, 0.03, 0.35 * k, 'highpass', 3200 * p, 3200 * p);
        this.osc(this.shaper(o), t, 'sine', 230 * p, 46 * p, 0.85, 0.22, 0.002, 0.12);
        this.osc(o, t, 'triangle', 460 * p, 95 * p, 0.26, 0.09);
        // the crack: band-passed noise sweeping down through the mids, long and loud enough to carry on small
        // speakers (band-passed, never high-passed: the round-3 crackle was a high-pass layer)
        this.nz(o, t, 0.2, 3.0 * k, 'bandpass', 1800 * p, 650 * p, 0.9, 0.0008);
        this.nz(o, t, 0.11, 1.8 * k, 'bandpass', 1300 * p, 900 * p, 1.4, 0.0008);
        this.nz(o, t + 0.01, 0.42, 0.16, 'lowpass', 1000, 120, 0.7, 0.01, true);
        this.osc(o, t + 0.075, 'square', 2100 * p, 2000 * p, 0.025, 0.025);
        this.duck(0.8, 0.12);
        break;
      }
      case 'eshoot': {
        const o = this.bus(x, 0.3 * v, 0.2);
        this.nz(o, t, 0.028, 0.45, 'highpass', 2600, 2600);
        this.osc(this.shaper(o), t, 'sine', 170, 38, 0.75, 0.24, 0.002, 0.13);
        this.nz(o, t, 0.2, 2.2, 'bandpass', 1500, 450, 0.9, 0.0008);
        this.nz(o, t, 0.11, 1.5, 'bandpass', 1100, 750, 1.3, 0.0008);
        this.nz(o, t + 0.01, 0.4, 0.14, 'lowpass', 700, 100, 0.7, 0.01, true);
        break;
      }
      case 'brick': {
        const o = this.bus(x, 0.75 * v, 0.25);
        for (let i = 0; i < 5; i++) {
          this.nz(o, t + i * 0.016 + rnd() * 0.01, 0.05 + rnd() * 0.05, 0.3 + rnd() * 0.25, 'bandpass', 500 + rnd() * 2200, 300 + rnd() * 500, 1.6);
        }
        this.osc(o, t, 'sine', 130, 45, 0.55, 0.16);
        this.nz(o, t + 0.02, 0.35, 0.09, 'lowpass', 3000, 400, 0.7, 0.01);
        break;
      }
      case 'steel': {
        const o = this.bus(x, 0.5 * v, 0.5);
        const b = 560 * (0.94 + rnd() * 0.12);
        this.bell(o, t, b, [1, 2.32, 4.25, 6.63, 9.38], [0.4, 0.26, 0.2, 0.12, 0.08], [0.7, 0.45, 0.3, 0.2, 0.14]);
        this.nz(o, t, 0.014, 0.5, 'highpass', 5000, 5000);
        break;
      }
      case 'thud': {
        const o = this.bus(x, 0.6 * v, 0.15);
        this.nz(o, t, 0.14, 0.4, 'lowpass', 700, 150);
        this.osc(o, t, 'sine', 100, 40, 0.4, 0.12);
        break;
      }
      case 'ricochet': {
        const o = this.bus(x, 0.6 * v, 0.45);
        const s = this.osc(o, t, 'sine', 3300, 1100, 0.22, 0.5, 0.004, 0.42);
        const lfo = this.c.createOscillator();
        lfo.frequency.value = 36;
        const lg = this.c.createGain();
        lg.gain.value = 140;
        lfo.connect(lg).connect(s.frequency);
        lfo.start(t);
        lfo.stop(t + 0.55);
        this.nz(o, t, 0.03, 0.4, 'highpass', 4500, 4500);
        break;
      }
      case 'armor': {
        const o = this.bus(x, 0.55 * v, 0.4);
        this.bell(o, t, 330, [1, 2.76, 5.4], [0.35, 0.2, 0.12], [0.45, 0.25, 0.15]);
        this.osc(o, t, 'sine', 170, 70, 0.5, 0.14);
        this.nz(o, t, 0.02, 0.4, 'highpass', 3500, 3500);
        break;
      }
      case 'explode': {
        const o = this.bus(x, 0.39 * v, 0.55);
        this.crack(o, t, 0.12, 3.2, 1);
        this.osc(this.shaper(o), t, 'sine', 100, 30, 0.52, 1.1, 0.004, 0.8);
        this.nz(o, t, 1.6, 0.8, 'lowpass', 2800, 110, 0.7, 0.02, true); // the rumble swells in after the crack
        // the debris body: mid-range noise that falls slowly, so the blast still reads on small speakers
        this.nz(o, t, 0.7, 2.0, 'bandpass', 1000, 300, 0.8, 0.001);
        this.nz(o, t + 0.02, 0.5, 1.3, 'bandpass', 600, 350, 1.2, 0.01);
        this.nz(o, t + 0.06, 0.9, 0.9, 'bandpass', 1500, 450, 0.6, 0.06);
        this.duck(0.55, 0.5);
        break;
      }
      case 'bigexplode': {
        const o = this.bus(x, 0.39 * v, 0.65);
        this.crack(o, t, 0.13, 3.0, 0.9);
        this.osc(this.shaper(o), t, 'sine', 80, 28, 0.5, 2.0, 0.004, 1.4);
        this.osc(this.shaper(o), t + 0.22, 'sine', 62, 30, 0.4, 1.3, 0.01, 1.0);
        this.nz(o, t, 2.8, 0.85, 'lowpass', 2400, 70, 0.7, 0.025, true);
        this.nz(o, t, 1.0, 2.0, 'bandpass', 900, 260, 0.7, 0.001);
        this.nz(o, t + 0.03, 0.7, 1.3, 'bandpass', 550, 330, 1.2, 0.01);
        this.nz(o, t + 0.1, 1.5, 1.0, 'bandpass', 1300, 400, 0.6, 0.1);
        this.duck(0.35, 1.2);
        break;
      }
      case 'powerup': {
        const o = this.bus(x, 0.85 * v, 0.6);
        [1318.5, 1661.2, 1975.5, 2637].forEach((f, i) => {
          this.osc(o, t + i * 0.07, 'triangle', f, f, 0.16, 0.35);
          this.osc(o, t + 0.26 + i * 0.07, 'triangle', f, f, 0.06, 0.3);
        });
        this.nz(o, t, 0.5, 0.04, 'highpass', 7000, 9000, 0.7, 0.1);
        break;
      }
      case 'pickup':
      case 'grenade': {
        const o = this.bus(x, 1.2 * v, 0.5);
        this.nz(o, t, 0.36, 0.22, 'bandpass', 300, 5200, 1.6, 0.18);
        const minor = name === 'grenade';
        this.chord(o, t + 0.05, minor ? [220, 261.6, 329.6] : [440, 554.4, 659.3], 0.6, 0.05, 900, 6000);
        this.osc(o, t + 0.12, 'sine', 2637, 2637, 0.08, 0.25);
        this.osc(o, t + 0.18, 'sine', 3520, 3520, 0.06, 0.3);
        if (minor) this.osc(this.shaper(o), t, 'sine', 70, 28, 0.8, 0.9, 0.005, 0.7);
        break;
      }
      case 'emp': {
        const o = this.bus(x, 0.9 * v, 0.6);
        const car = this.osc(o, t, 'sawtooth', 95, 60, 0.18, 0.75, 0.005);
        const mod = this.c.createOscillator();
        mod.frequency.value = 47;
        const mg = this.c.createGain();
        mg.gain.setValueAtTime(600, t);
        mg.gain.exponentialRampToValueAtTime(20, t + 0.7);
        mod.connect(mg).connect(car.frequency);
        mod.start(t);
        mod.stop(t + 0.8);
        this.osc(o, t, 'sine', 1900, 55, 0.28, 0.85, 0.005, 0.8);
        this.nz(o, t, 0.6, 0.22, 'bandpass', 6000, 1500, 1.2);
        this.osc(this.shaper(o), t, 'sine', 50, 40, 0.6, 0.7);
        this.duck(0.5, 0.6);
        break;
      }
      case 'shieldbreak': {
        const o = this.bus(x, v, 0.6);
        for (let i = 0; i < 22; i++) {
          const f = 3000 + rnd() * 6500;
          this.osc(o, t + rnd() * 0.18, 'sine', f, f * 0.98, 0.04 + rnd() * 0.06, 0.06 + rnd() * 0.3, 0.001);
        }
        this.nz(o, t, 0.4, 0.35, 'highpass', 4500, 2500);
        this.osc(o, t, 'sine', 900, 180, 0.15, 0.35);
        break;
      }
      case 'life': {
        const o = this.bus(x, 0.85 * v, 0.5);
        [523.3, 659.3, 784, 1046.5].forEach((f, i) => {
          this.osc(o, t + i * 0.07, 'triangle', f, f, 0.18, 0.7);
          this.osc(o, t + i * 0.07, 'square', f * 2, f * 2, 0.02, 0.3);
        });
        break;
      }
      case 'ui-move': {
        const o = this.bus(FIELD / 2, 0.45 * v, 0.12);
        this.osc(o, t, 'sine', 1250, 1250, 0.12, 0.05, 0.002);
        this.osc(o, t, 'sine', 2500, 2500, 0.03, 0.03, 0.002);
        break;
      }
      case 'ui-ok': {
        const o = this.bus(FIELD / 2, 0.5 * v, 0.3);
        this.osc(o, t, 'sine', 880, 880, 0.14, 0.14);
        this.osc(o, t + 0.06, 'sine', 1320, 1320, 0.14, 0.22);
        break;
      }
      case 'ui-back': {
        const o = this.bus(FIELD / 2, 0.45 * v, 0.2);
        this.osc(o, t, 'sine', 990, 620, 0.14, 0.16);
        break;
      }
      case 'pause': {
        const o = this.bus(FIELD / 2, 0.6 * v, 0.4);
        this.nz(o, t, 0.4, 0.12, 'lowpass', 3500, 200, 0.7, 0.01);
        this.osc(o, t, 'sine', 660, 440, 0.1, 0.25);
        break;
      }
      case 'start': {
        const o = this.bus(FIELD / 2, 0.8 * v, 0.6);
        this.nz(o, t, 1.1, 0.22, 'bandpass', 180, 6500, 2, 1.0);
        const hit = t + 1.05;
        this.osc(this.shaper(o), hit, 'sine', 75, 26, 0.9, 1.4, 0.003, 1.0);
        this.nz(o, hit, 1.6, 0.5, 'lowpass', 3500, 100, 0.7, 0.003, true);
        this.chord(o, hit, [220, 261.6, 329.6, 440], 1.6, 0.035, 2200, 500);
        break;
      }
      case 'clear': {
        const o = this.bus(FIELD / 2, 0.8 * v, 0.6);
        const prog = [[349.2, 440, 523.3], [392, 493.9, 587.3], [523.3, 659.3, 784, 1046.5]];
        prog.forEach((ch, i) => {
          const tt = t + i * 0.28;
          this.chord(o, tt, ch, i === 2 ? 1.6 : 0.3, 0.045, 3000, i === 2 ? 800 : 2000);
          ch.forEach((f) => this.osc(o, tt, 'triangle', f * 2, f * 2, 0.05, i === 2 ? 1.2 : 0.25));
          this.osc(o, tt, 'sine', 140, 45, 0.6, 0.25);
        });
        break;
      }
      case 'gameover': {
        const o = this.bus(FIELD / 2, 0.8 * v, 0.7);
        this.osc(o, t, 'sine', 55, 55, 0.3, 3.2, 0.3);
        this.osc(o, t, 'sine', 82.4, 82.4, 0.15, 3.0, 0.3);
        this.chord(o, t, [440, 523.3, 659.3], 1.0, 0.04, 1800, 600);
        this.chord(o, t + 0.7, [392, 466.2, 587.3], 1.0, 0.04, 1500, 500);
        this.chord(o, t + 1.4, [349.2, 415.3, 523.3], 2.4, 0.045, 1300, 300);
        break;
      }
      case 'tick': {
        const o = this.bus(FIELD / 2, 0.4 * v, 0.1);
        this.osc(o, t, 'sine', 1700, 1700, 0.1, 0.04);
        break;
      }
      case 'boss-charge': {
        // a boss main gun's warning. The boss code plays it every 12-15 frames while the barrel glows: each call
        // is one beep a whole tone higher than the last plus a slice of a whine that keeps rising, so the whole
        // warning climbs for as long as it lasts and stops when the gun fires
        const c = this.c;
        const now = c.currentTime + delay;
        if (now - this.chargeT > 0.45) this.chargeN = 0;
        this.chargeT = now;
        const n = Math.min(this.chargeN++, 7);
        const o = this.bus(x, 1.35 * v, 0.25);
        // the whine: two detuned saws, darkened, a 0.34 s slice that overlaps the next one
        const fw = (k: number) => 300 * Math.pow(2, k * 0.2);
        const env = c.createGain();
        const lv = 0.05 + n * 0.012;
        env.gain.value = 0;
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(lv, t + (n === 0 ? 0.12 : 0.07));
        env.gain.setValueAtTime(lv, t + 0.22);
        env.gain.linearRampToValueAtTime(0, t + 0.34);
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(850 + n * 200, t);
        lp.frequency.linearRampToValueAtTime(1050 + n * 200, t + 0.34);
        lp.Q.value = 1.2;
        lp.connect(env).connect(o);
        for (const det of [-7, 7]) {
          const s = c.createOscillator();
          s.type = 'sawtooth';
          s.detune.value = det;
          s.frequency.setValueAtTime(fw(n), t);
          s.frequency.linearRampToValueAtTime(fw(n + 1.4), t + 0.34);
          s.connect(lp);
          s.start(t);
          s.stop(t + 0.36);
        }
        // the beep: a short triangle (and its sine) through a soft low-pass, right in the band every speaker plays
        const bf = c.createBiquadFilter();
        bf.type = 'lowpass';
        bf.frequency.value = 2200;
        bf.Q.value = 0.6;
        bf.connect(o);
        const fb = 988 * Math.pow(2, (n * 2) / 12);
        this.osc(bf, t, 'triangle', fb, fb, 0.13, 0.065, 0.005);
        this.osc(o, t, 'sine', fb, fb, 0.06, 0.07, 0.005);
        break;
      }
      case 'boss-cannon': {
        // a boss's main gun: lower and longer than a tank's, the A1 crack in front and a 0.6 s rolling tail
        const o = this.bus(x, 0.34 * v, 0.35);
        this.crack(o, t, 0.12, 2.6, 0.8);
        this.nz(o, t, 0.035, 0.35, 'highpass', 2200, 2200);
        this.osc(this.shaper(o), t, 'sine', 120, 30, 0.8, 0.5, 0.002, 0.25);
        this.osc(o, t, 'triangle', 240, 60, 0.3, 0.16);
        this.nz(o, t, 0.6, 1.5, 'bandpass', 900, 240, 0.8, 0.002);
        this.nz(o, t + 0.01, 0.65, 0.45, 'lowpass', 900, 90, 0.7, 0.01, true);
        this.duck(0.7, 0.3);
        break;
      }
      case 'boss-part': {
        // a boss part shot off: the big explosion with a metal shear on top. A low, beating inharmonic clang (the
        // bell helper at low pitch, detuned pair), a tearing glide and a short grind of noise, then loose plates
        this.play('bigexplode', x, v, delay);
        const o = this.bus(x, 0.32 * v, 0.5);
        const ratios = [1, 1.47, 2.09, 2.56, 3.37];
        this.bell(o, t, 150, ratios, [0.3, 0.24, 0.18, 0.12, 0.08], [0.9, 0.6, 0.45, 0.3, 0.2]);
        this.bell(o, t, 150 * 1.019, ratios.slice(0, 3), [0.2, 0.15, 0.1], [0.8, 0.5, 0.35]);
        const c = this.c;
        const tear = c.createBiquadFilter();
        tear.type = 'bandpass';
        tear.frequency.setValueAtTime(1300, t);
        tear.frequency.exponentialRampToValueAtTime(650, t + 0.4);
        tear.Q.value = 2.5;
        tear.connect(o);
        this.osc(tear, t + 0.01, 'sawtooth', 640, 330, 0.3, 0.42, 0.01, 0.4);
        this.osc(tear, t + 0.01, 'sawtooth', 652, 341, 0.22, 0.38, 0.01, 0.36);
        this.nz(o, t, 0.1, 1.6, 'bandpass', 1600, 900, 1.6, 0.001);
        for (let i = 0; i < 4; i++) {
          const tt = t + 0.18 + i * 0.07 + rnd() * 0.05;
          const b = 700 + rnd() * 900;
          this.bell(o, tt, b, [1, 2.76], [0.08, 0.04], [0.09, 0.05]);
        }
        break;
      }
      case 'boss-horn': {
        // Phase 4 bosses: the armoured train's air horn (the flagship's too): a three-note chord that sags into
        // pitch, a long blast and a short one
        const c = this.c;
        const o = this.bus(x, 0.55 * v, 0.45);
        const f = c.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 950;
        f.Q.value = 0.8;
        f.connect(o);
        for (const [t0, len] of [[0, 0.8], [1.0, 0.38]]) {
          const env = c.createGain();
          env.gain.setValueAtTime(0.0001, t + t0);
          env.gain.exponentialRampToValueAtTime(0.16, t + t0 + 0.09);
          env.gain.setValueAtTime(0.16, t + t0 + len);
          env.gain.exponentialRampToValueAtTime(0.0001, t + t0 + len + 0.26);
          env.connect(f);
          for (const hz of [233, 277.2, 349.2]) {
            const s = c.createOscillator();
            s.type = 'triangle';
            s.frequency.setValueAtTime(hz * 1.025, t + t0);
            s.frequency.exponentialRampToValueAtTime(hz, t + t0 + 0.14);
            s.connect(env);
            s.start(t + t0);
            s.stop(t + t0 + len + 0.3);
          }
        }
        break;
      }
      // ---------- campaign sounds ----------
      case 'scrap': {
        // a few small plates clattering: short inharmonic pings at random pitches, no high-pass noise
        const o = this.bus(x, 0.65 * v, 0.22);
        const n = 5 + Math.floor(rnd() * 2);
        for (let i = 0; i < n; i++) {
          const tt = t + (i === 0 ? 0 : 0.015 + Math.pow(rnd(), 0.8) * 0.17);
          const b = 1500 + rnd() * 1700;
          const a = (0.12 + rnd() * 0.1) * (i === 0 ? 1.2 : 1);
          this.bell(o, tt, b, [1, 2.76, 5.4], [a, a * 0.5, a * 0.22], [0.05 + rnd() * 0.05, 0.035, 0.02]);
          this.nz(o, tt, 0.012, 0.16, 'bandpass', 3200 + rnd() * 1500, 3200, 1.8, 0.001);
        }
        this.osc(o, t, 'sine', 240, 130, 0.14, 0.05, 0.002);
        break;
      }
      case 'part': {
        // ratchet clicks, a solid clunk, then a small chime
        const o = this.bus(x, 0.42 * v, 0.35);
        for (let i = 0; i < 3; i++) {
          const tt = t + i * 0.045;
          this.nz(o, tt, 0.014, 0.3, 'bandpass', 1500 + i * 250, 1100, 3, 0.001);
          this.osc(o, tt, 'sine', 420 + i * 70, 260, 0.1, 0.02, 0.001);
        }
        const hit = t + 0.15;
        this.osc(this.shaper(o), hit, 'sine', 125, 48, 0.55, 0.2, 0.002, 0.1);
        this.nz(o, hit, 0.06, 0.3, 'bandpass', 700, 300, 1, 0.001);
        this.bell(o, hit + 0.02, 330, [1, 2.76], [0.12, 0.06], [0.14, 0.07]);
        this.bell(o, hit + 0.06, 1568, [1, 2, 3.01], [0.15, 0.06, 0.03], [0.32, 0.18, 0.1]);
        this.bell(o, hit + 0.13, 2093, [1, 2], [0.1, 0.04], [0.3, 0.15]);
        break;
      }
      case 'armour-hit': {
        // heavy clang: low thump, a ringing detuned bell pair and a dull body knock, nothing bright or noisy
        const o = this.bus(x, 0.3 * v, 0.4);
        this.crack(o, t, 0.08, 3.8, 0.85);
        this.osc(this.shaper(o), t, 'sine', 95, 36, 0.7, 0.32, 0.002, 0.14);
        this.nz(o, t, 0.2, 0.5, 'lowpass', 900, 120, 0.8, 0.002, true);
        const ratios = [1, 1.59, 2.14, 2.66, 3.9];
        this.bell(o, t, 235, ratios, [0.34, 0.26, 0.2, 0.12, 0.07], [0.55, 0.4, 0.32, 0.2, 0.12]);
        this.bell(o, t, 235 * 1.014, ratios.slice(0, 3), [0.2, 0.14, 0.1], [0.5, 0.35, 0.25]);
        this.nz(o, t, 0.05, 0.28, 'bandpass', 1800, 900, 1.2, 0.001);
        this.duck(0.7, 0.35);
        break;
      }
      case 'armour-low': {
        // dashboard alarm: two short low beeps
        const o = this.bus(FIELD / 2, 0.6 * v, 0.12);
        const f = this.c.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 1000;
        f.connect(o);
        for (let i = 0; i < 2; i++) {
          const tt = t + i * 0.19;
          const ob = this.c.createOscillator();
          ob.type = 'square';
          ob.frequency.value = 330;
          const g = this.c.createGain();
          g.gain.setValueAtTime(0, tt);
          g.gain.linearRampToValueAtTime(0.3, tt + 0.012);
          g.gain.setValueAtTime(0.3, tt + 0.085);
          g.gain.linearRampToValueAtTime(0, tt + 0.11);
          ob.connect(g).connect(f);
          ob.start(tt);
          ob.stop(tt + 0.12);
        }
        break;
      }
      case 'patch': {
        // wrench ratchet clicks (speeding up), a soft hiss, a final tink
        const o = this.bus(x, 1.4 * v, 0.1);
        let tt = t;
        let gap = 0.085;
        for (let i = 0; i < 7; i++) {
          const hi = i % 2 === 0;
          this.nz(o, tt, 0.018, 0.26 * (1 - i * 0.09), 'bandpass', hi ? 2200 : 1600, 1300, 2, 0.003);
          this.osc(o, tt, 'triangle', hi ? 780 : 620, 420, 0.1 * (1 - i * 0.09), 0.03, 0.002);
          tt += gap;
          gap *= 0.9;
        }
        this.nz(o, t + 0.06, 0.5, 0.1, 'bandpass', 4200, 2600, 0.7, 0.08);
        this.nz(o, t + 0.06, 0.5, 0.05, 'lowpass', 1800, 500, 0.7, 0.08);
        this.osc(o, tt + 0.02, 'sine', 1320, 1320, 0.1, 0.14, 0.004);
        break;
      }
      case 'radio': {
        // squelch on, two-tone blip through a narrow radio band, squelch off. Always centred.
        const o = this.bus(FIELD / 2, 0.9 * v, 0.05);
        this.nz(o, t, 0.06, 0.3, 'bandpass', 1900, 1500, 1.1, 0.004);
        this.nz(o, t + 0.04, 0.2, 0.025, 'bandpass', 2000, 2000, 0.9, 0.02);
        const f = this.c.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.value = 950;
        f.Q.value = 0.9;
        f.connect(o);
        this.osc(f, t + 0.075, 'square', 1000, 1000, 0.2, 0.065, 0.004);
        this.osc(f, t + 0.15, 'square', 1400, 1400, 0.2, 0.075, 0.004);
        this.nz(o, t + 0.25, 0.07, 0.2, 'bandpass', 1700, 900, 1.1, 0.002);
        break;
      }
      case 'column': {
        // far-off tracked column: heavy low-pass rumble, engine drone, clattering tracks, a few squeaks; swells and fades
        const o = this.bus(x, 0.45 * v, 0.8);
        const c = this.c;
        const dur = 2.5;
        const env = c.createGain();
        env.gain.setValueAtTime(0.0001, t);
        env.gain.exponentialRampToValueAtTime(1, t + 1.05);
        env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        const far = c.createBiquadFilter();
        far.type = 'lowpass';
        far.frequency.value = 520;
        far.Q.value = 0.5;
        env.connect(far).connect(o);
        const rsrc = c.createBufferSource();
        rsrc.buffer = this.brown;
        rsrc.loop = true;
        const rlp = c.createBiquadFilter();
        rlp.type = 'lowpass';
        rlp.frequency.value = 170;
        const rg = c.createGain();
        rg.gain.value = 0.4;
        rsrc.connect(rlp).connect(rg).connect(env);
        rsrc.start(t, rnd() * 3);
        rsrc.stop(t + dur + 0.1);
        const eng = c.createBiquadFilter();
        eng.type = 'lowpass';
        eng.frequency.value = 150;
        eng.Q.value = 2;
        const eg = c.createGain();
        eg.gain.value = 0.1;
        eng.connect(eg).connect(env);
        [36, 36.7].forEach((hz) => {
          const e1 = c.createOscillator();
          e1.type = 'sawtooth';
          e1.frequency.setValueAtTime(hz * 0.96, t);
          e1.frequency.linearRampToValueAtTime(hz * 1.06, t + 1.1);
          e1.frequency.linearRampToValueAtTime(hz * 0.97, t + dur);
          e1.connect(eng);
          e1.start(t);
          e1.stop(t + dur + 0.1);
        });
        const csrc = c.createBufferSource();
        csrc.buffer = this.white;
        csrc.loop = true;
        const cbp = c.createBiquadFilter();
        cbp.type = 'bandpass';
        cbp.frequency.value = 850;
        cbp.Q.value = 1.3;
        const am = c.createGain();
        am.gain.value = 0.5;
        const lfo = c.createOscillator();
        lfo.type = 'sine';
        lfo.frequency.value = 9.5;
        const la = c.createGain();
        la.gain.value = 0.5;
        lfo.connect(la).connect(am.gain);
        const cg = c.createGain();
        cg.gain.value = 0.16;
        csrc.connect(cbp).connect(am).connect(cg).connect(env);
        csrc.start(t, rnd() * 3);
        csrc.stop(t + dur + 0.1);
        lfo.start(t);
        lfo.stop(t + dur + 0.1);
        // squeaky track pins: slow wavering glides
        for (let i = 0; i < 4; i++) {
          const st = t + 0.5 + rnd() * 1.5;
          const f0 = 1300 + rnd() * 900;
          const sq = this.osc(env, st, 'triangle', f0, f0 * (0.9 + rnd() * 0.25), 0.014, 0.18 + rnd() * 0.18, 0.04);
          const vib = c.createOscillator();
          vib.frequency.value = 6 + rnd() * 5;
          const vg = c.createGain();
          vg.gain.value = 25;
          vib.connect(vg).connect(sq.frequency);
          vib.start(st);
          vib.stop(st + 0.45);
        }
        break;
      }
      case 'town-freed': {
        // restrained fanfare: G C E rising, then a held C major chord over a soft sub
        const o = this.bus(FIELD / 2, 1.0 * v, 0.5);
        [392, 523.3, 659.3].forEach((hz, i) => {
          const tt = t + i * 0.14;
          this.chord(o, tt, [hz], 0.3, 0.05, 3200, 1600);
          this.osc(o, tt, 'triangle', hz * 2, hz * 2, 0.07, 0.25);
        });
        const hold = t + 0.46;
        this.chord(o, hold, [523.3, 659.3, 784, 1046.5], 1.1, 0.04, 1800, 700, 0.025);
        [523.3, 784, 1046.5, 1318.5].forEach((hz, i) => this.osc(o, hold + i * 0.012, 'triangle', hz * 2, hz * 2, 0.045, 0.9, 0.03));
        this.osc(o, hold, 'sine', 65.4, 65.4, 0.2, 1.0, 0.02);
        break;
      }
      case 'capture-tick': {
        const o = this.bus(x, 0.3 * v, 0.1);
        this.osc(o, t, 'sine', 1150, 1150, 0.1, 0.045, 0.003);
        this.osc(o, t, 'sine', 2300, 2300, 0.015, 0.03, 0.003);
        break;
      }
      // ---------- Phase 3 enemy tricks sounds (tricks.ts) ----------
      case 'trick-drone': {
        // one 0.45 s slice of a small quadcopter's buzz (tricks.ts repeats it every 0.25 s, louder as it nears):
        // two detuned saws through a nasal band, chopped by the rotors
        const c = this.c;
        const o = this.bus(x, 0.32 * v, 0.12);
        const env = c.createGain();
        env.gain.setValueAtTime(0.0001, t);
        env.gain.exponentialRampToValueAtTime(1, t + 0.1);
        env.gain.setValueAtTime(1, t + 0.3);
        env.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
        const bp = c.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 950;
        bp.Q.value = 1.4;
        const chop = c.createGain();
        chop.gain.value = 0.6;
        const lfo = c.createOscillator();
        lfo.frequency.value = 31;
        const lg = c.createGain();
        lg.gain.value = 0.35;
        lfo.connect(lg).connect(chop.gain);
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 1700;
        lp.Q.value = 0.5;
        bp.connect(lp).connect(chop).connect(env).connect(o);
        const base = 186 + rnd() * 8;
        for (const [hz, a] of [[base, 0.5], [base * 1.012, 0.5], [base * 2.01, 0.25]]) {
          const s = c.createOscillator();
          s.type = 'sawtooth';
          s.frequency.value = hz;
          const g = c.createGain();
          g.gain.value = a;
          s.connect(g).connect(bp);
          s.start(t);
          s.stop(t + 0.5);
        }
        lfo.start(t);
        lfo.stop(t + 0.5);
        break;
      }
      case 'trick-whistle': {
        // incoming artillery shell: a falling whistle that swells, cut just before the blast
        const c = this.c;
        const o = this.bus(x, 0.5 * v, 0.35);
        const env = c.createGain();
        env.gain.setValueAtTime(0.0001, t);
        env.gain.exponentialRampToValueAtTime(0.5, t + 0.75);
        env.gain.exponentialRampToValueAtTime(0.0001, t + 0.92);
        env.connect(o);
        const s = c.createOscillator();
        s.type = 'sine';
        s.frequency.setValueAtTime(2100, t);
        s.frequency.exponentialRampToValueAtTime(620, t + 0.92);
        s.connect(env);
        s.start(t);
        s.stop(t + 0.95);
        this.nz(env, t, 0.9, 0.12, 'bandpass', 2400, 900, 2.5, 0.3);
        break;
      }
      case 'trick-rocket': {
        // shoulder-fired rocket: a pop, then a hissing whoosh that falls away
        const o = this.bus(x, 0.55 * v, 0.3);
        this.osc(this.shaper(o), t, 'sine', 140, 50, 0.6, 0.14, 0.002, 0.1);
        this.nz(o, t, 0.03, 0.4, 'highpass', 3000, 3000);
        this.nz(o, t + 0.02, 0.55, 0.32, 'bandpass', 1600, 420, 1.1, 0.03);
        break;
      }
      // ---------- end Phase 3 enemy tricks sounds ----------
      // ---------- Phase 4 bosses, regions 4-5 (bosses/heli.ts, final.ts) ----------
      case 'heli-chop': {
        // one blade slap of the gunship's rotor (heli.ts repeats it every 6-14 frames, louder as it nears)
        const o = this.bus(x, 0.42 * v, 0.18);
        this.osc(o, t, 'sine', 78, 46, 0.55, 0.11, 0.008, 0.09);
        this.nz(o, t, 0.1, 0.32, 'bandpass', 420, 260, 1.2, 0.012, true);
        this.nz(o, t, 0.05, 0.06, 'highpass', 2600, 2600, 0.7, 0.004);
        break;
      }
      case 'heli-pitch': {
        // the tell before a strafing run or a pop-up: the turbines wind up, a rising whine over a second
        const c = this.c;
        const o = this.bus(x, 0.3 * v, 0.25);
        const env = c.createGain();
        env.gain.setValueAtTime(0.0001, t);
        env.gain.exponentialRampToValueAtTime(0.7, t + 0.25);
        env.gain.setValueAtTime(0.7, t + 0.8);
        env.gain.exponentialRampToValueAtTime(0.0001, t + 1.05);
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(900, t);
        lp.frequency.exponentialRampToValueAtTime(2200, t + 0.9);
        lp.Q.value = 2;
        lp.connect(env).connect(o);
        for (const det of [-6, 6]) {
          const s = c.createOscillator();
          s.type = 'sawtooth';
          s.frequency.setValueAtTime(330, t);
          s.frequency.exponentialRampToValueAtTime(760, t + 0.95);
          s.detune.value = det;
          const g = c.createGain();
          g.gain.value = 0.3;
          s.connect(g).connect(lp);
          s.start(t);
          s.stop(t + 1.1);
        }
        break;
      }
      case 'firework': {
        // victory fireworks: a soft pop, then a crackle of sparks
        const o = this.bus(x, 0.45 * v, 0.5);
        this.osc(this.shaper(o), t, 'sine', 180, 60, 0.5, 0.18, 0.006, 0.12);
        this.nz(o, t, 0.08, 0.3, 'bandpass', 1800, 900, 0.9, 0.005);
        for (let i = 0; i < 12; i++) this.nz(o, t + 0.12 + rnd() * 0.5, 0.02 + rnd() * 0.02, 0.05 + rnd() * 0.06, 'bandpass', 2600 + rnd() * 2000, 2200, 1.2, 0.006);
        break;
      }
      // ---------- end Phase 4 bosses, regions 4-5 ----------
      case 'thunder': {
        // v = how close the strike is: 1 overhead, 0 far away
        const near = Math.max(0, Math.min(1, v));
        const o = this.bus(x, (0.8 + near * 0.2) * 0.9, 0.75);
        let ts = t;
        if (near > 0.35) {
          // the tear: a dense run of short crackles, thickest at the start, plus the first blast
          const n = Math.round(14 + near * 26);
          for (let i = 0; i < n; i++) {
            const tt = t + Math.pow(rnd(), 1.7) * (0.25 + 0.35 * near);
            this.nz(o, tt, 0.012 + rnd() * 0.03, (0.06 + rnd() * 0.2) * near, 'bandpass', 700 + rnd() * 2400, 260 + rnd() * 300, 0.9, 0.001);
          }
          this.nz(o, t, 0.45, 0.4 * near, 'lowpass', 2600, 160, 0.7, 0.003, true);
          this.osc(this.shaper(o), t, 'sine', 85, 30, 0.75 * near, 1.1, 0.004, 0.7);
          ts += 0.12;
        }
        const swells = 3 + Math.floor(rnd() * 3);
        const cutoff = 110 + near * 170;
        for (let s = 0; s < swells; s++) {
          const dur = 1.3 + rnd() * 1.9;
          this.rumble(o, ts, dur, (0.45 + rnd() * 0.35) * (1 - s * 0.14) * (0.8 + 0.2 * near), cutoff * (1 - s * 0.08));
          ts += 0.45 + rnd() * 0.9;
        }
        this.duck(0.55, 2.0);
        break;
      }
    }
  }

  /** One swell of thunder rumble: deep noise and a sub band, a smooth hump with a slow roll. */
  private rumble(out: AudioNode, t: number, dur: number, amp: number, cutoff: number): void {
    const c = this.c;
    const env = c.createGain();
    const att = 0.25 + rnd() * 0.4;
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(amp, t + att);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const roll = c.createGain();
    roll.gain.value = 0.75;
    const lfo = c.createOscillator();
    lfo.frequency.value = 2.5 + rnd() * 4;
    const depth = c.createGain();
    depth.gain.value = 0.25;
    lfo.connect(depth).connect(roll.gain);
    env.connect(roll).connect(out);
    for (const [f, q, g] of [[cutoff, 0.8, 1.0], [65, 1.6, 0.8]] as const) {
      const src = c.createBufferSource();
      src.buffer = this.brown;
      src.loop = true;
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = f;
      lp.Q.value = q;
      const lg = c.createGain();
      lg.gain.value = g;
      src.connect(lp).connect(lg).connect(env);
      src.start(t, rnd() * 3);
      src.stop(t + dur + 0.1);
    }
    lfo.start(t);
    lfo.stop(t + dur + 0.1);
  }

  /** Engine loop: 0 = off, 1 = idle, 2 = driving. */
  engine(state: number): void {
    if (!this.ctx) return;
    const c = this.c;
    if (!this.eng) {
      const bus = c.createGain();
      bus.gain.value = 1;
      bus.connect(this.sfx);
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 230;
      lp.Q.value = 3;
      const osc = c.createGain();
      osc.gain.value = 0;
      const o1 = c.createOscillator();
      o1.type = 'sawtooth';
      o1.frequency.value = 38;
      const o2 = c.createOscillator();
      o2.type = 'sawtooth';
      o2.frequency.value = 38.6;
      o1.connect(lp);
      o2.connect(lp);
      lp.connect(osc).connect(bus);
      const rsrc = c.createBufferSource();
      rsrc.buffer = this.brown;
      rsrc.loop = true;
      const rlp = c.createBiquadFilter();
      rlp.type = 'lowpass';
      rlp.frequency.value = 180;
      const rum = c.createGain();
      rum.gain.value = 0;
      rsrc.connect(rlp).connect(rum).connect(bus);
      const csrc = c.createBufferSource();
      csrc.buffer = this.white;
      csrc.loop = true;
      const cbp = c.createBiquadFilter();
      cbp.type = 'bandpass';
      cbp.frequency.value = 1100;
      cbp.Q.value = 1.4;
      const am = c.createGain();
      am.gain.value = 0.5;
      const lfo = c.createOscillator();
      lfo.type = 'square';
      lfo.frequency.value = 13;
      const lfoAmt = c.createGain();
      lfoAmt.gain.value = 0.5;
      lfo.connect(lfoAmt).connect(am.gain);
      const clat = c.createGain();
      clat.gain.value = 0;
      csrc.connect(cbp).connect(am).connect(clat).connect(bus);
      [o1, o2, rsrc, csrc, lfo].forEach((n) => n.start());
      this.eng = { bus, osc, rum, clat, o1, o2, lfo };
    }
    const e = this.eng;
    const t = c.currentTime;
    const mv = state === 2;
    e.osc.gain.setTargetAtTime(state ? (mv ? 0.09 : 0.05) : 0, t, 0.08);
    e.rum.gain.setTargetAtTime(state ? (mv ? 0.1 : 0.05) : 0, t, 0.1);
    e.clat.gain.setTargetAtTime(mv ? 0.05 : 0, t, 0.06);
    e.o1.frequency.setTargetAtTime(mv ? 52 : 38, t, 0.25);
    e.o2.frequency.setTargetAtTime(mv ? 52.8 : 38.6, t, 0.25);
    e.lfo.frequency.setTargetAtTime(mv ? 14 : 8, t, 0.2);
  }

  /** Weather bed: 'rain' | 'snow' | 'dust' | 'none'. */
  ambience(kind: string): void {
    this.wantAmb = kind;
    if (!this.ctx || kind === this.ambOn) return;
    this.ambOn = kind;
    const c = this.c;
    if (!this.amb) {
      this.amb = this.buildAmbience(c.currentTime);
      this.rainTimer = window.setInterval(() => this.pumpRain(), 30);
    }
    const t = c.currentTime;
    this.amb.rain.gain.setTargetAtTime(kind === 'rain' ? 0.018 : 0, t, 0.8);
    this.amb.wind.gain.setTargetAtTime(kind === 'snow' ? 0.16 : kind === 'dust' ? 0.08 : 0, t, 0.8);
  }

  private buildAmbience(t: number): { rain: GainNode; wind: GainNode; drops: GainNode[] } {
    const c = this.c;
    // rain wash: pink noise, dull and slowly swelling (gusts), well under the drops
    const rsrc = c.createBufferSource();
    rsrc.buffer = this.pink;
    rsrc.loop = true;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1100;
    lp.Q.value = 0.5;
    const gust = c.createGain();
    gust.gain.value = 0.8;
    const glfo = c.createOscillator();
    glfo.frequency.value = 0.07;
    const gd = c.createGain();
    gd.gain.value = 0.3;
    glfo.connect(gd).connect(gust.gain);
    const rain = c.createGain();
    rain.gain.value = 0;
    rsrc.connect(lp).connect(gust).connect(rain).connect(this.sfx);
    // drops land on five buses spread across the stereo field
    const drops = [-0.8, -0.4, 0, 0.4, 0.8].map((pan) => {
      const g = c.createGain();
      g.gain.value = 1.6;
      const p = c.createStereoPanner();
      p.pan.value = pan;
      g.connect(p).connect(this.sfx);
      const send = c.createGain();
      send.gain.value = 0.15;
      g.connect(send).connect(this.revIn);
      return g;
    });
    const wsrc = c.createBufferSource();
    wsrc.buffer = this.brown;
    wsrc.loop = true;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 380;
    bp.Q.value = 0.7;
    const lfo = c.createOscillator();
    lfo.frequency.value = 0.09;
    const lg = c.createGain();
    lg.gain.value = 160;
    lfo.connect(lg).connect(bp.frequency);
    const wind = c.createGain();
    wind.gain.value = 0;
    wsrc.connect(bp).connect(wind).connect(this.sfx);
    [rsrc, glfo, wsrc, lfo].forEach((n) => n.start(t));
    return { rain, wind, drops };
  }

  /** Schedule drops a little ahead of time, fading in and out with the weather. */
  private pumpRain(): void {
    if (!this.ctx || !this.amb) return;
    const want = this.wantAmb === 'rain' && !this.muted ? 1 : 0;
    this.rainLevel += (want - this.rainLevel) * 0.03;
    const now = this.c.currentTime;
    if (this.rainNext < now) this.rainNext = now;
    if (this.rainLevel < 0.01) return;
    this.rainNext = this.rainDrops(this.amb.drops, this.rainNext, now + 0.12, this.rainLevel);
  }

  /** Drops between t0 and t1: mostly taps, some heavier patters, the odd plip on water. Returns the next drop time. */
  private rainDrops(buses: GainNode[], t0: number, t1: number, level: number): number {
    let t = t0;
    const rate = 60 * level;
    while (t < t1) {
      const o = buses[Math.floor(rnd() * buses.length)];
      const r = rnd();
      const v = level * (0.4 + rnd() * 0.6);
      if (r < 0.74) {
        this.nz(o, t, 0.006 + rnd() * 0.014, 0.14 * v, 'bandpass', 1500 + rnd() * rnd() * 5500, 1200 + rnd() * 1500, 1.5 + rnd() * 3.5, 0.001);
      } else if (r < 0.9) {
        this.nz(o, t, 0.022 + rnd() * 0.022, 0.2 * v, 'bandpass', 550 + rnd() * 750, 450, 1.2, 0.001);
      } else {
        const f = 900 + rnd() * 1300;
        this.osc(o, t, 'sine', f, f * (1.6 + rnd() * 0.6), 0.07 * v, 0.02 + rnd() * 0.03, 0.001, 0.025);
      }
      t += -Math.log(1 - rnd() * 0.999) / rate;
    }
    return t;
  }

  // ---------- music instruments (used by Music) ----------
  kick(out: AudioNode, t: number): void {
    this.osc(out, t, 'sine', 160, 42, 0.85, 0.34, 0.002, 0.09);
    this.nz(out, t, 0.012, 0.18, 'highpass', 3000, 3000);
  }
  snare(out: AudioNode, rev: AudioNode, t: number): void {
    const g = this.c.createGain();
    g.connect(out);
    const s = this.c.createGain();
    s.gain.value = 0.35;
    g.connect(s).connect(rev);
    this.nz(g, t, 0.2, 0.32, 'bandpass', 1900, 1500, 0.9);
    this.osc(g, t, 'triangle', 210, 160, 0.22, 0.1);
  }
  hat(out: AudioNode, t: number, open: boolean, v: number): void {
    this.nz(out, t, open ? 0.16 : 0.035, (open ? 0.07 : 0.06) * v, 'highpass', 8500, 8500, 0.7, 0.001);
  }
  bass(out: AudioNode, t: number, m: number, len: number): void {
    const c = this.c;
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 7;
    f.frequency.setValueAtTime(1500, t);
    f.frequency.exponentialRampToValueAtTime(260, t + len);
    f.connect(out);
    this.osc(f, t, 'sawtooth', mtof(m), mtof(m), 0.2, len, 0.004);
    this.osc(f, t, 'square', mtof(m - 12), mtof(m - 12), 0.08, len, 0.004);
  }
  pad(out: AudioNode, rev: AudioNode, t: number, notes: number[], len: number, v: number): void {
    const g = this.c.createGain();
    g.connect(out);
    const s = this.c.createGain();
    s.gain.value = 0.6;
    g.connect(s).connect(rev);
    this.chord(g, t, notes.map(mtof), len + 0.6, 0.03 * v, 1300, 700, len * 0.4);
  }
  arp(out: AudioNode, t: number, m: number, v: number): void {
    const c = this.c;
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 2600;
    f.connect(out);
    this.osc(f, t, 'square', mtof(m), mtof(m), 0.045 * v, 0.2, 0.002);
  }
  // boss-fight folk metal: a tighter rock kit, a power-chord guitar and a tremolo pulse lead
  rkick(out: AudioNode, t: number, v: number): void {
    this.osc(out, t, 'sine', 150, 48, 0.62 * v, 0.2, 0.004, 0.05);
    this.nz(out, t, 0.012, 0.16 * v, 'bandpass', 3000, 2000, 0.7, 0.003);
  }
  rhat(out: AudioNode, t: number, open: boolean, v: number): void {
    this.nz(out, t, open ? 0.16 : 0.04, (open ? 0.07 : 0.06) * v, 'highpass', 8000, 8000, 0.7, 0.003);
  }
  rsnare(out: AudioNode, rev: AudioNode, t: number, v: number): void {
    const g = this.c.createGain();
    g.gain.value = v;
    g.connect(out);
    const s = this.c.createGain();
    s.gain.value = 0.45;
    g.connect(s).connect(rev);
    this.nz(g, t, 0.16, 0.34, 'bandpass', 2400, 1700, 0.8);
    this.osc(g, t, 'triangle', 200, 170, 0.26, 0.08);
  }
  crash(out: AudioNode, rev: AudioNode, t: number, v: number): void {
    const g = this.c.createGain();
    g.gain.value = v;
    g.connect(out);
    const s = this.c.createGain();
    s.gain.value = 0.4;
    g.connect(s).connect(rev);
    this.nz(g, t, 1.3, 0.07, 'highpass', 6000, 4200, 0.6, 0.002);
  }
  /** Power chord (root, fifth, octave) into the guitar amp; muted = palm-muted chug (short and dark). */
  gtr(out: AudioNode, t: number, root: number, len: number, muted: boolean, v: number): void {
    const f = this.c.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 1.2;
    f.frequency.setValueAtTime(muted ? 1100 : 2600, t);
    f.frequency.exponentialRampToValueAtTime(muted ? 320 : 1100, t + len);
    f.connect(out);
    const pk = (muted ? 0.3 : 0.22) * v;
    this.osc(f, t, 'sawtooth', mtof(root), mtof(root), pk, len, 0.004, len, -6);
    this.osc(f, t, 'sawtooth', mtof(root + 7), mtof(root + 7), pk * 0.8, len, 0.004, len, 5);
    if (!muted) this.osc(f, t, 'sawtooth', mtof(root + 12), mtof(root + 12), pk * 0.5, len, 0.004, len, 3);
  }
  /** One held lead note, re-plucked every `trem` s (bandura / tsymbaly tremolo) on one oscillator. */
  lead(out: AudioNode, t: number, m: number, len: number, v: number, trem: number, wave: PeriodicWave | OscillatorType): void {
    const c = this.c;
    const o = c.createOscillator();
    if (typeof wave === 'string') o.type = wave as OscillatorType;
    else o.setPeriodicWave(wave);
    o.frequency.value = mtof(m);
    const g = c.createGain();
    const pk = 0.06 * v;
    g.gain.value = 0; // silent before t too: a voice starting between samples otherwise leaks one sample at gain 1
    g.gain.setValueAtTime(0, t);
    for (let a = t; a < t + len - 0.001; a += trem) {
      g.gain.linearRampToValueAtTime(pk, a + 0.004);
      g.gain.exponentialRampToValueAtTime(pk * 0.4, Math.min(a + trem, t + len));
    }
    g.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.07);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + len + 0.1);
  }

  /** A floor tom: a short pitched thump with a little skin noise (region themes). */
  tom(out: AudioNode, t: number, m: number, v: number): void {
    this.osc(out, t, 'sine', mtof(m) * 1.6, mtof(m), 0.5 * v, 0.28, 0.003, 0.12);
    this.nz(out, t, 0.06, 0.1 * v, 'bandpass', 900, 500, 1, 0.002);
  }

  private rainOffline(secs: number): void {
    const a = this.buildAmbience(0);
    a.rain.gain.value = 0.018;
    this.rainDrops(a.drops, 0.05, secs, 1);
  }

  /** 16-bit stereo WAV as base64. */
  static wav(buf: AudioBuffer): string {
    const n = buf.length;
    const out = new DataView(new ArrayBuffer(44 + n * 4));
    const str = (o: number, s: string) => [...s].forEach((ch, i) => out.setUint8(o + i, ch.charCodeAt(0)));
    str(0, 'RIFF');
    out.setUint32(4, 36 + n * 4, true);
    str(8, 'WAVEfmt ');
    out.setUint32(16, 16, true);
    out.setUint16(20, 1, true);
    out.setUint16(22, 2, true);
    out.setUint32(24, buf.sampleRate, true);
    out.setUint32(28, buf.sampleRate * 4, true);
    out.setUint16(32, 4, true);
    out.setUint16(34, 16, true);
    str(36, 'data');
    out.setUint32(40, n * 4, true);
    const L = buf.getChannelData(0);
    const R = buf.getChannelData(1);
    for (let i = 0; i < n; i++) {
      out.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true);
      out.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true);
    }
    let bin = '';
    const bytes = new Uint8Array(out.buffer);
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  /** Offline render of one sound or a few bars of music, for level checks in tests. */
  static async measure(what: string, wav = false): Promise<{ name: string; peak: number; rms: number; secs: number; click: number; click0?: number; wav?: string }> {
    // region themes: music-<theme> (calm layer, the first 16 bars), music-<theme>-fight (drums and bass in),
    // music-<theme>-switch (8 calm bars, a fight starts mid-bar, ends after 6 bars, 4 more bars)
    const rm = /^music-(\w+?)(-fight|-switch)?$/.exec(what);
    const theme = rm ? REGION_THEMES.indexOf(rm[1]) : -1;
    const rbars = rm?.[2] === '-switch' ? 18 : 16;
    const secs = theme >= 0 ? (rbars * 240) / THEMES[theme].bpm + 2.5
      : what.startsWith('music-boss') ? 32 : what.startsWith('music') ? 10 : what === 'rain' || what.startsWith('thunder') ? 7 : 5;
    const oc = new OfflineAudioContext(2, Math.floor(44100 * secs), 44100);
    const s = new Sound(false);
    s.build(oc);
    if (theme >= 0) s.music!.renderRegion(theme, rbars, rm![2] === '-fight' ? [0, 99] : rm![2] === '-switch' ? [8.5, 14] : [99, 99]);
    else if (what.startsWith('music-boss')) s.music!.renderOffline('boss', 20, what === 'music-boss2' ? 16 : 0); // A, B, start of A2 (boss2: A2, B2, back to A)
    else if (what.startsWith('music')) s.music!.renderOffline(what === 'music-menu' ? 'menu' : 'play', 4);
    else if (what === 'rain') s.rainOffline(secs);
    else if (what === 'boss-charge') for (let i = 0; i < 4; i++) s.play(what, FIELD / 2, 0.9, 0.8 + i * 0.25); // one 1 s warning
    else if (what === 'boss-part') s.play(what, FIELD / 2, 0.8, 0.8); // the bosses' volume
    else if (what === 'shoot-burst') for (let i = 0; i < 4; i++) s.play('shoot', FIELD / 2, 1, 0.8 + i * 0.6); // the player's fire rate
    else if (what === 'boss-gun') {
      // GRINDER's main gun as the game plays it: the cannon plus a quieter explosion
      s.play('boss-cannon', FIELD / 2, 1, 0.8);
      s.play('explode', FIELD / 2, 0.55, 0.8);
    }
    else s.play(what === 'thunder-far' ? 'thunder' : what, FIELD / 2, what === 'thunder-far' ? 0.2 : 1, 0.8);
    const buf = await oc.startRendering();
    if (wav) return { name: what, peak: 0, rms: 0, secs, click: 0, wav: Sound.wav(buf) };
    let peak = 0;
    let sum = 0;
    let last = 0;
    const clickFrom = (start: number): number => {
      let k = 0;
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        for (let w = start + 2; w + 512 < d.length; w += 512) {
          let mx = 0;
          let ss = 0;
          let sig = 0;
          for (let i = w; i < w + 512; i++) {
            const hp = d[i] - 2 * d[i - 1] + d[i - 2];
            mx = Math.max(mx, Math.abs(hp));
            ss += hp * hp;
            sig += d[i] * d[i];
          }
          if (sig / 512 > 1e-8) k = Math.max(k, mx / (Math.sqrt(ss / 512) + 1e-6));
        }
      }
      return k;
    };
    // click: scored from 0.35 s into the sound (the tail); click0: from its very first sample
    const click0 = clickFrom(what.startsWith('music') ? 0 : Math.floor(0.8 * 44100));
    const click = clickFrom(what.startsWith('music') ? 0 : Math.floor(1.15 * 44100));
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i++) {
        const a = Math.abs(d[i]);
        if (a > peak) peak = a;
        sum += d[i] * d[i];
        if (a > 0.003) last = Math.max(last, i - (what.startsWith('music') ? 0 : 0.8 * 44100));
      }
    }
    return { name: what, peak: +peak.toFixed(3), rms: +Math.sqrt(sum / (buf.length * 2)).toFixed(4), secs: +(last / 44100).toFixed(2), click: +click.toFixed(1), click0: +click0.toFixed(1) };
  }
}

// ---------- procedural music ----------
const AM = [57, 60, 64];
const F = [53, 57, 60];
const C = [55, 60, 64];
const G = [55, 59, 62];
const E = [56, 59, 64];
const PHRASES = [
  { chords: [AM, F, C, G], roots: [33, 29, 36, 31] },
  { chords: [AM, AM, F, E], roots: [33, 33, 29, 28] },
];

// ---------- boss fight: Zorianian folk metal, 150 bpm, D, 32-bar loop ----------
// A (bars 0-7) and A2 (16-23): an original tremolo lead in Ukrainian Dorian (D E F G# A B C) over a
// galloping palm-muted riff, D D E D D D C A; rock beat, then the folk-metal "polka" beat (kick on the beat,
// snare off it). B (8-15): D harmonic minor, Dm Bb Gm A, the lead plays the ostinato of Mykola Leontovych's
// "Shchedryk" (1916, public domain): F E F D. B2 (24-31): same chords, an original soaring line on top while
// the ostinato moves to a quiet tsymbaly arp. Double-kick only in the last half-bar of a phrase.
const BOSS_BPM = 150;
const BOSS_ROOTS = [
  [38, 38, 40, 38, 38, 38, 36, 45], // A: D D E D D D C A
  [38, 34, 43, 45, 38, 34, 43, 45], // B: Dm Bb Gm A
];
/** Lead lines in eighths (8 per bar): MIDI note, 0 = hold, -1 = rest. */
const BOSS_A = [
  [74, 74, 76, 77, 80, 0, 81, 0],
  [80, 77, 76, 77, 74, 0, 0, 0],
  [76, 0, 80, 0, 83, 81, 80, 76],
  [77, 76, 74, 76, 77, 0, 74, 0],
  [81, 0, 80, 81, 83, 0, 81, 80],
  [81, 0, 77, 0, 80, 77, 76, 74],
  [76, 0, 72, 0, 76, 77, 76, 72],
  [76, 0, 81, 0, 73, 0, 0, -1],
];
const BOSS_B2 = [
  [81, 0, 86, 0, 85, 86, 81, 0],
  [82, 0, 81, 79, 77, 0, 74, 0],
  [79, 0, 82, 0, 86, 0, 82, 79],
  [81, 0, 0, 0, 85, 0, 76, 0],
  [77, 76, 77, 81, 86, 0, 85, 86],
  [89, 0, 86, 0, 82, 0, 81, 79],
  [79, 81, 82, 79, 86, 0, 82, 0],
  [81, 0, 85, 0, 88, 0, 0, -1],
];
/** Shchedryk's ostinato on the 16th grid: [step, length, degree]; degree 3/2/0 = F E D (E D C# over the A chord). */
const SHCHEDRYK: [number, number, number][] = [[0, 4, 3], [4, 2, 2], [6, 2, 3], [8, 4, 0], [12, 1, 3], [13, 1, 2], [14, 1, 3], [15, 1, 0]];
const OST_D = [74, 0, 76, 77];
const OST_A = [73, 0, 74, 76];
const GALLOP = [0, 2, 3, 4, 6, 7, 8, 10, 11, 12, 14, 15];

// ---------- region themes: the boss track's voices at lower energy, one tune per region ----------
// Each is 16 bars (an A and a B phrase) played twice: the second time the lead is doubled an octave down and the
// tsymbaly arp moves up. Calm layer: pad, lead, arp. Fight layer (an enemy within about a screen): drums and bass
// (and a guitar in RAIL JUNCTION and WINTER FRONT). The scales are the boss track's family: Ukrainian Dorian,
// Dorian, natural and harmonic minor.
type Drums = 'polka' | 'train' | 'flow' | 'stalk' | 'march';
interface Theme {
  bpm: number;
  /** one chord per bar: 'Em', 'A', 'F#' ... (major, or minor with m) */
  chords: string[];
  /** one lead line per bar, in eighths: MIDI note, 0 = hold, -1 = rest */
  lead: number[][];
  drums: Drums;
  wave: 'pulse' | 'triangle';
  /** lead tremolo: re-pluck every this many 16ths (0 = one held note) */
  trem: number;
  /** tsymbaly arp: 1 = 16ths, 2 = 8ths, 0 = none (a sparse high bell instead) */
  arp: number;
  arpPat: number[];
  padV: number;
  leadV: number;
  /** muted guitar chugs (rail) or a held power chord (winter) in the fight layer */
  gtr?: 'chug' | 'hold';
}
const THEMES: Theme[] = [
  {
    // FARMLAND, E Dorian, 104 bpm: home ground in the morning, a lilting tune over an oom-pah polka
    bpm: 104,
    chords: ['Em', 'A', 'D', 'Em', 'G', 'A', 'D', 'Em', 'G', 'D', 'A', 'Bm', 'G', 'A', 'Bm', 'Em'],
    lead: [
      [64, 0, 67, 69, 71, 0, 71, 0], [73, 71, 69, 71, 67, 0, 0, -1], [69, 0, 71, 67, 66, 0, 64, 0], [66, 67, 69, 66, 64, 0, 0, -1],
      [71, 0, 74, 0, 76, 0, 74, 71], [73, 0, 71, 69, 71, 0, 67, 0], [69, 71, 69, 67, 66, 0, 62, 0], [64, 66, 67, 66, 64, 0, 0, -1],
      [76, 0, 0, 74, 76, 78, 79, 0], [78, 76, 74, 76, 78, 0, 0, 0], [76, 0, 74, 73, 71, 0, 69, 0], [71, 73, 74, 73, 71, 0, 0, -1],
      [67, 0, 71, 0, 74, 0, 76, 0], [78, 0, 76, 74, 73, 0, 69, 0], [71, 0, 74, 73, 71, 69, 67, 66], [64, 0, 0, 66, 64, 0, 0, -1],
    ],
    drums: 'polka', wave: 'pulse', trem: 0, arp: 2, arpPat: [0, 1, 2, 1, 0, 2, 1, 2], padV: 0.75, leadV: 1.25,
  },
  {
    // RAIL JUNCTION, G harmonic minor, 120 bpm: dusk in the yards, repeated-note motifs over a clattering
    // wheels-on-rails beat and palm-muted chugs
    bpm: 120,
    chords: ['Gm', 'Cm', 'Cm', 'D', 'Gm', 'Eb', 'D', 'Gm', 'Gm', 'Cm', 'Eb', 'D', 'Gm', 'D', 'Cm', 'D'],
    lead: [
      [67, 67, 0, 70, 74, 0, 74, 0], [75, 74, 72, 70, 69, 0, 0, 0], [72, 72, 0, 75, 79, 0, 78, 0], [78, 0, 74, 0, 69, 0, 72, 70],
      [67, 67, 0, 70, 74, 0, 75, 74], [75, 0, 79, 0, 75, 74, 72, 0], [74, 0, 72, 70, 69, 0, 66, 0], [67, 0, 69, 70, 67, 0, 0, -1],
      [74, 0, 75, 74, 72, 0, 70, 0], [72, 0, 74, 72, 70, 0, 69, 0], [70, 0, 72, 70, 69, 0, 67, 0], [69, 70, 72, 70, 69, 0, 66, 0],
      [79, 0, 78, 0, 79, 0, 81, 0], [82, 0, 81, 79, 78, 0, 74, 0], [75, 0, 74, 72, 70, 0, 69, 0], [66, 0, 69, 0, 74, 0, 72, -1],
    ],
    drums: 'train', wave: 'pulse', trem: 1, arp: 2, arpPat: [0, 2, 0, 2, 0, 2, 1, 2], padV: 0.6, leadV: 1.1, gtr: 'chug',
  },
  {
    // RIVER DELTA, B minor, 92 bpm: rain on slow water, long bandura-tremolo notes over a flowing arp
    bpm: 92,
    chords: ['Bm', 'G', 'D', 'A', 'Bm', 'Em', 'F#', 'F#', 'G', 'D', 'Em', 'Bm', 'G', 'Em', 'F#', 'Bm'],
    lead: [
      [78, 0, 0, 0, 76, 74, 0, 0], [74, 0, 0, 0, 71, 0, 73, 74], [78, 0, 0, 0, 81, 0, 78, 0], [76, 0, 0, 0, 73, 0, 74, 76],
      [78, 0, 0, 0, 76, 74, 73, 71], [76, 0, 0, 0, 79, 0, 78, 76], [73, 0, 70, 0, 73, 0, 76, 0], [78, 0, 0, 0, 0, 0, 0, -1],
      [83, 0, 0, 0, 81, 79, 0, 0], [78, 0, 0, 0, 74, 0, 0, 0], [76, 0, 78, 0, 79, 0, 81, 0], [78, 0, 0, 0, 0, 0, -1, 0],
      [74, 0, 0, 0, 76, 0, 78, 0], [79, 0, 78, 0, 76, 0, 74, 0], [73, 0, 0, 0, 70, 0, 73, 0], [71, 0, 0, 0, 0, 0, 0, -1],
    ],
    drums: 'flow', wave: 'pulse', trem: 0.5, arp: 1, arpPat: [0, 1, 2, 3, 2, 1, 2, 3], padV: 0.9, leadV: 1.15,
  },
  {
    // RUINED TOWN, C Ukrainian Dorian, 88 bpm: night in the rubble, a low, wary line, sparse bells, toms
    bpm: 88,
    chords: ['Cm', 'Cm', 'D', 'D', 'Cm', 'Gm', 'D', 'Cm', 'Cm', 'D', 'Gm', 'Cm', 'D', 'Gm', 'D', 'Cm'],
    lead: [
      [67, 0, 0, 0, 0, 0, 66, 67], [69, 0, 67, 0, 66, 0, 63, 0], [62, 0, 0, 0, 66, 0, 69, 0], [67, 0, 0, 66, 0, 0, -1, 0],
      [72, 0, 0, 0, 70, 0, 69, 0], [70, 0, 67, 0, 0, 0, 62, 0], [63, 0, 66, 0, 69, 0, 66, 0], [67, 0, 63, 0, 60, 0, 0, -1],
      [72, 0, 75, 0, 74, 0, 72, 0], [70, 0, 72, 0, 69, 0, 66, 0], [67, 0, 69, 70, 72, 0, 74, 0], [75, 0, 0, 0, 74, 0, 0, -1],
      [66, 0, 67, 0, 69, 0, 72, 0], [70, 0, 69, 0, 67, 0, 66, 0], [63, 0, 0, 0, 62, 0, 66, 0], [67, 0, 0, 0, 60, 0, 0, -1],
    ],
    drums: 'stalk', wave: 'pulse', trem: 0, arp: 0, arpPat: [], padV: 0.85, leadV: 1.35,
  },
  {
    // WINTER FRONT, D harmonic minor (the boss track's key), 100 bpm: the last push, a heroic march with a
    // snare cadence and a held guitar chord in the fight layer
    bpm: 100,
    chords: ['Dm', 'Dm', 'Bb', 'A', 'Dm', 'Gm', 'A', 'Dm', 'Gm', 'Dm', 'Bb', 'A', 'Gm', 'Dm', 'A', 'A'],
    lead: [
      [74, 0, 0, 69, 74, 0, 76, 0], [77, 0, 76, 0, 74, 0, 0, 0], [77, 0, 0, 76, 77, 0, 79, 0], [81, 0, 0, 0, 76, 0, 0, -1],
      [74, 0, 0, 69, 74, 0, 76, 0], [77, 0, 79, 0, 81, 0, 82, 0], [81, 0, 79, 77, 76, 0, 73, 0], [74, 0, 0, 0, 0, 0, 0, -1],
      [82, 0, 81, 0, 79, 0, 0, 0], [81, 0, 79, 0, 77, 0, 0, 0], [79, 0, 77, 0, 76, 0, 74, 0], [73, 0, 76, 0, 81, 0, 0, 0],
      [82, 0, 0, 81, 79, 0, 77, 0], [81, 0, 0, 79, 77, 0, 76, 0], [77, 0, 76, 0, 74, 0, 73, 0], [76, 0, 0, 0, 69, 0, 73, 0],
    ],
    drums: 'march', wave: 'pulse', trem: 0.5, arp: 2, arpPat: [0, 2, 1, 2, 0, 2, 1, 2], padV: 0.95, leadV: 1.15, gtr: 'hold',
  },
];
const PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** 'F#m' -> pad notes (a triad from G3 up) and the bass root (C2-B2) */
function chordOf(name: string): { pad: number[]; root: number } {
  let r = PC[name[0]];
  let i = 1;
  if (name[i] === '#') { r++; i++; } else if (name[i] === 'b') { r--; i++; }
  r = (r + 12) % 12;
  const minor = name[i] === 'm';
  const p = 55 + ((r - 7 + 12) % 12);
  return { pad: [p, p + (minor ? 3 : 4), p + 7], root: 36 + r };
}

class Music {
  mode: MusicMode = 'off';
  private bpm = 112;
  private step = 0;
  private next = 0;
  private timer: number | null = null;
  private delay: DelayNode;
  private bus: GainNode;
  /** play <-> boss waits for the next bar line */
  private pending: MusicMode | null = null;
  /** where the boss loop was left (a pause resumes it there) */
  private bossStep = 0;
  /** region music: the theme, whether a fight is wanted, whether the drums and bass are playing, where the
   *  theme was left (a pause resumes it there) and a pending one-hit ending when the fight layer stops */
  private theme = 0;
  private wantFight = false;
  private layer = false;
  private regionStep = 0;
  private button = false;
  private amp: GainNode;
  private leadBus: GainNode;
  private pulse: PeriodicWave;

  constructor(private s: Sound, private c: BaseAudioContext, out: AudioNode, private rev: AudioNode) {
    this.bus = c.createGain();
    this.bus.connect(out);
    this.delay = c.createDelay(1);
    this.delay.delayTime.value = 0.4;
    const fb = c.createGain();
    fb.gain.value = 0.35;
    const wet = c.createGain();
    wet.gain.value = 0.35;
    this.delay.connect(fb).connect(this.delay);
    this.delay.connect(wet).connect(out);
    // guitar amp: drive -> soft clip -> cabinet, then a short Haas double for width (fixed nodes, built once)
    this.amp = c.createGain();
    this.amp.gain.value = 2.2;
    const clip = c.createWaveShaper();
    const n = 1024;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * 2.5) / Math.tanh(2.5);
    }
    clip.curve = curve;
    clip.oversample = '2x';
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 90;
    const cab = c.createBiquadFilter();
    cab.type = 'lowpass';
    cab.frequency.value = 3000;
    cab.Q.value = 0.9;
    const scoop = c.createBiquadFilter();
    scoop.type = 'peaking';
    scoop.frequency.value = 800;
    scoop.Q.value = 0.8;
    scoop.gain.value = -4;
    const post = c.createGain();
    post.gain.value = 0.2;
    this.amp.connect(clip).connect(hp).connect(scoop).connect(cab).connect(post);
    const pl = c.createStereoPanner();
    pl.pan.value = -0.55;
    const pr = c.createStereoPanner();
    pr.pan.value = 0.55;
    const haas = c.createDelay(0.05);
    haas.delayTime.value = 0.013;
    post.connect(pl).connect(this.bus);
    post.connect(haas).connect(pr).connect(this.bus);
    // lead: 25% pulse (NES-style), a touch of echo and room
    const re = new Float32Array(33);
    const im = new Float32Array(33);
    for (let k = 1; k < 33; k++) re[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * 0.25);
    this.pulse = c.createPeriodicWave(re, im);
    this.leadBus = c.createGain();
    const lf = c.createBiquadFilter();
    lf.type = 'lowpass';
    lf.frequency.value = 4200;
    this.leadBus.connect(lf).connect(this.bus);
    const ls = c.createGain();
    ls.gain.value = 0.5;
    lf.connect(ls).connect(this.delay);
    const lr = c.createGain();
    lr.gain.value = 0.25;
    lf.connect(lr).connect(this.rev);
  }

  setMode(m: MusicMode): void {
    if (m === this.mode) {
      this.pending = null;
      return;
    }
    // into or out of the fight from play (or region) music: change on the next bar line so the beat carries over
    const level = (x: MusicMode) => x === 'play' || x === 'region';
    if (this.timer !== null && ((m === 'boss' && level(this.mode)) || (level(m) && this.mode === 'boss'))) {
      this.pending = m;
      return;
    }
    this.pending = null;
    this.apply(m);
  }

  /** The region's theme and whether a fight is on (see Sound.setRegionMusic). A new theme starts from its top. */
  setRegion(theme: number, fight: boolean): void {
    this.wantFight = fight;
    if (theme === this.theme || theme < 0 || theme >= THEMES.length) return;
    this.theme = theme;
    this.regionStep = 0;
    if (this.mode === 'region') {
      this.step = 0;
      this.setTempo();
    }
  }

  private setTempo(): void {
    const m = this.mode;
    this.bpm = m === 'boss' ? BOSS_BPM : m === 'play' ? 112 : m === 'region' ? THEMES[this.theme].bpm : 88;
    if (this.c instanceof AudioContext) this.delay.delayTime.setTargetAtTime((60 / this.bpm / 4) * 3, this.c.currentTime, 0.05);
    else this.delay.delayTime.value = (60 / this.bpm / 4) * 3;
  }

  private apply(m: MusicMode): void {
    const was = this.mode;
    this.mode = m;
    if (was === 'boss') this.bossStep = Math.ceil(this.step / 16) * 16;
    if (was === 'region') {
      this.regionStep = Math.ceil(this.step / 16) * 16;
      this.layer = false;
      this.button = false;
    }
    this.setTempo();
    if (m === 'off') {
      if (this.timer !== null) clearInterval(this.timer);
      this.timer = null;
      return;
    }
    // a fresh fight starts the boss loop from the top; back from a pause (calm) it carries on (a region theme too)
    if (m === 'boss') this.step = was === 'calm' ? this.bossStep : 0;
    else if (m === 'region') this.step = was === 'calm' ? this.regionStep : 0;
    else if (was === 'boss') this.step = 0;
    if (this.timer === null) {
      this.next = this.c.currentTime + 0.08;
      if (was === 'off' && m !== 'boss') this.step = 0;
      this.timer = window.setInterval(() => this.pump(), 25);
    }
  }

  private pump(): void {
    const ahead = this.c.currentTime + 0.15;
    while (this.next < ahead) {
      if (this.pending && this.step % 16 === 0) {
        const m = this.pending;
        this.pending = null;
        this.apply(m);
      }
      this.sched(this.step, this.next);
      this.next += 60 / this.bpm / 4;
      this.step++;
    }
  }

  renderOffline(m: MusicMode, bars: number, from = 0): void {
    this.mode = m;
    this.setTempo();
    const st = 60 / this.bpm / 4;
    for (let i = 0; i < bars * 16; i++) this.sched(from * 16 + i, 0.05 + i * st);
  }

  /** Offline render of a region theme; the fight is on from bar fight[0] to bar fight[1] (fractions allowed). */
  renderRegion(theme: number, bars: number, fight: [number, number]): void {
    this.theme = theme;
    this.mode = 'region';
    this.setTempo();
    const st = 60 / this.bpm / 4;
    for (let i = 0; i < bars * 16; i++) {
      this.wantFight = i >= fight[0] * 16 && i < fight[1] * 16;
      this.sched(i, 0.05 + i * st);
    }
  }

  /** One boss-loop step (16ths at 150 bpm). */
  private schedBoss(step: number, t: number): void {
    const s = this.s;
    const out = this.bus;
    const st = 60 / BOSS_BPM / 4;
    const s16 = step % 16;
    const bar = Math.floor(step / 16) % 32;
    const sec = Math.floor(bar / 8); // 0 A, 1 B, 2 A2, 3 B2
    const b8 = bar % 8;
    const isA = sec % 2 === 0;
    const root = BOSS_ROOTS[isA ? 0 : 1][b8];
    const fill = b8 === 7 && s16 >= 8;
    // drums
    if (s16 === 0 && (b8 === 0 || (sec === 3 && b8 === 4))) s.crash(out, this.rev, t, 1);
    const polka = (sec === 0 && b8 >= 4) || sec === 2;
    if (fill) {
      s.rkick(out, t, 0.62);
      if (s16 === 12 || s16 === 14 || s16 === 15) s.rsnare(out, this.rev, t, 0.7 + (s16 - 12) * 0.08);
    } else if (polka) {
      if (s16 % 4 === 0) s.rkick(out, t, 0.85);
      if (s16 % 4 === 2) s.rsnare(out, this.rev, t, s16 === 6 || s16 === 14 ? 0.85 : 0.6);
    } else {
      if (s16 === 0 || s16 === 8 || s16 === 10 || (s16 === 3 && bar % 2 === 1)) s.rkick(out, t, s16 === 3 ? 0.6 : 0.9);
      if (s16 === 4 || s16 === 12) s.rsnare(out, this.rev, t, 0.9);
    }
    if (s16 % 2 === 0 && !(b8 === 0 && s16 === 0)) s.rhat(out, t, s16 === 14 && bar % 2 === 1, s16 % 4 === 0 ? 0.7 : 1);
    // guitar and bass
    const g = root + 12;
    if (sec === 1) {
      if (s16 % 2 === 0) {
        const open = s16 === 0 || s16 === 6 || s16 === 12;
        s.gtr(this.amp, t, g, open ? st * (s16 === 0 ? 5 : 4) : st * 1.2, !open, 1);
      }
    } else if (sec === 3) {
      if (s16 === 0) s.gtr(this.amp, t, g, st * 8, false, 1);
      else if (s16 === 8) s.gtr(this.amp, t, g, st * 6, false, 0.85);
      else if (s16 % 2 === 0 && s16 > 8) s.gtr(this.amp, t, g, st * 1.2, true, 0.7);
    } else if (GALLOP.includes(s16)) {
      const changed = BOSS_ROOTS[0][(b8 + 7) % 8] !== root || b8 === 0;
      const open = s16 === 0 && changed;
      s.gtr(this.amp, t, g, open ? st * 3.5 : s16 % 4 === 0 ? st * 1.6 : st * 0.9, !open, s16 % 4 === 0 ? 1 : 0.8);
    }
    if (s16 % 2 === 0) s.bass(out, t, root + 12 * (s16 % 8 === 4 ? 1 : 0), st * 1.6);
    // lead
    const tr = st / 2;
    const ost = b8 % 4 === 3 ? OST_A : OST_D;
    if (isA || sec === 3) {
      if (s16 % 2 === 0) {
        const line = (sec === 3 ? BOSS_B2 : BOSS_A)[b8];
        const i = s16 >> 1;
        const n = line[i];
        if (n > 0) {
          let len = 1;
          while (i + len < 8 && line[i + len] === 0) len++;
          const d = len * st * 2 - 0.02;
          s.lead(this.leadBus, t, n, d, 1, tr, this.pulse);
          if (sec === 2) s.lead(this.leadBus, t, n - 12, d, 0.7, tr, 'triangle');
        }
      }
      if (sec === 3) s.arp(out, t, ost[[3, 2, 3, 0][s16 % 4]] + 12, 0.3); // the ostinato as a quiet tsymbaly line
    } else {
      for (const [at, len, o] of SHCHEDRYK) {
        if (at === s16) s.lead(this.leadBus, t, ost[o], len * st - 0.015, 1, tr, this.pulse);
      }
    }
  }

  /** One step of a region theme (16ths). */
  private schedRegion(step: number, t: number): void {
    const s = this.s;
    const th = THEMES[this.theme];
    const out = this.bus;
    const st = 60 / th.bpm / 4;
    const s16 = step % 16;
    const n = th.chords.length;
    const bar = Math.floor(step / 16) % (n * 2);
    const b = bar % n;
    const pass = bar >= n ? 1 : 0;
    const ch = chordOf(th.chords[b]);
    // the fight layer comes in on the next beat (with a crash) and stops at a bar line (with one last hit)
    let entry = false;
    if (this.wantFight && !this.layer && s16 % 4 === 0) {
      this.layer = true;
      this.button = false;
      entry = true;
    } else if (!this.wantFight && this.layer && s16 === 0) {
      this.layer = false;
      this.button = true;
    }
    // calm layer: pad, lead, tsymbaly arp (or a sparse bell)
    if (s16 === 0) s.pad(out, this.rev, t, ch.pad, st * 16, th.padV);
    if (s16 % 2 === 0) {
      const line = th.lead[b];
      const i = s16 >> 1;
      const m = line[i];
      if (m > 0) {
        let len = 1;
        while (i + len < 8 && line[i + len] === 0) len++;
        const d = len * st * 2 - 0.02;
        const tr = th.trem > 0 ? st * th.trem : d + 1;
        s.lead(this.leadBus, t, m, d, th.leadV, tr, th.wave === 'pulse' ? this.pulse : 'triangle');
        if (pass === 1) s.lead(this.leadBus, t, m - 12, d, th.leadV * 0.6, tr, 'triangle');
      }
    }
    const up = pass === 1 ? 24 : 12;
    if (th.arp > 0 && s16 % th.arp === 0) {
      const k = th.arpPat[(s16 / th.arp) % th.arpPat.length];
      const m = (k < 3 ? ch.pad[k] : ch.pad[0] + 12) + up;
      s.arp(this.delay, t, m, 0.28);
      s.arp(out, t, m, 0.22);
    } else if (th.arp === 0 && s16 === 0 && b % 2 === 0) s.arp(this.delay, t, ch.pad[0] + up + 12, 0.5);
    if (this.button && s16 === 0) {
      // the band stops: one last kick and bass note on the downbeat
      this.button = false;
      s.rkick(out, t, 0.7);
      s.bass(out, t, ch.root, st * 6);
    }
    if (!this.layer) return;
    // fight layer
    if (entry) s.crash(out, this.rev, t, 0.6);
    else if (s16 === 0 && b % 8 === 0) s.crash(out, this.rev, t, 0.5);
    const r = ch.root;
    const odd = b % 2 === 1;
    const end4 = b % 4 === 3;
    switch (th.drums) {
      case 'polka': // oom-pah: kick and root on the beat, snare off it, bass walks root-fifth
        if (s16 === 0 || s16 === 8) s.rkick(out, t, 0.75);
        if (s16 === 4 || s16 === 12) s.rsnare(out, this.rev, t, 0.45);
        if (end4 && s16 >= 13) s.rsnare(out, this.rev, t, 0.35 + (s16 - 13) * 0.1);
        if (s16 % 4 === 2) s.rhat(out, t, false, 0.6);
        if (s16 === 0) s.bass(out, t, r, st * 3);
        if (s16 === 8) s.bass(out, t, r + 7, st * 3);
        if (s16 === 12 && odd) s.bass(out, t, r + 12, st * 1.5);
        break;
      case 'train': // wheels on rails: 16th hats with a clatter accent, chugging 8th bass, muted guitar
        if (s16 === 0 || s16 === 8 || (s16 === 10 && odd)) s.rkick(out, t, 0.75);
        if (s16 === 4 || s16 === 12) s.rsnare(out, this.rev, t, 0.5);
        s.rhat(out, t, false, [0.8, 0.3, 0.5, 0.3][s16 % 4] * 0.8);
        if (s16 % 2 === 0) s.bass(out, t, r + (s16 % 4 === 2 ? 12 : 0), st * 1.4);
        if (th.gtr === 'chug' && [0, 3, 6, 8, 11, 14].includes(s16)) s.gtr(this.amp, t, r + 12, st * 1.1, true, 0.4);
        break;
      case 'flow': // half time, soft: kick on 1 and the and of 3, a rim-like snare on 3, long bass notes
        if (s16 === 0 || s16 === 10) s.rkick(out, t, 0.6);
        if (s16 === 8) s.rsnare(out, this.rev, t, 0.35);
        if (s16 % 2 === 0) s.rhat(out, t, s16 === 14 && odd, 0.4);
        if (s16 === 0) s.bass(out, t, r, st * 7);
        if (s16 === 8) s.bass(out, t, r + 7, st * 6);
        break;
      case 'stalk': // sparse and wary: syncopated kick, snare on 3, toms walking down at phrase ends
        if (s16 === 0 || s16 === 10 || (s16 === 3 && odd)) s.rkick(out, t, 0.7);
        if (s16 === 8) s.rsnare(out, this.rev, t, 0.5);
        if (end4 && (s16 === 12 || s16 === 13 || s16 === 14)) s.tom(out, t, 50 - (s16 - 12) * 3, 0.8);
        if (s16 % 4 === 2) s.rhat(out, t, false, 0.35);
        if (s16 === 0) s.bass(out, t, r, st * 5);
        if (s16 === 6) s.bass(out, t, r, st * 2);
        if (s16 === 10) s.bass(out, t, r + 12, st * 4);
        break;
      case 'march': // bass drum on every beat, a snare cadence, rolls at phrase ends, a held power chord
        if (s16 % 4 === 0) s.rkick(out, t, s16 === 0 ? 0.8 : 0.55);
        if (end4 && s16 >= 8) s.rsnare(out, this.rev, t, 0.25 + (s16 - 8) * 0.06);
        else if (s16 === 4 || s16 === 12) s.rsnare(out, this.rev, t, 0.7);
        else if (s16 === 10 || s16 === 11) s.rsnare(out, this.rev, t, 0.3);
        if (s16 % 4 === 0) s.bass(out, t, r, st * 3.5);
        if (th.gtr === 'hold' && s16 === 0) s.gtr(this.amp, t, r + 12, st * 15, false, 0.35);
        break;
    }
  }

  private sched(step: number, t: number): void {
    if (this.mode === 'boss') {
      this.schedBoss(step, t);
      return;
    }
    if (this.mode === 'region') {
      this.schedRegion(step, t);
      return;
    }
    const s = this.s;
    const s16 = step % 16;
    const bar = Math.floor(step / 16);
    const ph = PHRASES[Math.floor(bar / 4) % 2];
    const chord = ph.chords[bar % 4];
    const root = ph.roots[bar % 4];
    const st = 60 / this.bpm / 4;
    const out = this.bus;
    if (this.mode === 'menu' || this.mode === 'calm') {
      if (s16 === 0) {
        s.pad(out, this.rev, t, chord, st * 16, 1);
        s.bass(out, t, root + 12, st * 12);
      }
      if (this.mode === 'menu' && s16 % 2 === 0) {
        const n = chord[(step >> 1) % 3] + (s16 >= 8 ? 24 : 12);
        s.arp(this.delay, t, n, 0.6);
        s.arp(out, t, n, 0.5);
      }
      return;
    }
    // play
    if (s16 === 0) s.pad(out, this.rev, t, chord, st * 16, 0.55);
    if (s16 === 0 || s16 === 8 || (s16 === 14 && bar % 4 === 3)) s.kick(out, t);
    if (s16 === 4 || s16 === 12) s.snare(out, this.rev, t);
    if (s16 % 2 === 0) s.hat(out, t, s16 === 14 && bar % 2 === 1, s16 % 4 === 2 ? 1 : 0.6);
    if (s16 % 2 === 0) s.bass(out, t, root + (s16 % 4 === 2 ? 12 : 0) + 12, st * 1.7);
    const pat = [0, 1, 2, 1, 2, 0, 1, 2];
    const n = chord[pat[s16 % 8]] + (s16 >= 8 ? 24 : 12);
    s.arp(this.delay, t, n, 0.35);
    if (bar % 8 >= 4) s.arp(out, t, n, 0.3);
  }
}
