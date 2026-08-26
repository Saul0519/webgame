// End-to-end smoke test for the authoritative server.
import { loadShared } from './load-shared.mjs';
//
//   1. terminal A:  pnpm dev:server
//   2. terminal B:  node tools/smoke-test.mjs
//
// It speaks the binary protocol with its own hand-rolled encoder/decoder, so a
// pass also proves the wire format matches what packages/shared produces.
// Exits non-zero on failure, which makes it usable in CI.
const BASE = process.env.WEBGAME_SERVER ?? 'http://127.0.0.1:8787';
const TICK_MS = 1000 / 64;
const ANGLE_SCALE = 32767 / Math.PI;

const res = await fetch(`${BASE}/api/room`, { method: 'POST' });
const { code } = await res.json();
console.log('room:', code);

function helloMsg(name) {
  const nb = new TextEncoder().encode(name);
  const b = new Uint8Array(2 + nb.length);
  b[0] = 1; b[1] = nb.length; b.set(nb, 2);
  return b;
}

function inputMsg(firstSeq, inputs, rewind) {
  const buf = new ArrayBuffer(8 + inputs.length * 7);
  const v = new DataView(buf);
  v.setUint8(0, 2);
  v.setUint32(1, firstSeq, true);
  v.setUint8(5, inputs.length);
  v.setUint16(6, rewind, true);
  let o = 8;
  for (const i of inputs) {
    v.setUint8(o, i.buttons);
    v.setInt8(o + 1, Math.round(i.forward * 127));
    v.setInt8(o + 2, Math.round(i.right * 127));
    v.setInt16(o + 3, Math.round(i.yaw * ANGLE_SCALE), true);
    v.setInt16(o + 5, Math.round(i.pitch * ANGLE_SCALE), true);
    o += 7;
  }
  return new Uint8Array(buf);
}

function connect(name) {
  return new Promise((resolve, reject) => {
    // bots=0 keeps the room to just these two clients so the assertions are stable.
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws?room=${code}&name=${name}&bots=0`);
    ws.binaryType = 'arraybuffer';
    const state = { ws, id: 0, snapshots: 0, events: [], last: null, ammo: -1, seq: 1, all: new Map() };
    ws.onerror = (e) => reject(new Error('ws error'));
    ws.onmessage = (ev) => {
      const v = new DataView(ev.data);
      let o = 0;
      while (o < v.byteLength) {
        const t = v.getUint8(o); o += 1;
        if (t === 128) {
          state.id = v.getUint8(o); o += 1;
          const n = v.getUint8(o); o += 1 + n;      // map id string
          o += 4 + 8;                               // tick + time
          const rc = v.getUint8(o); o += 1;
          for (let i = 0; i < rc; i++) { o += 1; const ln = v.getUint8(o); o += 1 + ln + 4; }
          resolve(state);
        } else if (t === 129) {
          o += 4 + 8;
          const n = v.getUint8(o); o += 1;
          for (let i = 0; i < n; i++) {
            const id = v.getUint8(o);
            const p = {
              id,
              flags: v.getUint8(o + 1),
              x: v.getFloat32(o + 2, true),
              y: v.getFloat32(o + 6, true),
              z: v.getFloat32(o + 10, true),
              health: v.getUint8(o + 18),
            };
            if (id === state.id) state.last = p;
            state.all.set(id, p);
            o += 26;
          }
          o += 4;                                   // ack
          state.ammo = v.getUint8(o); o += 1;
          o += 1 + 2;                               // mag + reload
          state.snapshots++;
        } else if (t === 130) {
          const n = v.getUint8(o); o += 1;
          for (let i = 0; i < n; i++) {
            const e = v.getUint8(o); o += 1;
            state.events.push(e);
            if (e === 1) o += 1 + 1 + 12 + 6 + 1;
            else if (e === 2) o += 12 + 3 + 1;
            else if (e === 3) o += 1 + 1 + 1 + 1 + 12;
            else if (e === 4) o += 4;
            else if (e === 5) o += 1 + 12 + 2;
            else if (e === 6) { o += 1; const ln = v.getUint8(o); o += 1 + ln; }
            else if (e === 7) o += 1;
            else if (e === 8) { o += 1; const ln = v.getUint8(o); o += 1 + ln; }
            else if (e === 9) {
              const rc = v.getUint8(o); o += 1;
              for (let k = 0; k < rc; k++) { o += 1; const ln = v.getUint8(o); o += 1 + ln + 2 + 2 + 4 + 2; }
            } else if (e === 10) o += 1 + 4 + 2;
            else { o = v.byteLength; break; }
          }
        } else if (t === 131) {
          o += 8 + 8 + 4;
        } else {
          o = v.byteLength;
        }
      }
    };
    ws.onopen = () => ws.send(helloMsg(name));
    setTimeout(() => reject(new Error('timeout waiting for welcome')), 5000);
  });
}

const a = await connect('Alpha');
const b = await connect('Bravo');
console.log('joined ids:', a.id, b.id);

async function drive(state, opts, ticks) {
  for (let batch = 0; batch < ticks / 4; batch++) {
    const inputs = [];
    for (let i = 0; i < 4; i++) {
      const o = typeof opts === 'function' ? opts() : opts;
      inputs.push({ buttons: o.buttons, forward: o.forward, right: 0, yaw: o.yaw, pitch: o.pitch ?? 0 });
    }
    state.ws.send(inputMsg(state.seq, inputs, 100));
    state.seq += 4;
    if (process.env.TRACE && batch % 16 === 0 && state.last) {
      console.log('  trace', state.id, state.last.x.toFixed(1), state.last.y.toFixed(1), state.last.z.toFixed(1), 'yaw', inputs[0].yaw.toFixed(2), 'fwd', inputs[0].forward);
    }
    await new Promise((r) => setTimeout(r, TICK_MS * 4));
  }
}

// Stand still for a moment so both clients have a baseline snapshot.
await drive(a, { buttons: 0, forward: 0, yaw: 0 }, 32);
await drive(b, { buttons: 0, forward: 0, yaw: 0 }, 32);
const startA = { ...a.last };
console.log('A spawn:', startA.x.toFixed(2), startA.y.toFixed(2), startA.z.toFixed(2), 'hp', startA.health);

// Walk forward for half a second.
await drive(a, { buttons: 0, forward: 1, yaw: 1.2 }, 64);
const moved = Math.hypot(a.last.x - startA.x, a.last.z - startA.z);
console.log('A moved:', moved.toFixed(2), 'm ->', a.last.x.toFixed(2), a.last.z.toFixed(2));

// Fire a burst into whatever is ahead.
const ammoBefore = a.ammo;
await drive(a, { buttons: 4, forward: 0, yaw: 1.2 }, 48);
console.log('ammo:', ammoBefore, '->', a.ammo);
const impacts = a.events.filter((e) => e === 2).length;
const shots = a.events.filter((e) => e === 1).length;
console.log('events: shots', shots, 'impacts', impacts, 'total', a.events.length);
console.log('snapshots A/B:', a.snapshots, b.snapshots);

// --- Hit registration -----------------------------------------------------
// The arena centre is a solid 3m platform, so walking straight at each other
// just wedges both players against it. Orbit them around the ring in opposite
// directions until they meet with clear line of sight, then open fire.
const aimAt = (self, other, buttons, forward, offset = 0) => () => {
  const me = self.last;
  const them = other.last;
  if (!me || !them) return { buttons, forward, yaw: 0, pitch: 0 };
  const dx = them.x - me.x;
  const dz = them.z - me.z;
  const dy = them.y + 1.1 - (me.y + 1.62);
  const horiz = Math.hypot(dx, dz) || 1;
  return { buttons, forward, yaw: Math.atan2(-dx, -dz) + offset, pitch: Math.atan2(dy, horiz) };
};

console.log('B at', b.last.x.toFixed(1), b.last.y.toFixed(1), b.last.z.toFixed(1));

// The same collision world the server uses. Blind navigation could not reliably
// find a shot in this arena — the centre is a solid platform and two players
// walking at each other simply wedge against opposite sides of it — so check
// line of sight properly and sidestep only until it opens.
const shared = await loadShared();
const losWorld = new shared.CollisionWorld(shared.getMap('reactor'));
const hasLineOfSight = () => {
  const ox = a.last.x;
  const oy = a.last.y + 1.62;
  const oz = a.last.z;
  const dx = b.last.x - ox;
  const dy = b.last.y + 1.1 - oy;
  const dz = b.last.z - oz;
  const len = Math.hypot(dx, dy, dz) || 1;
  const hit = losWorld.raycast(ox, oy, oz, dx / len, dy / len, dz / len, len);
  return hit === null || hit.t >= len - 0.5;
};

const dmgCount = () => b.events.filter((e) => e === 3).length;
// Orbit rather than close: the arena centre is a solid platform, so walking
// straight at each other just wedges both players against opposite sides of it
// at a fixed range with no shot between them.
// Both players walk to the same open point rather than chasing each other.
// Chasing does not converge here: the arena centre is a solid platform, so two
// clients running the same controller mirror each other and settle on opposite
// sides of it, and a one-sided circle just walks into the outer wall. Meeting
// at a fixed spot has no such fixed point — they both simply arrive.
const RENDEZVOUS_POINTS = (() => {
  const map = shared.getMap('reactor');
  const world = new shared.CollisionWorld(map);
  const clearAt = (x, z) => !world.boxOverlaps(x, 0.9, z, { x: 0.4, y: 0.9, z: 0.4 });
  // Somewhere genuinely open, not a nook: a standing spot with 3 m of clearance
  // all round, so both players can walk in from any direction.
  const open = (x, z) => {
    if (!clearAt(x, z)) return false;
    for (let i = 0; i < 8; i++) {
      const th = (i / 8) * Math.PI * 2;
      if (!clearAt(x + Math.cos(th) * 3, z + Math.sin(th) * 3)) return false;
    }
    return true;
  };
  // Collect several, spread around the ring: if a client cannot find its way to
  // the first, it gets to try somewhere else rather than pacing a wall.
  const spots = [];
  for (let i = 0; i < 32 && spots.length < 4; i++) {
    const th = ((((i * 11) % 32) / 32) * Math.PI * 2); // stride, so they are not adjacent
    for (let r = 22; r <= 30; r += 1.5) {
      const x = Math.cos(th) * r;
      const z = Math.sin(th) * r;
      if (open(x, z)) {
        spots.push({ x, z });
        break;
      }
    }
  }
  return spots.length > 0 ? spots : [{ x: 0, z: 22 }];
})();
let rvIndex = 0;
let RENDEZVOUS = RENDEZVOUS_POINTS[0];

const walkTo = (client, ticks, offset) =>
  drive(
    client,
    () => {
      const me = client.last;
      const dx = RENDEZVOUS.x - me.x;
      const dz = RENDEZVOUS.z - me.z;
      return { buttons: 0, forward: 1, yaw: Math.atan2(-dx, -dz) + offset, pitch: 0 };
    },
    ticks,
  );
const distTo = (client) => Math.hypot(client.last.x - RENDEZVOUS.x, client.last.z - RENDEZVOUS.z);

let losRange = Math.hypot(a.last.x - b.last.x, a.last.z - b.last.z);
let attempts = 0;
let found = false;
const bHealthBefore = b.last.health;
let prevA = distTo(a);
let prevB = distTo(b);
let stuckA = 0;
let stuckB = 0;
let barren = 0;
for (; attempts < 30 && !found; attempts++) {
  // Sidestep when a leg makes no progress, alternating hands so a corner is
  // escaped rather than pressed into.
  const oA = stuckA === 0 ? 0 : stuckA === 1 ? 1.1 : -1.1;
  const oB = stuckB === 0 ? 0 : stuckB === 1 ? 1.1 : -1.1;
  let dA = distTo(a);
  let dB = distTo(b);
  // Wedged: sidestepping only presses harder into the corner, so reverse out of
  // it every third barren leg and pick the walk up again from open ground.
  const backOut = barren > 0 && barren % 3 === 0;
  if (backOut) {
    await Promise.all([
      drive(a, { buttons: 0, forward: dA > 4 ? -1 : 0, yaw: a.last.yaw ?? 0 }, 36),
      drive(b, { buttons: 0, forward: dB > 4 ? -1 : 0, yaw: b.last.yaw ?? 0 }, 36),
    ]);
  }
  await Promise.all([walkTo(a, 80, oA), walkTo(b, 80, oB)]);
  dA = distTo(a);
  dB = distTo(b);
  barren = dA < 4 && dB < 4 ? 0 : barren + 1;
  // Neither of them can get here. Try somewhere else on the ring.
  if (barren > 0 && barren % 10 === 0 && RENDEZVOUS_POINTS.length > 1) {
    rvIndex = (rvIndex + 1) % RENDEZVOUS_POINTS.length;
    RENDEZVOUS = RENDEZVOUS_POINTS[rvIndex];
    prevA = distTo(a);
    prevB = distTo(b);
    stuckA = 0;
    stuckB = 0;
    continue;
  }
  // Cycle straight -> right -> left -> straight rather than counting up: a
  // sidestep that keeps growing walks the client away from the target and it
  // never comes back.
  stuckA = dA < prevA - 0.8 || dA < 2.5 ? 0 : (stuckA + 1) % 3;
  stuckB = dB < prevB - 0.8 || dB < 2.5 ? 0 : (stuckB + 1) % 3;
  prevA = dA;
  prevB = dB;
  if (dA > 4 || dB > 4 || !hasLineOfSight()) continue;

  await Promise.all([drive(a, aimAt(a, b, 0, 0), 16), drive(b, { buttons: 0, forward: 0, yaw: 0 }, 16)]);
  const before = dmgCount();
  await Promise.all([drive(a, aimAt(a, b, 4, 0), 20), drive(b, { buttons: 0, forward: 0, yaw: 0 }, 20)]);
  found = dmgCount() > before;
  losRange = Math.hypot(a.last.x - b.last.x, a.last.z - b.last.z);
}

const damaged = found;
console.log('rendezvous', RENDEZVOUS.x.toFixed(1), RENDEZVOUS.z.toFixed(1),
  `(${rvIndex + 1}/${RENDEZVOUS_POINTS.length})`,
  '| hits after', attempts, 'leg(s) | range', losRange.toFixed(1), 'm');
if (!found) {
  console.log('  no shot found — A', a.last.x.toFixed(1), a.last.z.toFixed(1),
    '| B', b.last.x.toFixed(1), b.last.z.toFixed(1), '| clear:', hasLineOfSight());
}
console.log('B health:', bHealthBefore, '->', b.last.health);

const ok =
  a.id !== b.id &&
  damaged &&
  a.snapshots > 20 &&
  b.snapshots > 20 &&
  moved > 1.5 &&
  a.ammo < ammoBefore &&
  shots > 0;
console.log(ok ? 'SMOKE TEST PASS' : 'SMOKE TEST FAIL');
a.ws.close();
b.ws.close();
process.exit(ok ? 0 : 1);
