import { Enemy, type EnemyContext, type Heading } from './Enemy.js';

export const PATROL_BOAT_WIDTH = 36;
export const PATROL_BOAT_HEIGHT = 14;
export const PATROL_BOAT_POINTS = 30;
export const PATROL_BOAT_MIN_SPEED = 30;
export const PATROL_BOAT_MAX_SPEED = 60;
/** Downriver drift speed of an unpowered boat, in world units per second (-Y is downriver). */
export const PATROL_BOAT_DRIFT_SPEED = 20;
export const PATROL_BOAT_ACCELERATION = 45;

/**
 * - `cruiser`: slowly patrols side to side at 30-60 units/s.
 * - `drifter`: no lateral motion; floats downriver at 20 units/s with the current.
 */
export type PatrolBoatMode = 'cruiser' | 'drifter';

export interface PatrolBoatOptions {
    mode: PatrolBoatMode;
    /** Cruise speed for cruisers, in [30, 60] units/s. Ignored by drifters. */
    speed: number;
    /** Initial direction (cruisers) / which way the bow points (drifters). */
    direction: Heading;
}

/**
 * Slow channel cruiser. Always a dense hazard rather than a threat: it is slow, big and
 * worth only 30 points. Drifters slide downriver, so they close on the player slightly
 * faster than the scroll alone.
 */
export class PatrolBoat extends Enemy {
    readonly kind = 'patrol-boat';
    readonly flies = false;
    readonly mode: PatrolBoatMode;
    readonly speed: number;
    readonly acceleration = PATROL_BOAT_ACCELERATION;

    constructor(id: number, x: number, y: number, options: PatrolBoatOptions) {
        super(id, x, y, PATROL_BOAT_WIDTH, PATROL_BOAT_HEIGHT, PATROL_BOAT_POINTS);
        this.mode = options.mode;
        if (options.mode === 'cruiser') {
            if (!Number.isFinite(options.speed) || options.speed < PATROL_BOAT_MIN_SPEED || options.speed > PATROL_BOAT_MAX_SPEED) {
                throw new RangeError(`PatrolBoat speed must be within [${PATROL_BOAT_MIN_SPEED}, ${PATROL_BOAT_MAX_SPEED}].`);
            }
        }
        this.speed = options.speed;
        this.heading = options.direction === -1 ? -1 : 1;
        if (options.mode === 'drifter') this.vy = -PATROL_BOAT_DRIFT_SPEED;
    }

    get isDrifting(): boolean {
        return this.mode === 'drifter';
    }

    protected step(dt: number, context: EnemyContext): void {
        if (this.mode === 'cruiser') {
            this.patrol(dt, context, this.speed, this.acceleration);
            return;
        }
        // Drifting: the channel moves under the hull as it slides downriver, so re-clamp.
        this.y += this.vy * dt;
        const bounds = this.boundsIn(context.world);
        if (!bounds) {
            this.despawn();
            return;
        }
        this.clampX(bounds);
    }
}
