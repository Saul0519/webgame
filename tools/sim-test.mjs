/**
 * Deterministic checks on the shared simulation.
 *
 * The smoke test proves the wire and hit registration work against a live
 * server; this one pins the numbers that define how the game *feels* — run and
 * walk speeds, how fast you stop, that jumping cannot buy you speed, and that
 * accuracy is governed by movement. Those are exactly the things a well-meant
 * tweak silently undoes, and unlike the smoke test nothing here depends on
 * where two players happened to spawn.
 *
 * `packages/shared` is TypeScript with `const enum`s, which node's type
 * stripping cannot handle, so it is bundled through esbuild first.
 */
import { loadShared } from './load-shared.mjs';

const S = await loadShared();

const {
  MAX_GROUND_SPEED, MAX_CROUCH_SPEED, WALK_SCALE, TICK_DT,
  WEAPONS, fireSpread, sprayShot, createMoveState, simulateMovement,
  CollisionWorld, getMap, Writer, Reader,
} = S;
const Btn = { Jump: 1, Crouch: 2, Fire: 4, Ads: 8, Sprint: 16, Reload: 32 };
const RIFLE = WEAPONS[0];
const SNIPER = WEAPONS[3];

let failures = 0;
const near = (label, got, want, tol) => {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${round(got)} (want ${round(want)} ±${tol})`);
};
const assert = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const round = (v) => (Number.isFinite(v) ? +v.toFixed(4) : String(v));

// A flat floor, so movement is measured without the arena's ramps and steps.
const world = new CollisionWorld({
  ...getMap('reactor'),
  brushes: [{ min: [-400, -2, -400], max: [400, 0, 400], surface: 0 }],
});

/** Run the shared sim for `ticks` and return the final state. */
function sim(ticks, input, state = createMoveState(0, 0, 0)) {
  for (let i = 0; i < ticks; i++) {
    simulateMovement(state, { forward: 0, right: 0, yaw: 0, pitch: 0, buttons: 0, ...input(i, state) }, world);
  }
  return state;
}
const speed = (s) => Math.hypot(s.vx, s.vz);
/** Matches the client's i8/127 wire quantisation. */
const q = (v) => Math.round(Math.max(-1, Math.min(1, v)) * 127) / 127;
/** Normalise then scale, the way the client builds its input. */
const axes = (f, r, scale) => {
  const l = Math.hypot(f, r);
  if (l > 1) { f /= l; r /= l; }
  return { forward: q(f * scale), right: q(r * scale) };
};

console.log('--- movement ---');
near('run speed', speed(sim(64, () => axes(1, 0, 1))), MAX_GROUND_SPEED, 0.01);
near('run speed, diagonal', speed(sim(64, () => axes(1, 1, 1))), MAX_GROUND_SPEED, 0.01);
const walkStraight = speed(sim(64, () => axes(1, 0, WALK_SCALE)));
const walkDiagonal = speed(sim(64, () => axes(1, 1, WALK_SCALE)));
near('walk speed', walkStraight, MAX_GROUND_SPEED * WALK_SCALE, 0.01);
// Diagonal walk used to be 41% faster: the sim only normalises vectors longer
// than 1, and a pre-scaled diagonal is 0.63 long, so it slipped straight past.
near('walk speed, diagonal', walkDiagonal, walkStraight, 0.05);
near('crouch speed', speed(sim(96, () => ({ ...axes(1, 0, 1), buttons: Btn.Crouch }))), MAX_CROUCH_SPEED, 0.01);

// Time to top speed, and — the "slippery" complaint — time and distance to stop.
const accelState = createMoveState(0, 0, 0);
let ticksToTop = 0;
for (let i = 0; i < 64; i++) {
  simulateMovement(accelState, { ...axes(1, 0, 1), yaw: 0, pitch: 0, buttons: 0 }, world);
  if (speed(accelState) > MAX_GROUND_SPEED * 0.99) { ticksToTop = i + 1; break; }
}
assert('reaches top speed within 100 ms', ticksToTop > 0 && ticksToTop <= 7, `${(ticksToTop * TICK_DT * 1000).toFixed(0)} ms`);

const stopState = sim(64, () => axes(1, 0, 1));
const stopFrom = { x: stopState.x, z: stopState.z };
let ticksToStop = 0;
for (let i = 0; i < 64; i++) {
  simulateMovement(stopState, { forward: 0, right: 0, yaw: 0, pitch: 0, buttons: 0 }, world);
  if (speed(stopState) < 0.05) { ticksToStop = i + 1; break; }
}
const slide = Math.hypot(stopState.x - stopFrom.x, stopState.z - stopFrom.z);
assert('stops within 160 ms', ticksToStop > 0 && ticksToStop <= 10, `${(ticksToStop * TICK_DT * 1000).toFixed(0)} ms`);
assert('slides less than half a metre', slide < 0.5, `${slide.toFixed(2)} m`);

// Air-strafing must not buy speed, or every fight turns into bunny-hopping.
const air = sim(64, () => axes(1, 0, 1));
let airPeak = speed(air);
let apex = air.y;
simulateMovement(air, { ...axes(1, 0, 1), yaw: 0, pitch: 0, buttons: Btn.Jump }, world);
for (let i = 0; i < 64 && !air.grounded; i++) {
  // Turn into the strafe every tick, which is exactly the Quake exploit.
  simulateMovement(air, { ...axes(1, 1, 1), yaw: i * 0.05, pitch: 0, buttons: 0 }, world);
  airPeak = Math.max(airPeak, speed(air));
  apex = Math.max(apex, air.y);
}
assert('air-strafing gains no speed', airPeak <= MAX_GROUND_SPEED * 1.03, `${airPeak.toFixed(2)} m/s`);
assert('jump clears half a metre', apex > 0.5 && apex < 1.3, `${apex.toFixed(2)} m apex`);

console.log('\n--- accuracy ---');
const ctx = (o) => ({ speed: 0, grounded: true, crouching: false, ads: false, sprayIndex: 0, ...o });
const planted = fireSpread(RIFLE, ctx({}));
const walking = fireSpread(RIFLE, ctx({ speed: walkStraight }));
const running = fireSpread(RIFLE, ctx({ speed: MAX_GROUND_SPEED }));
const jumping = fireSpread(RIFLE, ctx({ speed: MAX_GROUND_SPEED, grounded: false }));
const crouched = fireSpread(RIFLE, ctx({ speed: MAX_CROUCH_SPEED, crouching: true }));
assert('planted rifle is pixel exact', planted === 0, `${planted} rad`);
assert('walking costs little', walking > 0 && walking < running * 0.2, `${round(walking)} rad`);
assert('running costs a lot', running > walking * 5, `${round(running)} rad`);
assert('jumping is worse than running', jumping > running, `${round(jumping)} rad`);
assert('crouch-walking beats walking', crouched < walking, `${round(crouched)} rad`);
assert('scoped sniper is exact', fireSpread(SNIPER, ctx({ ads: true })) === 0);
assert('unscoped sniper is not', fireSpread(SNIPER, ctx({ ads: false })) > 0.05);

// The opening burst has to be deterministic or the pattern cannot be learned.
const burst = [0, 1, 2, 3].map((i) => fireSpread(RIFLE, ctx({ sprayIndex: i })));
assert('first four rounds carry no random cone', burst.every((v) => v === 0), burst.map(round).join(', '));
assert('a long spray does open up', fireSpread(RIFLE, ctx({ sprayIndex: 20 })) > 0);

console.log('\n--- recoil pattern ---');
const shots = Array.from({ length: 30 }, (_, i) => sprayShot(RIFLE, i));
assert('first shot does not kick', shots[0].up === 0 && shots[0].side === 0);
assert('pattern is fixed', JSON.stringify(sprayShot(RIFLE, 7)) === JSON.stringify(sprayShot(RIFLE, 7)));
const climbDeg = (shots.slice(0, 10).reduce((a, s) => a + s.up, 0) * 180) / Math.PI;
assert('first ten rounds climb a controllable amount', climbDeg > 8 && climbDeg < 20, `${climbDeg.toFixed(1)}°`);
assert('the climb decays', shots[1].up > shots[5].up && shots[5].up > shots[12].up);
assert('past the table it wanders instead of walking off', sprayShot(RIFLE, 40).side === -sprayShot(RIFLE, 41).side);

console.log('\n--- protocol ---');
for (const name of ['홍길동', 'Recruit', '가나다라마바사아자차카타파하가나', '🎯 sniper']) {
  const w = new Writer();
  w.str(name);
  const bytes = w.finish();
  const round1 = new Reader(bytes).str();
  // A truncated name is fine; a corrupted one is not. U+FFFD means the length
  // prefix cut a multi-byte character in half.
  assert(`"${name}" survives the wire`, !round1.includes('�') && name.startsWith(round1), `-> "${round1}"`);
}

console.log(`\n${failures === 0 ? 'SIM TEST PASS' : `SIM TEST FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
