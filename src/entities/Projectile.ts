import type { Box } from '../systems/CollisionSystem.js';

export interface ProjectileConfig {
    /** Hitbox width (across the flight direction). */
    width: number;
    /** Hitbox length (along the flight direction). */
    height: number;
    /** Safety lifetime in seconds; normally projectiles leave the viewport first. */
    maxAge: number;
}

export const DEFAULT_PROJECTILE_CONFIG: Readonly<ProjectileConfig> = {
    width: 4,
    height: 14,
    maxAge: 2,
};

/**
 * A player missile. It flies straight up the world (+Y) at a velocity fixed at launch:
 * the jet's forward speed at that moment plus the muzzle speed.
 */
export class Projectile {
    readonly id: number;
    readonly width: number;
    readonly height: number;
    readonly maxAge: number;
    /** World-space velocity along +Y (units/s). */
    readonly vy: number;
    x: number;
    y: number;
    previousX: number;
    previousY: number;
    age = 0;
    alive = true;

    constructor(id: number, x: number, y: number, vy: number, config: Partial<ProjectileConfig> = {}) {
        const c = { ...DEFAULT_PROJECTILE_CONFIG, ...config };
        this.id = id;
        this.width = c.width;
        this.height = c.height;
        this.maxAge = c.maxAge;
        this.vy = vy;
        this.x = x;
        this.y = y;
        this.previousX = x;
        this.previousY = y;
    }

    /** Advances one fixed step. Records the previous position for sweep tests and interpolation. */
    update(dt: number): void {
        if (!this.alive || !(dt > 0)) return;
        this.previousX = this.x;
        this.previousY = this.y;
        this.y += this.vy * dt;
        this.age += dt;
        if (this.age >= this.maxAge) this.alive = false;
    }

    kill(): void {
        this.alive = false;
    }

    get hitbox(): Box {
        return { x: this.x, y: this.y, width: this.width, height: this.height };
    }
}
