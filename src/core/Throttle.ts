/**
 * Throttle <-> forward-speed model shared by the engine (Phase 2 free-scroll mode),
 * the player jet, and the fuel system (burn rate follows the jet's actual speed).
 */

export interface SpeedProfile {
    /** Forward speed at full brake (throttle = -1), world units per second. */
    minSpeed: number;
    /** Forward speed with a neutral throttle. */
    cruiseSpeed: number;
    /** Forward speed at full boost (throttle = +1). */
    maxSpeed: number;
    /** Speed gain limit, units/s^2. */
    acceleration: number;
    /** Speed loss limit, units/s^2. */
    deceleration: number;
}

export type SpeedRange = Pick<SpeedProfile, 'minSpeed' | 'cruiseSpeed' | 'maxSpeed'>;

export const DEFAULT_SPEED_PROFILE: Readonly<SpeedProfile> = {
    minSpeed: 90,
    cruiseSpeed: 220,
    maxSpeed: 420,
    acceleration: 360,
    deceleration: 480,
};

/** Speed requested by a throttle value in [-1, 1] (analog friendly, piecewise linear). */
export function computeTargetSpeed(throttle: number, range: Readonly<SpeedRange>): number {
    const t = Math.max(-1, Math.min(1, Number.isFinite(throttle) ? throttle : 0));
    return t >= 0
        ? range.cruiseSpeed + t * (range.maxSpeed - range.cruiseSpeed)
        : range.cruiseSpeed + t * (range.cruiseSpeed - range.minSpeed);
}

/** Inverse of `computeTargetSpeed`: the throttle level a given speed corresponds to, in [-1, 1]. */
export function speedToThrottle(speed: number, range: Readonly<SpeedRange>): number {
    if (!Number.isFinite(speed)) return 0;
    if (speed >= range.cruiseSpeed) {
        const span = range.maxSpeed - range.cruiseSpeed;
        return span > 0 ? Math.min(1, (speed - range.cruiseSpeed) / span) : 0;
    }
    const span = range.cruiseSpeed - range.minSpeed;
    return span > 0 ? Math.max(-1, (speed - range.cruiseSpeed) / span) : 0;
}

/**
 * Moves `current` toward `target` limited by the profile's acceleration/deceleration.
 * Lands exactly on the target once it is within one step, so limits are reached exactly.
 */
export function approachSpeed(
    current: number,
    target: number,
    dt: number,
    profile: Readonly<Pick<SpeedProfile, 'acceleration' | 'deceleration'>>,
): number {
    const delta = target - current;
    const limit = (delta > 0 ? profile.acceleration : profile.deceleration) * dt;
    return Math.abs(delta) <= limit ? target : current + Math.sign(delta) * limit;
}
