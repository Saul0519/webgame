import { MAX_PLAYERS_PER_ROOM, ROOM_CODE_LEN } from '@webgame/shared';

export { GameRoom } from './GameRoom.js';

export interface Env {
  GAME_ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
}

// No vowels / ambiguous glyphs: room codes get read out loud.
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/**
 * Public rooms for quick match. Everyone is funnelled into the first one with
 * space so two people opening the site land in the same fight without swapping
 * codes; later rooms only fill once the earlier ones are full.
 */
const PUBLIC_ROOMS = ['ARENA', 'BLAZE', 'CRUX2', 'DELTA', 'EDGE7', 'FRAG9', 'GAMMA', 'HYDRA'];

function makeRoomCode(): string {
  const bytes = new Uint8Array(ROOM_CODE_LEN);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

function normaliseCode(raw: string | null): string | null {
  if (!raw) return null;
  const code = raw.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (code.length !== ROOM_CODE_LEN) return null;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null;
  return code;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

interface RoomSummary {
  code: string;
  players: number;
  bots: number;
  maxPlayers: number;
  mapName: string;
}

async function publicRoomInfo(env: Env): Promise<RoomSummary[]> {
  return Promise.all(
    PUBLIC_ROOMS.map(async (code) => {
      try {
        const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(code));
        const res = await stub.fetch(new Request('https://room/info'));
        const info = (await res.json()) as Partial<RoomSummary>;
        return {
          code,
          players: info.players ?? 0,
          bots: info.bots ?? 0,
          maxPlayers: info.maxPlayers ?? MAX_PLAYERS_PER_ROOM,
          mapName: info.mapName ?? 'Reactor',
        };
      } catch {
        return { code, players: 0, bots: 0, maxPlayers: MAX_PLAYERS_PER_ROOM, mapName: 'Reactor' };
      }
    }),
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // --- Realtime: upgrade straight into the room's Durable Object ---
    if (url.pathname === '/ws') {
      const code = normaliseCode(url.searchParams.get('room'));
      if (!code) return new Response('bad room code', { status: 400 });
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected websocket', { status: 426 });
      }
      const id = env.GAME_ROOM.idFromName(code);
      const stub = env.GAME_ROOM.get(id);
      return stub.fetch(request);
    }

    // --- Lobby API ---
    if (url.pathname === '/api/room' && request.method === 'POST') {
      // Codes are random enough that collisions are vanishingly rare; if one
      // does happen the joiner simply lands in an existing room, which is fine.
      const code = makeRoomCode();
      return json({ code, maxPlayers: MAX_PLAYERS_PER_ROOM });
    }

    if (url.pathname === '/api/room' && request.method === 'GET') {
      const code = normaliseCode(url.searchParams.get('code'));
      if (!code) return json({ error: 'bad_code' }, 400);
      const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(code));
      const res = await stub.fetch(new Request('https://room/info'));
      const info = (await res.json()) as Record<string, unknown>;
      return json({ code, ...info });
    }

    // Server browser: what is running right now, refreshed by the menu.
    if (url.pathname === '/api/rooms') {
      return json({ rooms: await publicRoomInfo(env) });
    }

    if (url.pathname === '/api/quickmatch') {
      const infos = await publicRoomInfo(env);
      const open = infos.filter((i) => i.players < i.maxPlayers);
      // Prefer a room that already has people in it, fullest first.
      const busiest = open.filter((i) => i.players > 0).sort((a, b) => b.players - a.players)[0];
      const chosen = busiest ?? open[0] ?? { code: makeRoomCode(), players: 0 };
      return json({ code: chosen.code, players: chosen.players, public: true });
    }

    if (url.pathname === '/api/health') {
      return json({ ok: true, ts: Date.now() });
    }

    // --- Static client ---
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
