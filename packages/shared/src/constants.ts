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

// --- Movement ---
// Tuned for a tactical shooter: you reach full speed almost instantly, you stop
// almost instantly, and the air gives you very little. Momentum you cannot
// cancel is what reads as "slippery", so friction is high and the stop-speed
// floor is well above walking pace. Air control exists only to let you adjust a
// jump, never to gain speed.
export const GRAVITY = 20.0;
/** Full run, m/s. */
export const MAX_GROUND_SPEED = 6.75;
/**
 * Shift-walk, applied client-side as a scale on the movement axes.
 *
 * Exactly representable on the wire: the input axes travel as i8/127, so a
 * value the quantiser rounds (0.45 -> 57/127) would leave the client predicting
 * a speed the server never simulates, and the reconciler correcting for it on
 * every single tick the player walks.
 */
export const WALK_SCALE = 57 / 127;
export const MAX_CROUCH_SPEED = 2.16;
/** Air-strafe wish-speed cap. Deliberately tiny: no strafe-jump acceleration. */
export const MAX_AIR_SPEED = 0.55;
export const GROUND_ACCEL = 62.0;
export const AIR_ACCEL = 18.0;
export const FRICTION = 12.0;
/** Friction is computed against at least this speed, so the last metre per
 * second bleeds off as fast as the first — that is what kills the slide. */
export const STOP_SPEED = 3.4;
export const JUMP_VELOCITY = 6.0;
/** Horizontal speed is hard-capped in the air, so bunny-hopping gains nothing. */
export const AIR_SPEED_CAP = MAX_GROUND_SPEED * 1.02;
/** Fraction of horizontal speed kept on touching down, so landings cost tempo. */
export const LAND_SPEED_KEEP = 0.72;
/**
 * Airborne at least this long to be charged the landing tax. The ground probe
 * only reaches 0.06 m, so stepping off a lip reads as a landing for a tick or
 * two; without this a run downstairs would decay one step at a time.
 */
export const LAND_TAX_MIN_AIR_TICKS = 6;
export const STEP_HEIGHT = 0.42;
export const MAX_FALL_SPEED = 60.0;
/** Coyote time + jump buffering, in ticks. */
export const COYOTE_TICKS = 4;

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
