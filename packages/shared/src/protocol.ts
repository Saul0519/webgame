/**
 * Binary wire protocol. One WebSocket frame may contain several messages back
 * to back; readers loop until the buffer is exhausted.
 */

export const enum C2S {
  Hello = 1,
  Input = 2,
  Ping = 3,
  Respawn = 4,
  Chat = 5,
  SwitchWeapon = 6,
}

export const enum S2C {
  Welcome = 128,
  Snapshot = 129,
  Events = 130,
  Pong = 131,
  Denied = 132,
}

export const enum Ev {
  Shot = 1,
  Impact = 2,
  Hit = 3,
  Kill = 4,
  Spawn = 5,
  Join = 6,
  Leave = 7,
  Chat = 8,
  Score = 9,
  MatchState = 10,
}

const ANGLE_SCALE = 32767 / Math.PI;
const VEL_SCALE = 128; // +-255 m/s in an int16
const DIR_SCALE = 32767;

export const packAngle = (a: number): number => {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return Math.round(x * ANGLE_SCALE);
};
export const unpackAngle = (q: number): number => q / ANGLE_SCALE;
/** Quantise an angle the way the wire does, so prediction uses the same value. */
export const quantAngle = (a: number): number => unpackAngle(packAngle(a));

export const packVel = (v: number): number => Math.max(-32768, Math.min(32767, Math.round(v * VEL_SCALE)));
export const unpackVel = (q: number): number => q / VEL_SCALE;

export const packUnit = (v: number): number => Math.max(-32767, Math.min(32767, Math.round(v * DIR_SCALE)));
export const unpackUnit = (q: number): number => q / DIR_SCALE;

export class Writer {
  private buf: ArrayBuffer;
  private view: DataView;
  private u8a: Uint8Array;
  off = 0;

  constructor(cap = 2048) {
    this.buf = new ArrayBuffer(cap);
    this.view = new DataView(this.buf);
    this.u8a = new Uint8Array(this.buf);
  }

  private ensure(n: number): void {
    if (this.off + n <= this.buf.byteLength) return;
    let cap = this.buf.byteLength * 2;
    while (cap < this.off + n) cap *= 2;
    const next = new ArrayBuffer(cap);
    new Uint8Array(next).set(this.u8a);
    this.buf = next;
    this.view = new DataView(next);
    this.u8a = new Uint8Array(next);
  }

  u8(v: number): this { this.ensure(1); this.view.setUint8(this.off, v & 0xff); this.off += 1; return this; }
  i8(v: number): this { this.ensure(1); this.view.setInt8(this.off, v); this.off += 1; return this; }
  u16(v: number): this { this.ensure(2); this.view.setUint16(this.off, v & 0xffff, true); this.off += 2; return this; }
  i16(v: number): this { this.ensure(2); this.view.setInt16(this.off, v, true); this.off += 2; return this; }
  u32(v: number): this { this.ensure(4); this.view.setUint32(this.off, v >>> 0, true); this.off += 4; return this; }
  f32(v: number): this { this.ensure(4); this.view.setFloat32(this.off, v, true); this.off += 4; return this; }
  f64(v: number): this { this.ensure(8); this.view.setFloat64(this.off, v, true); this.off += 8; return this; }

  str(s: string): this {
    const bytes = new TextEncoder().encode(s);
    const n = Math.min(bytes.length, 255);
    this.u8(n);
    this.ensure(n);
    this.u8a.set(bytes.subarray(0, n), this.off);
    this.off += n;
    return this;
  }

  /** Append raw bytes (used to reuse a shared snapshot header). */
  raw(bytes: Uint8Array): this {
    this.ensure(bytes.length);
    this.u8a.set(bytes, this.off);
    this.off += bytes.length;
    return this;
  }

  /** Patch a byte written earlier (used for "count" fields). */
  patchU8(at: number, v: number): void { this.view.setUint8(at, v & 0xff); }

  finish(): ArrayBuffer {
    return this.buf.slice(0, this.off);
  }

  get length(): number { return this.off; }
}

export class Reader {
  private view: DataView;
  private u8a: Uint8Array;
  off = 0;
  readonly length: number;

  constructor(buf: ArrayBuffer | ArrayBufferView) {
    if (ArrayBuffer.isView(buf)) {
      this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      this.u8a = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } else {
      this.view = new DataView(buf);
      this.u8a = new Uint8Array(buf);
    }
    this.length = this.view.byteLength;
  }

  get eof(): boolean { return this.off >= this.length; }

  u8(): number { const v = this.view.getUint8(this.off); this.off += 1; return v; }
  i8(): number { const v = this.view.getInt8(this.off); this.off += 1; return v; }
  u16(): number { const v = this.view.getUint16(this.off, true); this.off += 2; return v; }
  i16(): number { const v = this.view.getInt16(this.off, true); this.off += 2; return v; }
  u32(): number { const v = this.view.getUint32(this.off, true); this.off += 4; return v; }
  f32(): number { const v = this.view.getFloat32(this.off, true); this.off += 4; return v; }
  f64(): number { const v = this.view.getFloat64(this.off, true); this.off += 8; return v; }

  str(): string {
    const n = this.u8();
    const s = new TextDecoder().decode(this.u8a.subarray(this.off, this.off + n));
    this.off += n;
    return s;
  }
}

/** One tick of player input, as it travels on the wire. */
export interface WireInput {
  seq: number;
  buttons: number;
  forward: number; // -1..1 (quantised to 1/127)
  right: number;
  yaw: number; // already quantised
  pitch: number;
}

export const INPUT_BYTES = 7;

export function writeInputs(w: Writer, inputs: WireInput[], renderDelayMs: number): void {
  w.u8(C2S.Input);
  const n = Math.min(inputs.length, 60);
  const first = inputs[inputs.length - n];
  w.u32(first.seq);
  w.u8(n);
  w.u16(renderDelayMs);
  for (let i = inputs.length - n; i < inputs.length; i++) {
    const inp = inputs[i];
    w.u8(inp.buttons);
    w.i8(Math.round(inp.forward * 127));
    w.i8(Math.round(inp.right * 127));
    w.i16(packAngle(inp.yaw));
    w.i16(packAngle(inp.pitch));
  }
}

export function readInputs(r: Reader): { first: number; renderDelayMs: number; inputs: WireInput[] } {
  const first = r.u32();
  const n = r.u8();
  const renderDelayMs = r.u16();
  const inputs: WireInput[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const buttons = r.u8();
    const forward = r.i8() / 127;
    const right = r.i8() / 127;
    const yaw = unpackAngle(r.i16());
    const pitch = unpackAngle(r.i16());
    inputs[i] = { seq: first + i, buttons, forward, right, yaw, pitch };
  }
  return { first, renderDelayMs, inputs };
}
