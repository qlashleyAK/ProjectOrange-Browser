export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
export const MAX_TICKS_PER_FRAME = 6;
export const MAX_FRAME_CARRY = 0.25;

export const BUILD_VERSION = '0.2.0';

// Netcode (Section 13.10)
export const SNAPSHOT_EVERY_TICKS = 2; // 30 Hz
export const MISSILE_STREAM_EVERY_SNAPSHOTS = 2; // 15 Hz
export const INPUT_SEND_HZ = 30;
export const MAX_INPUTS_PER_PACKET = 8;
export const INPUT_REDUNDANCY = 2;
export const PREDICTION_HISTORY = 128;
export const INTERP_DELAY_MIN = 0.066;
export const INTERP_DELAY_MAX = 0.2;
export const MAX_EXTRAPOLATION = 0.15;
export const CORRECTION_TAU = 0.1;
export const HARD_SNAP_DIST = 8;
export const HARD_SNAP_ANGLE = 45 * Math.PI / 180;
export const LAG_COMP_MAX_TICKS = 12;
export const POSE_HISTORY_TICKS = 60;
export const INPUT_BUFFER_TARGET_MAX = 4;
export const MISSED_INPUT_REPEAT_LIMIT = 6;
export const MAX_INPUTS_PER_SECOND = 75;
export const RECONNECT_GRACE_S = 20;
export const TIME_DILATION = 0.03;

// Match rules (Section 9, 12)
export const MAX_PARTICIPANTS = 8;
export const BOT_BACKFILL_TARGET = 6;
export const KILLS_TO_WIN = 12;
export const MATCH_DURATION_S = 6 * 60;
export const WARMUP_S = 5;
export const WARMUP_OFFLINE_S = 3;
export const POSTMATCH_S = 12;
export const RESPAWN_DELAY_S = 3;
export const RESPAWN_HOLD_MAX_S = 15;
export const SPAWN_PROTECTION_S = 2;

// Combat (Section 8)
export const PROJECTILE_CAP_PER_SHIP = 160;
export const CONVERGE_DISTANCE = 250;
export const MISSILE_SEEKER_CONE = 60 * Math.PI / 180;

// Power (Section 6)
export const MAX_POWER = 10;
export const PICKUP_RADIUS = 3.0;
export const MAGNET_RADIUS = 10;
export const MAGNET_SPEED = 25;
export const WORLD_ORANGE_CAP = 40;
export const DROP_CAP = 48;
export const DROP_LIFETIME_S = 25;
export const DROP_BLINK_S = 5;
export const DROP_RING_RADIUS = 8;
export const REPEL_RADIUS = 45;
export const REPEL_DV = 45;
export const REPEL_COOLDOWN_S = 12;
export const REPEL_MAX_TARGETS = 24;

// Safe zones: protection drains while inside and recharges outside, so they can't be camped
export const SAFE_ZONE_CHARGE_S = 8;
export const SAFE_ZONE_RECHARGE_PER_S = 0.4;

/** Safe-zone charge after one tick. */
export function stepSafeCharge(charge: number, inZone: boolean): number {
  return inZone ? Math.max(0, charge - DT) : Math.min(SAFE_ZONE_CHARGE_S, charge + SAFE_ZONE_RECHARGE_PER_S * DT);
}

// Perception (Section 11)
export const BOT_SIGHT_RANGE = 600;
export const CLOAK_REVEAL_RANGE = 60;
export const BOT_CLOAK_SIGHT_RANGE = 35;

/** Reserved orange hue — only for oranges and power feedback. */
export const ORANGE_HEX = 0xff6a10;
