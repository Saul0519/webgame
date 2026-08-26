import { C2S, MatchRoom, TICK_MS, Writer, writeInputs, type RoomTransport, type WireInput } from '@webgame/shared';
import type { ConnectionHandlers, GameConnection } from './Connection.js';
import { Connection } from './Connection.js';

export interface LocalMatchOptions {
  /** Total participants including the human player. */
  fillTo: number;
  /** 0..1 */
  botSkill: number;
}

/**
 * Hosts the authoritative match in the same tab. The room is the exact same
 * MatchRoom the Durable Object runs, wired to an in-process transport, so
 * offline practice behaves identically to a real server — including prediction,
 * reconciliation and lag compensation (with a round trip of ~0ms).
 */
export class LocalConnection implements GameConnection {
  private readonly handlers: ConnectionHandlers;
  private readonly opts: LocalMatchOptions;
  private room: MatchRoom | null = null;
  private playerId = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  /** Reuses the real client's frame decoder so both paths share one parser. */
  private readonly decoder: Connection;

  rttMs = 0;

  constructor(handlers: ConnectionHandlers, opts: LocalMatchOptions) {
    this.handlers = handlers;
    this.opts = opts;
    this.decoder = new Connection(handlers);
  }

  get open(): boolean {
    return this.room !== null && !this.closed;
  }

  async connect(_room: string, name: string): Promise<void> {
    const room = new MatchRoom({
      fillTo: Math.max(2, this.opts.fillTo),
      botSkill: this.opts.botSkill,
      seed: (Math.floor(performance.now() * 1000) ^ 0x2545f491) >>> 0,
    });
    const transport: RoomTransport = {
      send: (data) => {
        if (!this.closed) this.decoder.ingest(data);
      },
      close: () => this.close(),
    };
    const id = room.join(transport, name);
    if (id === null) throw new Error('local match could not be created');
    this.room = room;
    this.playerId = id;

    const w = new Writer(64);
    w.u8(C2S.Hello).str(name);
    room.message(id, w.finish());

    // Drive the simulation on its own timer so it keeps ticking even when the
    // render loop stutters.
    this.timer = setInterval(() => {
      if (!this.room || this.closed) return;
      try {
        this.room.pump(performance.now());
      } catch (err) {
        console.error('local room tick failed', err);
        this.close();
        this.handlers.onClose('local match crashed');
      }
    }, TICK_MS);
    this.room.pump(performance.now());
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.room?.leave(this.playerId);
    this.room = null;
  }

  private post(build: (w: Writer) => void, size = 64): void {
    if (!this.room || this.closed) return;
    const w = new Writer(size);
    build(w);
    this.room.message(this.playerId, w.finish());
  }

  sendInputs(inputs: WireInput[], rewindMs: number): void {
    if (inputs.length === 0) return;
    this.post((w) => {
      // Same encoder as the network path so the local match exercises the
      // identical wire format.
      writeInputs(w, inputs, Math.round(rewindMs));
    }, 16 + inputs.length * 8);
  }

  sendRespawn(): void {
    this.post((w) => w.u8(C2S.Respawn), 4);
  }

  sendChat(text: string): void {
    this.post((w) => w.u8(C2S.Chat).str(text.slice(0, 120)), 160);
  }

  sendWeapon(id: number): void {
    this.post((w) => w.u8(C2S.SwitchWeapon).u8(id), 4);
  }
}
