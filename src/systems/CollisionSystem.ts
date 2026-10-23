import type { FuelDepot } from '../entities/FuelDepot.js';
import type { Enemy, EnemyWorld } from '../entities/enemies/Enemy.js';
import type { BridgeSpan } from '../world/RiverGenerator.js';

/**
 * Collision queries. Everything here is a pure function of its inputs plus the
 * (deterministic) river, so it is trivially unit-testable and has no hidden state.
 * World Y increases upstream; boxes are described by centre and full extents.
 */

/** Axis-aligned box described by its centre and full width/height. */
export interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** The part of the river API needed to test for land. `RiverGenerator` satisfies it. */
export interface LandQuery {
    isLand(worldX: number, worldY: number): boolean;
    readonly config: { readonly sliceHeight: number };
}

export interface CollisionWorld extends LandQuery {
    findBridges(minY: number, maxY: number): BridgeSpan[];
}

/** Which bridges are still standing. */
export interface BridgeStatus {
    isIntact(bridgeNumber: number): boolean;
}

/** The slice of a projectile the sweep test reads. `Projectile` satisfies it. */
export interface SweptProjectile {
    readonly x: number;
    readonly y: number;
    readonly previousY: number;
    readonly width: number;
    readonly height: number;
}

export type JetCollision =
    | { readonly cause: 'bridge'; readonly bridge: BridgeSpan }
    | { readonly cause: 'land' };

export type ProjectileHit =
    | { readonly kind: 'depot'; readonly x: number; readonly y: number; readonly depot: FuelDepot }
    | { readonly kind: 'enemy'; readonly x: number; readonly y: number; readonly enemy: Enemy }
    | { readonly kind: 'bridge'; readonly x: number; readonly y: number; readonly bridge: BridgeSpan }
    | { readonly kind: 'land'; readonly x: number; readonly y: number };

/** What happened to an enemy when it was checked against the terrain. */
export type EnemyTerrainOutcome = 'ok' | 'reversed' | 'despawned';

/** The river queries needed to keep enemies in the water. `RiverGenerator` satisfies it. */
export type EnemyTerrainWorld = LandQuery & EnemyWorld;

/** Horizontal spacing of land probes across a box. */
export const LAND_SAMPLE_COLUMN_PITCH = 7;
/** Spacing of land probes along a projectile's path. */
export const PROJECTILE_LAND_STEP = 6;

export function boxLeft(box: Box): number {
    return box.x - box.width / 2;
}
export function boxRight(box: Box): number {
    return box.x + box.width / 2;
}
export function boxBottom(box: Box): number {
    return box.y - box.height / 2;
}
export function boxTop(box: Box): number {
    return box.y + box.height / 2;
}

/** Strict overlap: boxes that merely touch along an edge do not collide. Symmetric. */
export function boxesOverlap(a: Box, b: Box): boolean {
    return Math.abs(a.x - b.x) < (a.width + b.width) / 2 && Math.abs(a.y - b.y) < (a.height + b.height) / 2;
}

/**
 * True if any part of `box` is over land (bank, island, or outside the world).
 *
 * Land is probed with `isLand` on a grid: every `LAND_SAMPLE_COLUMN_PITCH` units across
 * the width, on the box's bottom and top edges, and on every river-slice boundary in
 * between. Bank edges are piecewise linear between slice boundaries, so the extreme
 * bank position within the box is always one of those rows, which makes the bank test
 * exact. Island interiors are sampled, so a box can graze the very tip of a tapering
 * island (a deliberate, forgiving tolerance).
 */
export function boxTouchesLand(world: LandQuery, box: Box): boolean {
    const left = boxLeft(box);
    const right = boxRight(box);
    const bottom = boxBottom(box);
    const top = boxTop(box);
    const columns = Math.max(1, Math.ceil(box.width / LAND_SAMPLE_COLUMN_PITCH));
    const rowTouchesLand = (y: number): boolean => {
        for (let c = 0; c <= columns; c++) {
            if (world.isLand(left + ((right - left) * c) / columns, y)) return true;
        }
        return false;
    };
    if (rowTouchesLand(bottom) || rowTouchesLand(top)) return true;
    const step = world.config.sliceHeight;
    if (!(step > 0)) return false;
    for (let y = (Math.floor(bottom / step) + 1) * step; y < top; y += step) {
        if (rowTouchesLand(y)) return true;
    }
    return false;
}

/** True if the box overlaps the bridge's deck. Decks span the full width of the world. */
export function boxOverlapsBridge(box: Box, bridge: BridgeSpan): boolean {
    return boxTop(box) > bridge.bottomY && boxBottom(box) < bridge.topY;
}

export class CollisionSystem {
    private world: CollisionWorld;
    private readonly bridges: BridgeStatus;

    constructor(world: CollisionWorld, bridges: BridgeStatus) {
        this.world = world;
        this.bridges = bridges;
    }

    setWorld(world: CollisionWorld): void {
        this.world = world;
    }

    /** The first still-intact bridge whose deck overlaps `box`, if any. */
    intactBridgeOverlapping(box: Box): BridgeSpan | null {
        for (const span of this.world.findBridges(boxBottom(box), boxTop(box))) {
            if (this.bridges.isIntact(span.number) && boxOverlapsBridge(box, span)) return span;
        }
        return null;
    }

    /** Jet vs terrain. Bridges take priority over land because the deck is above the banks. */
    checkJet(box: Box): JetCollision | null {
        const bridge = this.intactBridgeOverlapping(box);
        if (bridge) return { cause: 'bridge', bridge };
        return boxTouchesLand(this.world, box) ? { cause: 'land' } : null;
    }

    /** First intact depot overlapped by `box`. Overlap never damages the jet. */
    findDepotOverlap(box: Box, depots: Iterable<FuelDepot>): FuelDepot | null {
        for (const depot of depots) {
            if (!depot.destroyed && boxesOverlap(box, depot.hitbox)) return depot;
        }
        return null;
    }

    /** First living enemy whose hull overlaps `box` (the jet ramming something). */
    findEnemyOverlap(box: Box, enemies: Iterable<Enemy>): Enemy | null {
        for (const enemy of enemies) {
            if (enemy.alive && boxesOverlap(box, enemy.hitbox)) return enemy;
        }
        return null;
    }

    /**
     * Enemy vs riverbank / island.
     *
     *  - Swimmers and hoverers (helicopters, boats): if the hull touches land it is pushed
     *    back inside its channel and turned around (`reversed`); if there is no room at all
     *    it is removed (`despawned`).
     *  - Fliers (fighters) cross banks freely, but are removed once they have crossed the
     *    river and left it (`despawned`).
     *
     * Enemies steer clear of land on their own, so in play this is a safety net that also
     * handles channels shifting under a drifting boat.
     */
    resolveEnemyTerrain(enemy: Enemy, world: EnemyTerrainWorld): EnemyTerrainOutcome {
        if (!enemy.alive) return 'ok';
        if (enemy.flies) {
            if (enemy.hasLeftPlay(world)) {
                enemy.despawn();
                return 'despawned';
            }
            return 'ok';
        }
        if (!boxTouchesLand(world, enemy.hitbox)) return 'ok';
        const bounds = enemy.boundsIn(world);
        if (!bounds) {
            enemy.despawn();
            return 'despawned';
        }
        // clampX also turns the heading away from the bound it hit; turn around ourselves otherwise.
        if (!enemy.clampX(bounds)) enemy.reverse();
        if (boxTouchesLand(world, enemy.hitbox)) {
            enemy.despawn();
            return 'despawned';
        }
        return 'reversed';
    }

    /**
     * Swept projectile test over this tick's travel (previousY -> y), so fast missiles
     * cannot tunnel through thin targets. The projectile is a vertical segment of
     * `height` centred on y; the earliest thing its nose reaches wins:
     *
     *  - an intact bridge deck (full world width),
     *  - an intact depot (width-checked against the projectile's x),
     *  - a living enemy (tested against the box it swept this tick, so a fast fighter
     *    cannot slip sideways past a missile),
     *  - land at the projectile's x (probed every `PROJECTILE_LAND_STEP` units).
     *
     * `x`/`y` of the result are where the nose met the target.
     */
    sweepProjectile(
        projectile: SweptProjectile,
        depots: Iterable<FuelDepot>,
        enemies: Iterable<Enemy> = [],
    ): ProjectileHit | null {
        const half = projectile.height / 2;
        const y0 = Math.min(projectile.previousY, projectile.y);
        const y1 = Math.max(projectile.previousY, projectile.y);
        const x = projectile.x;
        let best: ProjectileHit | null = null;
        let bestCentreY = Infinity;

        for (const bridge of this.world.findBridges(y0 - half, y1 + half)) {
            if (!this.bridges.isIntact(bridge.number)) continue;
            if (!(y1 + half > bridge.bottomY && y0 - half < bridge.topY)) continue;
            const centreY = Math.max(y0, bridge.bottomY - half);
            if (centreY < bestCentreY) {
                bestCentreY = centreY;
                best = { kind: 'bridge', x, y: centreY + half, bridge };
            }
        }

        for (const depot of depots) {
            if (depot.destroyed) continue;
            if (Math.abs(x - depot.x) >= (projectile.width + depot.width) / 2) continue;
            const bottom = depot.y - depot.height / 2;
            const top = depot.y + depot.height / 2;
            if (!(y1 + half > bottom && y0 - half < top)) continue;
            const centreY = Math.max(y0, bottom - half);
            if (centreY < bestCentreY) {
                bestCentreY = centreY;
                best = { kind: 'depot', x, y: centreY + half, depot };
            }
        }

        for (const enemy of enemies) {
            if (!enemy.alive) continue;
            const box = enemy.sweptHitbox;
            if (Math.abs(x - box.x) >= (projectile.width + box.width) / 2) continue;
            const bottom = box.y - box.height / 2;
            const top = box.y + box.height / 2;
            if (!(y1 + half > bottom && y0 - half < top)) continue;
            const centreY = Math.max(y0, bottom - half);
            if (centreY < bestCentreY) {
                bestCentreY = centreY;
                best = { kind: 'enemy', x, y: centreY + half, enemy };
            }
        }

        const span = y1 - y0;
        const steps = Math.max(1, Math.ceil(span / PROJECTILE_LAND_STEP));
        for (let i = 0; i <= steps; i++) {
            const centreY = y0 + (span * i) / steps;
            if (centreY >= bestCentreY) break;
            if (this.world.isLand(x, centreY + half)) {
                best = { kind: 'land', x, y: centreY + half };
                break;
            }
        }
        return best;
    }
}
