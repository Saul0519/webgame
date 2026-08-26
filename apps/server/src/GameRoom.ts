import { MatchRoom, TICK_MS, type BotTierName, type RoomTransport } from '@webgame/shared';
import type { Env } from './index.js';

/** Keep matches lively even when only one or two people are online. */
const FILL_TO = 6;
const BOT_TIER: BotTierName = 'regular';

/**
 * Durable Object wrapper around the shared match simulation. Its only jobs are
 * owning the tick timer and bridging Cloudflare WebSockets to RoomTransport --
 * all the game logic lives in @webgame/shared, so the browser can host the exact
 * same match offline.
 */
export class GameRoom implements DurableObject {
  private readonly room: MatchRoom;
  private readonly ids = new Map<WebSocket, number>();
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(_state: DurableObjectState, _env: Env) {
    this.room = new MatchRoom({
      fillTo: FILL_TO,
      botTier: BOT_TIER,
      seed: (Date.now() ^ 0x5bf03635) >>> 0,
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/info') {
      return new Response(JSON.stringify(this.room.info()), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    if (this.room.isFull) {
      return new Response('room full', { status: 503 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    // workerd defaults binary frames to Blob; we want synchronous ArrayBuffers.
    server.binaryType = 'arraybuffer';

    const transport: RoomTransport = {
      send: (data) => server.send(data),
      close: (code, reason) => server.close(code, reason),
    };
    // The first person into an empty room decides how many bots there are and
    // how hard they play. Later joiners inherit it, so the choice cannot be
    // used to reset a match that is already running.
    if (this.room.humanCount === 0) {
      const wanted = Number(url.searchParams.get('bots'));
      this.room.setBotTier((url.searchParams.get('tier') ?? undefined) as BotTierName | undefined);
      this.room.setFillTo(Number.isFinite(wanted) && wanted >= 0 ? wanted : FILL_TO);
    }

    const id = this.room.join(transport, url.searchParams.get('name') ?? '');
    if (id === null) return new Response('room full', { status: 503 });
    this.ids.set(server, id);

    server.addEventListener('message', (ev: MessageEvent) => {
      try {
        this.room.message(id, ev.data as ArrayBuffer);
      } catch (err) {
        console.error('message error', err);
      }
    });
    const drop = () => this.onClose(server);
    server.addEventListener('close', drop);
    server.addEventListener('error', drop);

    this.ensureTicking();
    return new Response(null, { status: 101, webSocket: client });
  }

  private onClose(ws: WebSocket): void {
    const id = this.ids.get(ws);
    if (id === undefined) return;
    this.ids.delete(ws);
    this.room.leave(id);
    if (this.room.humanCount === 0) this.stopTicking();
  }

  private ensureTicking(): void {
    if (this.interval !== null) return;
    this.interval = setInterval(() => {
      try {
        this.room.pump(Date.now());
      } catch (err) {
        console.error('tick error', err);
      }
    }, TICK_MS);
  }

  private stopTicking(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}
