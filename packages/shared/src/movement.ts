import {
  AIR_ACCEL,
  Btn,
  COYOTE_TICKS,
  EYE_HEIGHT,
  EYE_HEIGHT_CROUCH,
  FRICTION,
  GRAVITY,
  GROUND_ACCEL,
  JUMP_VELOCITY,
  MAX_AIR_SPEED,
  MAX_CROUCH_SPEED,
  MAX_FALL_SPEED,
  MAX_GROUND_SPEED,
  PLAYER_CROUCH_HEIGHT,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  STEP_HEIGHT,
  STOP_SPEED,
  TICK_DT,
} from './constants.js';
import type { CollisionWorld } from './collision.js';
import type { Vec3 } from './math.js';

/** The part of a player's state that the movement simulation owns. */
export interface MoveState {
  x: number;
  y: number; // feet position
  z: number;
  vx: number;
  vy: number;
  vz: number;
  grounded: boolean;
  crouching: boolean;
  /** Ticks since we were last on the ground (for coyote time). */
  airTicks: number;
  /** Eye height, smoothed toward the stance target. */
  eye: number;
}

export interface MoveInput {
  /** -1..1 forward/back and right/left. */
  forward: number;
  right: number;
  yaw: number;
  pitch: number;
  buttons: number;
}

export function createMoveState(x: number, y: number, z: number): MoveState {
  return {
    x,
    y,
    z,
    vx: 0,
    vy: 0,
    vz: 0,
    grounded: false,
    crouching: false,
    airTicks: 0,
    eye: EYE_HEIGHT,
  };
}

const halfScratch: Vec3 = { x: PLAYER_RADIUS, y: PLAYER_HEIGHT / 2, z: PLAYER_RADIUS };

function halfFor(crouching: boolean): Vec3 {
  halfScratch.x = PLAYER_RADIUS;
  halfScratch.z = PLAYER_RADIUS;
  halfScratch.y = (crouching ? PLAYER_CROUCH_HEIGHT : PLAYER_HEIGHT) / 2;
  return halfScratch;
}

function accelerate(s: MoveState, wx: number, wz: number, wishSpeed: number, accel: number): void {
  const current = s.vx * wx + s.vz * wz;
  const add = wishSpeed - current;
  if (add <= 0) return;
  let accelSpeed = accel * wishSpeed * TICK_DT;
  if (accelSpeed > add) accelSpeed = add;
  s.vx += wx * accelSpeed;
  s.vz += wz * accelSpeed;
}

function applyFriction(s: MoveState): void {
  const speed = Math.sqrt(s.vx * s.vx + s.vz * s.vz);
  if (speed < 1e-4) {
    s.vx = 0;
    s.vz = 0;
    return;
  }
  const control = speed < STOP_SPEED ? STOP_SPEED : speed;
  let drop = control * FRICTION * TICK_DT;
  let newSpeed = speed - drop;
  if (newSpeed < 0) newSpeed = 0;
  const scale = newSpeed / speed;
  s.vx *= scale;
  s.vz *= scale;
}

/**
 * Slide-move the player box through the world, stepping over small ledges.
 * Mutates `s`. Runs identically on client and server.
 */
function slideMove(s: MoveState, world: CollisionWorld, dt: number): void {
  const half = halfFor(s.crouching);
  const hy = half.y;

  let remX = s.vx * dt;
  let remY = s.vy * dt;
  let remZ = s.vz * dt;

  // Try a step-up when a horizontal move is blocked by something short.
  const startX = s.x;
  const startY = s.y;
  const startZ = s.z;
  const startVx = s.vx;
  const startVz = s.vz;

  let bumped = false;
  for (let iter = 0; iter < 4; iter++) {
    const cx = s.x;
    const cy = s.y + hy;
    const cz = s.z;
    const hit = world.sweepBox(cx, cy, cz, { x: half.x, y: hy, z: half.z }, remX, remY, remZ);
    if (!hit) {
      s.x += remX;
      s.y += remY;
      s.z += remZ;
      break;
    }
    bumped = true;
    const t = Math.max(0, hit.t - 1e-3);
    s.x += remX * t;
    s.y += remY * t;
    s.z += remZ * t;
    remX *= 1 - t;
    remY *= 1 - t;
    remZ *= 1 - t;
    // Project the remaining motion and the velocity onto the surface plane.
    const dotR = remX * hit.nx + remY * hit.ny + remZ * hit.nz;
    remX -= hit.nx * dotR;
    remY -= hit.ny * dotR;
    remZ -= hit.nz * dotR;
    const dotV = s.vx * hit.nx + s.vy * hit.ny + s.vz * hit.nz;
    s.vx -= hit.nx * dotV;
    s.vy -= hit.ny * dotV;
    s.vz -= hit.nz * dotV;
  }

  // Step-up retry: if we hit a wall while grounded, try again from a raised
  // start so stairs and small ledges are walkable.
  if (bumped && s.grounded) {
    const movedSq = (s.x - startX) ** 2 + (s.z - startZ) ** 2;
    const wantedSq = (startVx * dt) ** 2 + (startVz * dt) ** 2;
    if (movedSq < wantedSq * 0.95) {
      const sx = startX;
      const sy = startY + STEP_HEIGHT;
      const sz = startZ;
      if (!world.boxOverlaps(sx, sy + hy, sz, { x: half.x, y: hy, z: half.z })) {
        const st: MoveState = { ...s, x: sx, y: sy, z: sz, vx: startVx, vy: 0, vz: startVz };
        let rx = startVx * dt;
        let rz = startVz * dt;
        for (let iter = 0; iter < 4; iter++) {
          const hit = world.sweepBox(st.x, st.y + hy, st.z, { x: half.x, y: hy, z: half.z }, rx, 0, rz);
          if (!hit) {
            st.x += rx;
            st.z += rz;
            break;
          }
          const t = Math.max(0, hit.t - 1e-3);
          st.x += rx * t;
          st.z += rz * t;
          rx *= 1 - t;
          rz *= 1 - t;
          const dotR = rx * hit.nx + rz * hit.nz;
          rx -= hit.nx * dotR;
          rz -= hit.nz * dotR;
        }
        const stepMovedSq = (st.x - startX) ** 2 + (st.z - startZ) ** 2;
        if (stepMovedSq > movedSq + 1e-4) {
          // Drop back down onto the step.
          const down = world.sweepBox(st.x, st.y + hy, st.z, { x: half.x, y: hy, z: half.z }, 0, -(STEP_HEIGHT + 0.02), 0);
          const dropT = down ? Math.max(0, down.t - 1e-3) : 1;
          const landY = st.y - (STEP_HEIGHT + 0.02) * dropT;
          if (!world.boxOverlaps(st.x, landY + hy, st.z, { x: half.x, y: hy, z: half.z })) {
            s.x = st.x;
            s.y = landY;
            s.z = st.z;
            s.vx = startVx;
            s.vz = startVz;
          }
        }
      }
    }
  }
}

function checkGround(s: MoveState, world: CollisionWorld): boolean {
  const half = halfFor(s.crouching);
  const hy = half.y;
  if (s.vy > 0.1) return false;
  const hit = world.sweepBox(s.x, s.y + hy, s.z, { x: half.x, y: hy, z: half.z }, 0, -0.06, 0);
  return hit !== null && hit.ny > 0.5;
}

/** Advance one player by exactly one tick. Deterministic and side-effect free. */
export function simulateMovement(s: MoveState, input: MoveInput, world: CollisionWorld): void {
  const wantCrouch = (input.buttons & Btn.Crouch) !== 0;
  if (!wantCrouch && s.crouching) {
    // Only stand up if there is room.
    const half = halfFor(false);
    if (!world.boxOverlaps(s.x, s.y + half.y, s.z, { x: half.x, y: half.y, z: half.z })) {
      s.crouching = false;
    }
  } else if (wantCrouch) {
    s.crouching = true;
  }

  // Wish direction in world space.
  let f = input.forward;
  let r = input.right;
  const len = Math.hypot(f, r);
  if (len > 1) {
    f /= len;
    r /= len;
  }
  const sy = Math.sin(input.yaw);
  const cy = Math.cos(input.yaw);
  // yaw=0 faces -Z
  const wx = -sy * f + cy * r;
  const wz = -cy * f - sy * r;
  const wlen = Math.hypot(wx, wz);
  const wnx = wlen > 1e-5 ? wx / wlen : 0;
  const wnz = wlen > 1e-5 ? wz / wlen : 0;

  const maxSpeed = s.crouching ? MAX_CROUCH_SPEED : MAX_GROUND_SPEED;
  const wishSpeed = wlen * maxSpeed;

  s.grounded = checkGround(s, world);
  if (s.grounded) {
    s.airTicks = 0;
  } else {
    s.airTicks++;
  }

  const canJump = s.grounded || s.airTicks <= COYOTE_TICKS;
  if ((input.buttons & Btn.Jump) !== 0 && canJump && s.vy <= JUMP_VELOCITY * 0.5) {
    s.vy = JUMP_VELOCITY;
    s.grounded = false;
    s.airTicks = COYOTE_TICKS + 1;
  }

  if (s.grounded) {
    applyFriction(s);
    accelerate(s, wnx, wnz, wishSpeed, GROUND_ACCEL);
    if (s.vy < 0) s.vy = 0;
  } else {
    const airWish = Math.min(wishSpeed, MAX_AIR_SPEED);
    accelerate(s, wnx, wnz, airWish, AIR_ACCEL);
    s.vy -= GRAVITY * TICK_DT;
    if (s.vy < -MAX_FALL_SPEED) s.vy = -MAX_FALL_SPEED;
  }

  slideMove(s, world, TICK_DT);

  // Re-evaluate ground after moving so the flag we report matches the position.
  s.grounded = checkGround(s, world);
  if (s.grounded && s.vy < 0) s.vy = 0;

  // Smooth the eye height toward the stance target (cosmetic, but keep it in
  // the shared sim so the server's lag-comp head position matches the client).
  const targetEye = s.crouching ? EYE_HEIGHT_CROUCH : EYE_HEIGHT;
  s.eye += (targetEye - s.eye) * Math.min(1, 14 * TICK_DT);
}
