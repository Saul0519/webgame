import {
  C2S,
  Ev,
  Reader,
  S2C,
  Writer,
  unpackAngle,
  unpackUnit,
  unpackVel,
  writeInputs,
  type WireInput,
} from '@webgame/shared';

export interface SnapPlayer {
  id: number;
  flags: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  health: number;
  weapon: number;
  vx: number;
  vy: number;
  vz: number;
}

export interface Snapshot {
  tick: number;
  serverTime: number;
  /** performance.now() when this snapshot arrived. */
  recvTime: number;
  players: SnapPlayer[];
  ackSeq: number;
  ammo: number;
  magSize: number;
  reloadRemainMs: number;
}

export type GameEvent =
  | { t: 'shot'; id: number; weapon: number; x: number; y: number; z: number; dx: number; dy: number; dz: number; pellets: number }
  | { t: 'impact'; x: number; y: number; z: number; nx: number; ny: number; nz: number; surf: number }
  | { t: 'hit'; target: number; part: number; damage: number; killed: boolean; x: number; y: number; z: number }
  | { t: 'kill'; killer: number; victim: number; weapon: number; suicide: boolean }
  | { t: 'spawn'; id: number; x: number; y: number; z: number; yaw: number }
  | { t: 'join'; id: number; name: string }
  | { t: 'leave'; id: number }
  | { t: 'chat'; id: number; text: string }
  | { t: 'score'; rows: { id: number; name: string; kills: number; deaths: number; score: number; ping: number }[] }
  | { t: 'match'; intermission: boolean; remainingMs: number; killLimit: number };

export interface Welcome {
  playerId: number;
  mapId: string;
  tick: number;
  serverTime: number;
  roster: { id: number; name: string; kills: number; deaths: number }[];
}

/** Everything the game needs from a link to a match, online or in-process. */
export interface GameConnection {
  readonly rttMs: number;
  readonly open: boolean;
  connect(room: string, name: string, bots?: number): Promise<void>;
  close(): void;
  sendInputs(inputs: WireInput[], rewindMs: number): void;
  sendRespawn(): void;
  sendChat(text: string): void;
  sendWeapon(id: number): void;
}

export type ConnectionHandlers = {

  onWelcome: (w: Welcome) => void;
  onSnapshot: (s: Snapshot) => void;
  onEvents: (e: GameEvent[]) => void;
  onClose: (reason: string) => void;
};

type Handlers = ConnectionHandlers;

export class Connection implements GameConnection {
  private ws: WebSocket | null = null;
  private handlers: Handlers;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closedByUs = false;

  /** Smoothed round-trip time in ms. */
  rttMs = 60;
  /** Offset to convert performance.now() into server clock ms. */
  clockOffset = 0;

  constructor(handlers: Handlers) {
    this.handlers = handlers;
  }

  get open(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  connect(room: string, name: string, bots?: number): Promise<void> {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const botParam = bots === undefined ? '' : `&bots=${Math.max(0, Math.min(11, Math.round(bots)))}`;
    const url = `${proto}//${location.host}/ws?room=${encodeURIComponent(room)}&name=${encodeURIComponent(name)}${botParam}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.closedByUs = false;

    return new Promise((resolve, reject) => {
      let settled = false;
      ws.onopen = () => {
        settled = true;
        const w = new Writer(64);
        w.u8(C2S.Hello).str(name);
        ws.send(w.finish());
        this.pingTimer = setInterval(() => this.sendPing(), 1000);
        this.sendPing();
        resolve();
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error('connection failed'));
        }
      };
      ws.onclose = (ev) => {
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = null;
        if (!settled) {
          settled = true;
          reject(new Error(ev.reason || 'connection closed'));
          return;
        }
        if (!this.closedByUs) this.handlers.onClose(ev.reason || 'disconnected');
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') return;
        this.handleFrame(ev.data as ArrayBuffer);
      };
    });
  }

  close(): void {
    this.closedByUs = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  private sendPing(): void {
    if (!this.open) return;
    const w = new Writer(16);
    w.u8(C2S.Ping).f64(performance.now());
    this.ws!.send(w.finish());
  }

  sendInputs(inputs: WireInput[], rewindMs: number): void {
    if (!this.open || inputs.length === 0) return;
    const w = new Writer(16 + inputs.length * 8);
    writeInputs(w, inputs, Math.round(rewindMs));
    this.ws!.send(w.finish());
  }

  sendRespawn(): void {
    if (!this.open) return;
    const w = new Writer(4);
    w.u8(C2S.Respawn);
    this.ws!.send(w.finish());
  }

  sendChat(text: string): void {
    if (!this.open) return;
    const w = new Writer(160);
    w.u8(C2S.Chat).str(text.slice(0, 120));
    this.ws!.send(w.finish());
  }

  sendWeapon(id: number): void {
    if (!this.open) return;
    const w = new Writer(4);
    w.u8(C2S.SwitchWeapon).u8(id);
    this.ws!.send(w.finish());
  }

  /** Decode one server frame. Public so an in-process host can reuse the parser. */
  ingest(buf: ArrayBuffer): void {
    this.handleFrame(buf);
  }

  private handleFrame(buf: ArrayBuffer): void {
    const r = new Reader(buf);
    while (!r.eof) {
      const type = r.u8();
      switch (type) {
        case S2C.Welcome: {
          const playerId = r.u8();
          const mapId = r.str();
          const tick = r.u32();
          const serverTime = r.f64();
          const n = r.u8();
          const roster = [];
          for (let i = 0; i < n; i++) {
            roster.push({ id: r.u8(), name: r.str(), kills: r.u16(), deaths: r.u16() });
          }
          this.handlers.onWelcome({ playerId, mapId, tick, serverTime, roster });
          break;
        }
        case S2C.Snapshot: {
          const tick = r.u32();
          const serverTime = r.f64();
          const n = r.u8();
          const players: SnapPlayer[] = new Array(n);
          for (let i = 0; i < n; i++) {
            players[i] = {
              id: r.u8(),
              flags: r.u8(),
              x: r.f32(),
              y: r.f32(),
              z: r.f32(),
              yaw: unpackAngle(r.i16()),
              pitch: unpackAngle(r.i16()),
              health: r.u8(),
              weapon: r.u8(),
              vx: unpackVel(r.i16()),
              vy: unpackVel(r.i16()),
              vz: unpackVel(r.i16()),
            };
          }
          const ackSeq = r.u32();
          const ammo = r.u8();
          const magSize = r.u8();
          const reloadRemainMs = r.u16();
          this.handlers.onSnapshot({
            tick,
            serverTime,
            recvTime: performance.now(),
            players,
            ackSeq,
            ammo,
            magSize,
            reloadRemainMs,
          });
          break;
        }
        case S2C.Events: {
          const count = r.u8();
          const out: GameEvent[] = [];
          for (let i = 0; i < count; i++) {
            const ev = r.u8();
            switch (ev) {
              case Ev.Shot:
                out.push({
                  t: 'shot',
                  id: r.u8(),
                  weapon: r.u8(),
                  x: r.f32(),
                  y: r.f32(),
                  z: r.f32(),
                  dx: unpackUnit(r.i16()),
                  dy: unpackUnit(r.i16()),
                  dz: unpackUnit(r.i16()),
                  pellets: r.u8(),
                });
                break;
              case Ev.Impact:
                out.push({
                  t: 'impact',
                  x: r.f32(),
                  y: r.f32(),
                  z: r.f32(),
                  nx: r.i8() / 127,
                  ny: r.i8() / 127,
                  nz: r.i8() / 127,
                  surf: r.u8(),
                });
                break;
              case Ev.Hit:
                out.push({
                  t: 'hit',
                  target: r.u8(),
                  part: r.u8(),
                  damage: r.u8(),
                  killed: r.u8() === 1,
                  x: r.f32(),
                  y: r.f32(),
                  z: r.f32(),
                });
                break;
              case Ev.Kill:
                out.push({ t: 'kill', killer: r.u8(), victim: r.u8(), weapon: r.u8(), suicide: r.u8() === 1 });
                break;
              case Ev.Spawn:
                out.push({ t: 'spawn', id: r.u8(), x: r.f32(), y: r.f32(), z: r.f32(), yaw: unpackAngle(r.i16()) });
                break;
              case Ev.Join:
                out.push({ t: 'join', id: r.u8(), name: r.str() });
                break;
              case Ev.Leave:
                out.push({ t: 'leave', id: r.u8() });
                break;
              case Ev.Chat:
                out.push({ t: 'chat', id: r.u8(), text: r.str() });
                break;
              case Ev.Score: {
                const n = r.u8();
                const rows = [];
                for (let k = 0; k < n; k++) {
                  rows.push({
                    id: r.u8(),
                    name: r.str(),
                    kills: r.u16(),
                    deaths: r.u16(),
                    score: r.u32(),
                    ping: r.u16(),
                  });
                }
                out.push({ t: 'score', rows });
                break;
              }
              case Ev.MatchState:
                out.push({ t: 'match', intermission: r.u8() === 1, remainingMs: r.u32(), killLimit: r.u16() });
                break;
              default:
                return; // desync: stop parsing this frame
            }
          }
          this.handlers.onEvents(out);
          break;
        }
        case S2C.Pong: {
          const sent = r.f64();
          const serverNow = r.f64();
          r.u32();
          const rtt = performance.now() - sent;
          this.rttMs = this.rttMs * 0.8 + rtt * 0.2;
          // Server clock at the moment we received this pong, estimated.
          this.clockOffset = serverNow + rtt / 2 - performance.now();
          break;
        }
        default:
          return;
      }
    }
  }
}
