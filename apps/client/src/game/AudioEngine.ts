import { WeaponId } from '@webgame/shared';

/**
 * All sound is synthesised at runtime — no audio files to load, and weapon
 * character comes from the synthesis parameters rather than a sample set.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private muted = false;
  private level = 0.55;

  ensure(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.level;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 8;
    comp.attack.value = 0.002;
    comp.release.value = 0.2;
    this.master.connect(comp).connect(this.ctx.destination);

    const len = Math.floor(this.ctx.sampleRate * 1.0);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.applyGain();
  }

  /** 0..1 master volume. */
  setVolume(v: number): void {
    this.level = Math.max(0, Math.min(1, v));
    this.applyGain();
  }

  private applyGain(): void {
    if (!this.master || !this.ctx) return;
    const target = this.muted ? 0 : this.level;
    // Ramp rather than jump: a step change on a gain node clicks audibly.
    this.master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02);
  }

  get isMuted(): boolean {
    return this.muted;
  }

  private out(gain: number, pan: number): GainNode | null {
    if (!this.ctx || !this.master) return null;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    const p = this.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    g.connect(p).connect(this.master);
    return g;
  }

  private noise(dur: number): AudioBufferSourceNode | null {
    if (!this.ctx || !this.noiseBuf) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    src.start();
    src.stop(this.ctx.currentTime + dur);
    return src;
  }

  /** `distance` and `pan` place the shot relative to the listener. */
  gunshot(weapon: WeaponId, distance: number, pan: number): void {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const atten = 1 / (1 + distance * 0.11);
    const profile = {
      [WeaponId.Rifle]: { body: 170, dur: 0.24, crack: 3200, level: 1.0 },
      [WeaponId.SMG]: { body: 220, dur: 0.16, crack: 3800, level: 0.72 },
      [WeaponId.Shotgun]: { body: 110, dur: 0.42, crack: 2200, level: 1.25 },
      [WeaponId.Sniper]: { body: 82, dur: 0.6, crack: 1800, level: 1.5 },
    }[weapon];

    // Low-frequency thump.
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(profile.body, t);
    osc.frequency.exponentialRampToValueAtTime(38, t + profile.dur * 0.6);
    const og = this.out(0.9 * atten * profile.level, pan);
    if (!og) return;
    og.gain.setValueAtTime(0.9 * atten * profile.level, t);
    og.gain.exponentialRampToValueAtTime(0.0008, t + profile.dur);
    osc.connect(og);
    osc.start(t);
    osc.stop(t + profile.dur + 0.02);

    // Crack: filtered noise burst.
    const src = this.noise(profile.dur * 1.6);
    if (src) {
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(profile.crack, t);
      bp.frequency.exponentialRampToValueAtTime(420, t + profile.dur);
      bp.Q.value = 0.9;
      const ng = this.out(0.8 * atten * profile.level, pan);
      if (ng) {
        ng.gain.setValueAtTime(0.8 * atten * profile.level, t);
        ng.gain.exponentialRampToValueAtTime(0.0008, t + profile.dur * 1.5);
        src.connect(bp).connect(ng);
      }
    }

    // Distant tail: gives the arena a sense of size.
    if (distance > 6) {
      const tail = this.noise(0.5);
      if (tail) {
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 900;
        const tg = this.out(0.18 * atten, pan * 0.5);
        if (tg) {
          tg.gain.setValueAtTime(0, t);
          tg.gain.linearRampToValueAtTime(0.18 * atten, t + 0.05);
          tg.gain.exponentialRampToValueAtTime(0.0008, t + 0.5);
          tail.connect(lp).connect(tg);
        }
      }
    }
  }

  impact(distance: number, pan: number): void {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const atten = 1 / (1 + distance * 0.25);
    const src = this.noise(0.09);
    if (!src) return;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1400 + Math.random() * 1800;
    const g = this.out(0.35 * atten, pan);
    if (!g) return;
    g.gain.setValueAtTime(0.35 * atten, t);
    g.gain.exponentialRampToValueAtTime(0.0006, t + 0.09);
    src.connect(hp).connect(g);
  }

  hitmarker(headshot: boolean): void {
    this.blip(headshot ? 1650 : 1050, 0.06, headshot ? 0.3 : 0.2, 'square');
  }

  kill(): void {
    this.blip(700, 0.09, 0.24, 'triangle');
    setTimeout(() => this.blip(1180, 0.14, 0.26, 'triangle'), 70);
  }

  died(): void {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(320, t);
    osc.frequency.exponentialRampToValueAtTime(48, t + 0.9);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1800, t);
    lp.frequency.exponentialRampToValueAtTime(180, t + 0.9);
    const g = this.out(0.34, 0);
    if (!g) return;
    g.gain.setValueAtTime(0.34, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.95);
    osc.connect(lp).connect(g);
    osc.start(t);
    osc.stop(t + 1.0);
  }

  hurt(): void {
    this.blip(180, 0.16, 0.22, 'sawtooth');
  }

  reload(stage: 'out' | 'in'): void {
    this.blip(stage === 'out' ? 380 : 620, 0.05, 0.16, 'square');
  }

  spawn(): void {
    this.blip(520, 0.1, 0.16, 'sine');
    setTimeout(() => this.blip(780, 0.12, 0.14, 'sine'), 90);
  }

  footstep(distance: number, pan: number): void {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const atten = 1 / (1 + distance * 0.4);
    const src = this.noise(0.08);
    if (!src) return;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 260 + Math.random() * 200;
    bp.Q.value = 1.4;
    const g = this.out(0.2 * atten, pan);
    if (!g) return;
    g.gain.setValueAtTime(0.2 * atten, t);
    g.gain.exponentialRampToValueAtTime(0.0006, t + 0.08);
    src.connect(bp).connect(g);
  }

  private blip(freq: number, dur: number, gain: number, type: OscillatorType): void {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    const g = this.out(gain, 0);
    if (!g) return;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0006, t + dur);
    osc.connect(g);
    osc.start(t);
    osc.stop(t + dur + 0.01);
  }
}
