import { Enemy, type EnemyContext, type EnemyWorld, type Heading } from './Enemy.js';

export const FIGHTER_WIDTH = 20;
export const FIGHTER_HEIGHT = 22;
export const FIGHTER_POINTS = 100;
export const FIGHTER_MIN_SPEED = 320;
export const FIGHTER_MAX_SPEED = 460;
export const FIGHTER_TRIGGER_DISTANCE = 600;
/** Afterburner kick-in: units/s^2 (reaches full speed in about a quarter of a second). */
export const FIGHTER_ACCELERATION = 1500;
/** How far past the opposite bank (plus half its width) it must be to count as having left the river. */
const EXIT_MARGIN = 8;
/** Hard limit beyond the world's edge at which a fighter is always discarded. */
const WORLD_MARGIN = 80;

export type FighterState = 'parked' | 'streaking';

export interface FighterOptions {
    /** Streak speed in [320, 460] units/s. */
    speed: number;
    /** +1 streaks left to right, -1 right to left. */
    direction: Heading;
    /** Launches when the player is this far below it along the river (default 600). */
    triggerDistance?: number;
}

/**
 * High-speed interceptor. It waits on a bank (or just off-screen) until the player gets
 * within `triggerDistance`, then streaks across the river at a constant world Y. It flies,
 * so banks and islands do not stop it; it is discarded once it has crossed the river and
 * left through the far bank.
 */
export class FighterJet extends Enemy {
    readonly kind = 'fighter';
    readonly flies = true;
    readonly speed: number;
    readonly direction: Heading;
    readonly triggerDistance: number;
    readonly acceleration = FIGHTER_ACCELERATION;

    state: FighterState = 'parked';
    /** True once its centre has been over the river (between the banks). */
    enteredRiver = false;
    /** True for exactly the step in which it launched (for sound effects). */
    launchedThisStep = false;

    constructor(id: number, x: number, y: number, options: FighterOptions) {
        super(id, x, y, FIGHTER_WIDTH, FIGHTER_HEIGHT, FIGHTER_POINTS);
        if (!Number.isFinite(options.speed) || options.speed < FIGHTER_MIN_SPEED || options.speed > FIGHTER_MAX_SPEED) {
            throw new RangeError(`FighterJet speed must be within [${FIGHTER_MIN_SPEED}, ${FIGHTER_MAX_SPEED}].`);
        }
        const trigger = options.triggerDistance ?? FIGHTER_TRIGGER_DISTANCE;
        if (!Number.isFinite(trigger) || trigger <= 0) throw new RangeError('FighterJet triggerDistance must be positive.');
        this.speed = options.speed;
        this.direction = options.direction === -1 ? -1 : 1;
        this.heading = this.direction;
        this.triggerDistance = trigger;
    }

    get isStreaking(): boolean {
        return this.state === 'streaking';
    }

    /**
     * A streaking fighter has left play once it has crossed the river and cleared the far
     * bank, or has strayed beyond the edge of the world. Parked fighters never have.
     */
    override hasLeftPlay(world: EnemyWorld): boolean {
        if (this.state !== 'streaking') return false;
        if (this.x < -WORLD_MARGIN || this.x > world.config.worldWidth + WORLD_MARGIN) return true;
        if (!this.enteredRiver) return false;
        const river = world.sample(this.y);
        return this.direction > 0
            ? this.x > river.rightBankX + this.width / 2 + EXIT_MARGIN
            : this.x < river.leftBankX - this.width / 2 - EXIT_MARGIN;
    }

    protected step(dt: number, context: EnemyContext): void {
        this.launchedThisStep = false;
        if (this.state === 'parked') {
            if (context.playerY < this.y - this.triggerDistance) return;
            this.state = 'streaking';
            this.launchedThisStep = true;
        }

        const target = this.direction * this.speed;
        const maxDelta = this.acceleration * dt;
        this.vx += Math.max(-maxDelta, Math.min(maxDelta, target - this.vx));
        this.x += this.vx * dt;

        const river = context.world.sample(this.y);
        if (this.x >= river.leftBankX && this.x <= river.rightBankX) this.enteredRiver = true;
        if (this.hasLeftPlay(context.world)) this.despawn();
    }
}
