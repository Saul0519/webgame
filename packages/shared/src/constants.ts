/**
 * Simulation constants shared by client prediction and server authority.
 * Any change here must be deployed to both sides at once or prediction desyncs.
 */

/** Authoritative simulation ticks per second. */
export const TICK_RATE = 64;
export const TICK_DT = 1 / TICK_RATE;
export const TICK_MS = 1000 / TICK_RATE;

/** How often the server pushes a world snapshot (every N ticks). */
export const SNAPSHOT_EVERY = 2; // -> 32 Hz
export const SNAPSHOT_MS = TICK_MS * SNAPSHOT_EVERY;

/** Remote entities are rendered this far in the past so we always interpolate. */
export const INTERP_DELAY_MS = 100;

/** Server keeps this much position history for lag compensation. */
export const LAGCOMP_HISTORY_MS = 1000;
/** Hard cap on how far back a client is allowed to rewind the world. */
export const LAGCOMP_MAX_REWIND_MS = 250;

/** Inputs older than this (relative to the newest accepted) are dropped. */
export const MAX_INPUT_BACKLOG = 32;

// --- Player capsule (approximated as an axis-aligned box for collision) ---
export const PLAYER_RADIUS = 0.4;
export const PLAYER_HEIGHT = 1.8;
export const PLAYER_CROUCH_HEIGHT = 1.15;
export const EYE_HEIGHT = 1.62;
export const EYE_HEIGHT_CROUCH = 1.0;

// --- Movement (Quake/Source style: crisp, skill-expressive, fully deterministic) ---
export const GRAVITY = 20.0;
export const MAX_GROUND_SPEED = 8.2;
export const MAX_CROUCH_SPEED = 3.6;
export const MAX_AIR_SPEED = 1.2; // air-strafe control cap, not a velocity cap
export const GROUND_ACCEL = 90.0;
export const AIR_ACCEL = 70.0;
export const FRICTION = 8.5;
export const STOP_SPEED = 1.6;
export const JUMP_VELOCITY = 6.9;
export const STEP_HEIGHT = 0.42;
export const MAX_FALL_SPEED = 60.0;
/** Coyote time + jump buffering, in ticks. */
export const COYOTE_TICKS = 6;

// --- Combat ---
export const MAX_HEALTH = 100;
export const RESPAWN_DELAY_MS = 2500;
export const SPAWN_PROTECTION_MS = 1200;

export const enum Team {
  None = 0,
}

/** Input button bitmask. */
export const enum Btn {
  Jump = 1 << 0,
  Crouch = 1 << 1,
  Fire = 1 << 2,
  Ads = 1 << 3,
  Sprint = 1 << 4,
  Reload = 1 << 5,
}

/** Player state flags sent in snapshots. */
export const enum PFlag {
  Dead = 1 << 0,
  Crouching = 1 << 1,
  Grounded = 1 << 2,
  Firing = 1 << 3,
  Reloading = 1 << 4,
  Ads = 1 << 5,
  SpawnProtected = 1 << 6,
}

export const MAX_PLAYERS_PER_ROOM = 12;
export const NAME_MAX_LEN = 16;
export const ROOM_CODE_LEN = 5;
