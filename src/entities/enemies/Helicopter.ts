import { Enemy, type EnemyContext, type Heading } from './Enemy.js';

export const HELICOPTER_WIDTH = 24;
export const HELICOPTER_HEIGHT = 18;
export const HELICOPTER_POINTS = 60;
export const HELICOPTER_MIN_SPEED = 80;
export const HELICOPTER_MAX_SPEED = 140;
/** Endless mode speeds helicopters up to 1.75x; nothing may be faster than this. */
export const HELICOPTER_SPEED_LIMIT = 245;
/** Lateral acceleration used to speed up and brake at the ends of a patrol (units/s^2). */
export const HELICOPTER_ACCELERATION = 240;
/** Main rotor spin in radians per second (a blur at 60 Hz, which is the point). */
export const HELICOPTER_ROTOR_RATE = 31;

export interface HelicopterOptions {
    /** Cruise speed along the river's width: [80, 140] units/s, up to 245 in endless mode. */
    speed: number;
    /** Initial patrol direction. */
    direction: Heading;
}

/**
 * Transverse patrol helicopter: sweeps back and forth across its channel between the
 * banks (or the bank and an island), braking smoothly and reversing at each end. It holds
 * its place along the river; the player scrolls toward it.
 */
export class Helicopter extends Enemy {
    readonly kind = 'helicopter';
    readonly flies = false;
    readonly speed: number;
    /** Turn-around acceleration; a sped-up helicopter brakes proportionally harder so it still reverses at the banks. */
    readonly acceleration: number;

    constructor(id: number, x: number, y: number, options: HelicopterOptions) {
        super(id, x, y, HELICOPTER_WIDTH, HELICOPTER_HEIGHT, HELICOPTER_POINTS);
        if (!Number.isFinite(options.speed) || options.speed < HELICOPTER_MIN_SPEED || options.speed > HELICOPTER_SPEED_LIMIT) {
            throw new RangeError(`Helicopter speed must be within [${HELICOPTER_MIN_SPEED}, ${HELICOPTER_SPEED_LIMIT}].`);
        }
        this.speed = options.speed;
        this.acceleration = HELICOPTER_ACCELERATION * Math.max(1, options.speed / HELICOPTER_MAX_SPEED);
        this.heading = options.direction === -1 ? -1 : 1;
    }

    /** Main rotor angle in radians at `time` seconds; every helicopter has its own phase. */
    rotorAngle(time: number): number {
        return (time * HELICOPTER_ROTOR_RATE + this.id * 1.713) % (Math.PI * 2);
    }

    /** Lean into the direction of travel, in radians (max about 0.2). */
    get lean(): number {
        return (this.vx / HELICOPTER_MAX_SPEED) * 0.2;
    }

    protected step(dt: number, context: EnemyContext): void {
        this.patrol(dt, context, this.speed, this.acceleration);
    }
}
