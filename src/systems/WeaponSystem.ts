import { Projectile, type ProjectileConfig } from '../entities/Projectile.js';

export interface WeaponConfig {
    /** Arcade discipline: at most this many of the player's missiles may be in flight. */
    maxActiveProjectiles: number;
    /** Auto-repeat interval while fire is held (0.25 s = 4 shots/s). */
    fireInterval: number;
    /** Muzzle speed added to the jet's forward speed (units/s). */
    projectileSpeed: number;
    /** Hold fire to keep shooting. */
    autoRepeat: boolean;
    projectile: Partial<ProjectileConfig>;
}

export const DEFAULT_WEAPON_CONFIG: Readonly<WeaponConfig> = {
    maxActiveProjectiles: 2,
    fireInterval: 0.25,
    projectileSpeed: 650,
    autoRepeat: true,
    projectile: {},
};

export interface WeaponInput {
    /** Rising edge this tick: always tries to fire immediately. */
    firePressed: boolean;
    /** Held this tick: auto-repeats every `fireInterval`. */
    fire: boolean;
    /** False while the jet cannot shoot (exploding, dead). */
    canFire: boolean;
    /** Muzzle position: the jet's nose. The missile's tail starts here. */
    originX: number;
    originY: number;
    /** Jet forward speed; the missile inherits it. */
    forwardSpeed: number;
    /** Camera bottom edge and view height, to retire missiles that leave the top of the view. */
    cameraY: number;
    viewHeight: number;
}

const EPSILON = 1e-9;

/**
 * Player missiles.
 *
 * - Firing: a fresh press fires immediately (if a slot is free); holding fire repeats
 *   every `fireInterval`. Both are capped by `maxActiveProjectiles`, so mashing the
 *   button can never exceed the cap. A press while capped is simply lost.
 * - Ballistics: launch velocity is `jet forward speed + projectileSpeed`, fixed at
 *   launch, straight along the jet's centreline.
 * - Range: missiles are retired once fully beyond the top of the viewport (or when
 *   killed by a collision, which the game does through `Projectile.kill()`).
 *
 * Killed missiles are compacted away at the start of the next `update`, so the list
 * may contain dead entries between ticks: check `alive` or use `activeCount`.
 */
export class WeaponSystem {
    readonly config: Readonly<WeaponConfig>;
    private list: Projectile[] = [];
    private cooldown = 0;
    private nextId = 1;

    constructor(config: Partial<WeaponConfig> = {}) {
        this.config = { ...DEFAULT_WEAPON_CONFIG, ...config };
        const c = this.config;
        if (!Number.isInteger(c.maxActiveProjectiles) || c.maxActiveProjectiles < 1) {
            throw new RangeError('Invalid WeaponConfig: maxActiveProjectiles must be an integer >= 1.');
        }
        if (!(c.fireInterval > 0) || !Number.isFinite(c.fireInterval)) {
            throw new RangeError('Invalid WeaponConfig: fireInterval must be positive and finite.');
        }
        if (!(c.projectileSpeed > 0) || !Number.isFinite(c.projectileSpeed)) {
            throw new RangeError('Invalid WeaponConfig: projectileSpeed must be positive and finite.');
        }
    }

    get projectiles(): readonly Projectile[] {
        return this.list;
    }

    get activeCount(): number {
        let n = 0;
        for (const p of this.list) if (p.alive) n++;
        return n;
    }

    /** Seconds until auto-repeat may fire again. */
    get cooldownRemaining(): number {
        return this.cooldown;
    }

    /** Advances missiles, retires out-of-range ones, and fires if requested. Returns the new missile, if any. */
    update(dt: number, input: WeaponInput): Projectile | null {
        if (!(dt > 0) || !Number.isFinite(dt)) return null;
        this.list = this.list.filter(p => p.alive);
        this.cooldown = Math.max(0, this.cooldown - dt);

        const top = input.cameraY + input.viewHeight;
        for (const p of this.list) {
            p.update(dt);
            if (p.y - p.height / 2 > top) p.kill();
        }

        if (!input.canFire) return null;
        const c = this.config;
        const repeat = c.autoRepeat && input.fire && this.cooldown <= EPSILON;
        if (!(input.firePressed || repeat)) return null;
        if (this.activeCount >= c.maxActiveProjectiles) return null;

        const missile = new Projectile(
            this.nextId++,
            input.originX,
            input.originY + (c.projectile.height ?? 14) / 2,
            input.forwardSpeed + c.projectileSpeed,
            c.projectile,
        );
        this.list.push(missile);
        this.cooldown = c.fireInterval;
        return missile;
    }

    /** Removes all missiles (respawn, restart). */
    clear(): void {
        this.list = [];
        this.cooldown = 0;
    }

    reset(): void {
        this.clear();
        this.nextId = 1;
    }
}
