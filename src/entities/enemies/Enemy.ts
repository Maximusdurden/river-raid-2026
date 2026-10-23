import type { Box } from '../../systems/CollisionSystem.js';

export type EnemyKind = 'helicopter' | 'patrol-boat' | 'fighter';

/** A navigable stretch of water at one Y. `RiverGenerator.getChannels` returns these. */
export interface ChannelSpan {
    readonly leftX: number;
    readonly rightX: number;
}

/** The slice of the river that enemies need. `RiverGenerator` satisfies it. */
export interface EnemyWorld {
    readonly config: { readonly worldWidth: number; readonly sliceHeight: number };
    getChannels(worldY: number): ChannelSpan[];
    sample(worldY: number): { readonly leftBankX: number; readonly rightBankX: number };
}

/** What an enemy may look at during one fixed step. */
export interface EnemyContext {
    readonly world: EnemyWorld;
    readonly playerX: number;
    readonly playerY: number;
    /** False while the player's jet is exploding or dead. */
    readonly playerFlying: boolean;
    readonly time: number;
}

/** Range of centre-X positions an enemy can occupy without touching a bank or island. */
export interface PatrolBounds {
    readonly min: number;
    readonly max: number;
}

export type Heading = 1 | -1;

/** Gap kept between an enemy's hull and a bank or island, in world units. */
export const PATROL_MARGIN = 2;

function nearestChannel(channels: readonly ChannelSpan[], x: number): ChannelSpan | null {
    let best: ChannelSpan | null = null;
    let bestGap = Infinity;
    for (const channel of channels) {
        const gap = Math.max(channel.leftX - x, x - channel.rightX, 0);
        if (gap < bestGap) {
            bestGap = gap;
            best = channel;
        }
    }
    return best;
}

/**
 * Where an enemy of the given half-size, currently at (x, y), may stand without its
 * hull touching a bank or island.
 *
 * The channel that holds `x` (or the nearest one) is evaluated on the box's bottom and
 * top edges and at every river-slice boundary in between. Banks and islands are
 * piecewise linear between slice boundaries, so the tightest limit is always on one of
 * those rows, which makes this exact. Returns null if the channel is too narrow for the
 * hull plus margin.
 */
export function patrolBounds(
    world: EnemyWorld,
    x: number,
    y: number,
    halfWidth: number,
    halfHeight: number,
    margin: number = PATROL_MARGIN,
): PatrolBounds | null {
    const bottom = y - halfHeight;
    const top = y + halfHeight;
    const step = world.config.sliceHeight;
    let left = -Infinity;
    let right = Infinity;
    const probe = (rowY: number): boolean => {
        const channel = nearestChannel(world.getChannels(rowY), x);
        if (!channel) return false;
        left = Math.max(left, channel.leftX);
        right = Math.min(right, channel.rightX);
        return true;
    };
    if (!probe(bottom) || !probe(top)) return null;
    if (step > 0) {
        for (let rowY = (Math.floor(bottom / step) + 1) * step; rowY < top; rowY += step) {
            if (!probe(rowY)) return null;
        }
    }
    const min = left + halfWidth + margin;
    const max = right - halfWidth - margin;
    return min <= max ? { min, max } : null;
}

/**
 * Common base for everything that attacks or obstructs the player.
 *
 * Lifecycle: `alive` until it is shot or rammed (`destroy`, `destroyed = true`, which
 * scores) or leaves play without being killed (`despawn`, `despawned = true`, which does
 * not). The session removes enemies that are no longer alive.
 *
 * Enemies live in world space and advance in the engine's fixed step. `previousX/Y` are
 * recorded each step so the renderer can interpolate.
 */
export abstract class Enemy {
    abstract readonly kind: EnemyKind;
    /** True for enemies that fly over banks and islands (fighters). */
    abstract readonly flies: boolean;

    readonly id: number;
    readonly width: number;
    readonly height: number;
    /** Points for shooting it down. */
    readonly points: number;

    x: number;
    y: number;
    previousX: number;
    previousY: number;
    /** Velocity in world units per second (+Y is upstream). */
    vx = 0;
    vy = 0;
    /** Facing / patrol direction along X. */
    heading: Heading = 1;
    /** Seconds since it was created. */
    age = 0;
    alive = true;
    destroyed = false;
    despawned = false;

    /** Time left before a patrol may flip again; stops chatter in tight channels. */
    protected flipCooldown = 0;

    /** One step of behaviour. Called by `update` after bookkeeping; never for a dead enemy. */
    protected abstract step(dt: number, context: EnemyContext): void;

    protected constructor(id: number, x: number, y: number, width: number, height: number, points: number) {
        this.id = id;
        this.x = x;
        this.y = y;
        this.previousX = x;
        this.previousY = y;
        this.width = width;
        this.height = height;
        this.points = points;
    }

    get hitbox(): Box {
        return { x: this.x, y: this.y, width: this.width, height: this.height };
    }

    /** Box covering where the enemy was last step and where it is now (for tunnelling-proof sweeps). */
    get sweptHitbox(): Box {
        const minX = Math.min(this.previousX, this.x) - this.width / 2;
        const maxX = Math.max(this.previousX, this.x) + this.width / 2;
        const minY = Math.min(this.previousY, this.y) - this.height / 2;
        const maxY = Math.max(this.previousY, this.y) + this.height / 2;
        return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, width: maxX - minX, height: maxY - minY };
    }

    /** Advances one fixed step. No effect once the enemy is gone or for non-positive steps. */
    update(dt: number, context: EnemyContext): void {
        if (!this.alive || !(dt > 0) || !Number.isFinite(dt)) return;
        this.previousX = this.x;
        this.previousY = this.y;
        this.age += dt;
        this.flipCooldown = Math.max(0, this.flipCooldown - dt);
        this.step(dt, context);
    }

    /** Killed by the player (missile or collision). */
    destroy(): void {
        if (!this.alive) return;
        this.alive = false;
        this.destroyed = true;
        this.vx = 0;
        this.vy = 0;
    }

    /** Leaves play without scoring (exited the river, nothing left to do). */
    despawn(): void {
        if (!this.alive) return;
        this.alive = false;
        this.despawned = true;
    }

    /** True once the enemy has finished its business and should leave play. Fliers override. */
    hasLeftPlay(_world: EnemyWorld): boolean {
        return false;
    }

    /** Turns around. The patrol then decelerates and accelerates the other way smoothly. */
    reverse(): void {
        this.heading = this.heading === 1 ? -1 : 1;
        this.flipCooldown = 0.25;
    }

    /** Puts the centre inside [min, max], bounces the heading off the bound that was hit. */
    clampX(bounds: PatrolBounds): boolean {
        if (this.x < bounds.min) {
            this.x = bounds.min;
            if (this.vx < 0) this.vx = 0;
            this.heading = 1;
            return true;
        }
        if (this.x > bounds.max) {
            this.x = bounds.max;
            if (this.vx > 0) this.vx = 0;
            this.heading = -1;
            return true;
        }
        return false;
    }

    /** Current patrol bounds for this hull, or null if the water here is too narrow. */
    boundsIn(world: EnemyWorld): PatrolBounds | null {
        return patrolBounds(world, this.x, this.y, this.width / 2, this.height / 2);
    }

    /**
     * Side-to-side patrol inside the current channel: accelerate toward `cruiseSpeed` along
     * `heading`, and turn around early enough to brake to a stop before the bank or island
     * (stopping distance = v^2 / 2a), so reversals are smooth. Returns false if the channel
     * is too narrow and the enemy was despawned.
     */
    protected patrol(dt: number, context: EnemyContext, cruiseSpeed: number, acceleration: number): boolean {
        const bounds = this.boundsIn(context.world);
        if (!bounds) {
            this.despawn();
            return false;
        }
        const span = bounds.max - bounds.min;
        // Never cruise faster than we can stop within half the channel.
        const limit = Math.min(cruiseSpeed, Math.sqrt(2 * acceleration * Math.max(0, span / 2 - 1)));
        const brake = (this.vx * this.vx) / (2 * acceleration) + 1.5;
        if (this.flipCooldown <= 0) {
            if (this.heading > 0 && this.x + brake >= bounds.max) this.reverse();
            else if (this.heading < 0 && this.x - brake <= bounds.min) this.reverse();
        }
        const target = this.heading * limit;
        const maxDelta = acceleration * dt;
        this.vx += Math.max(-maxDelta, Math.min(maxDelta, target - this.vx));
        this.x += this.vx * dt;
        // The braking above makes this a no-op for a static channel; it catches moving boats
        // whose channel shifts under them.
        this.clampX(bounds);
        return true;
    }
}
