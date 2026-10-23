import { hashToUnit } from '../core/PRNG.js';
import { boxTouchesLand, type Box, type CollisionWorld } from '../systems/CollisionSystem.js';

export interface DepotConfig {
    /** Hitbox width. */
    width: number;
    /** Hitbox height (along the river). */
    height: number;
    /** Distance between depot "slots" along the river. */
    spacing: number;
    /** Each depot is jittered by up to +/- this much from its slot. */
    jitter: number;
    /** Probability that a slot holds a depot. */
    chance: number;
    /** No depots below this world Y (keeps the opening stretch clear). */
    minY: number;
    /** Keep-out distance from any bridge. */
    bridgeClearance: number;
}

export const DEFAULT_DEPOT_CONFIG: Readonly<DepotConfig> = {
    width: 20,
    height: 45,
    spacing: 520,
    jitter: 140,
    chance: 0.85,
    minY: 420,
    bridgeClearance: 120,
};

export interface DepotChannel {
    readonly leftX: number;
    readonly rightX: number;
}

/** The river queries depot placement needs. `RiverGenerator` satisfies it. */
export interface DepotWorld extends CollisionWorld {
    readonly seed: number;
    getChannels(worldY: number): DepotChannel[];
}

export interface DepotPlacement {
    /** Stable identity: the slot index. Destroyed depots are remembered by id. */
    readonly id: number;
    readonly x: number;
    readonly y: number;
}

/** A refuelling barge: fly over it to refuel, shoot it to destroy it. */
export class FuelDepot {
    readonly id: number;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    destroyed = false;

    constructor(placement: DepotPlacement, config: Partial<DepotConfig> = {}) {
        const c = { ...DEFAULT_DEPOT_CONFIG, ...config };
        this.id = placement.id;
        this.x = placement.x;
        this.y = placement.y;
        this.width = c.width;
        this.height = c.height;
    }

    get hitbox(): Box {
        return { x: this.x, y: this.y, width: this.width, height: this.height };
    }
}

const SALT_DEPOT = 0xf0e1d000;
const MAX_CACHED_PLACEMENTS = 1024;

/**
 * Deterministic depot layout. Like the river itself, each slot's outcome is a pure
 * function of (seed, slot index): depots can be created, culled and re-created in any
 * order and always come out identical.
 *
 * Placement rules: a slot may hold nothing; the depot sits inside one of the river's
 * navigable channels (never on an island or bank, verified against the full hitbox),
 * keeps clear of bridges, and avoids the opening stretch.
 */
export class DepotSpawner {
    readonly config: Readonly<DepotConfig>;
    private readonly world: DepotWorld;
    private readonly cache = new Map<number, DepotPlacement | null>();

    constructor(world: DepotWorld, config: Partial<DepotConfig> = {}) {
        this.world = world;
        this.config = { ...DEFAULT_DEPOT_CONFIG, ...config };
        const c = this.config;
        for (const [name, value] of Object.entries(c)) {
            if (!Number.isFinite(value)) throw new RangeError(`Invalid DepotConfig: ${name} must be finite.`);
        }
        if (c.width <= 0 || c.height <= 0 || c.spacing <= 0) {
            throw new RangeError('Invalid DepotConfig: width, height and spacing must be positive.');
        }
        if (c.jitter < 0 || c.jitter * 2 >= c.spacing) {
            throw new RangeError('Invalid DepotConfig: jitter must be in [0, spacing / 2).');
        }
        if (c.chance < 0 || c.chance > 1) throw new RangeError('Invalid DepotConfig: chance must be in [0, 1].');
    }

    /** Inclusive range of slot indices that can place a depot within [minY, maxY]. */
    slotRange(minY: number, maxY: number): readonly [first: number, last: number] {
        const { spacing, jitter } = this.config;
        return [Math.max(0, Math.ceil((minY - jitter) / spacing)), Math.floor((maxY + jitter) / spacing)];
    }

    /** Where slot `slot` puts a depot, or null if it stays empty. Memoised. */
    place(slot: number): DepotPlacement | null {
        const cached = this.cache.get(slot);
        if (cached !== undefined) return cached;
        const placement = this.compute(slot);
        if (this.cache.size >= MAX_CACHED_PLACEMENTS) this.cache.clear();
        this.cache.set(slot, placement);
        return placement;
    }

    create(slot: number): FuelDepot | null {
        const placement = this.place(slot);
        return placement ? new FuelDepot(placement, this.config) : null;
    }

    private compute(slot: number): DepotPlacement | null {
        const c = this.config;
        const world = this.world;
        const roll = (k: number): number => hashToUnit(world.seed, SALT_DEPOT + k, slot);
        if (slot < 0 || roll(0) >= c.chance) return null;
        const y = slot * c.spacing + (roll(1) * 2 - 1) * c.jitter;
        if (y < c.minY) return null;
        if (world.findBridges(y - c.bridgeClearance, y + c.bridgeClearance).length > 0) return null;

        const channels = world.getChannels(y);
        let total = 0;
        for (const channel of channels) total += channel.rightX - channel.leftX;
        if (!(total > 0)) return null;

        // Weighted channel pick, then a position in its middle 40%.
        let pick = roll(2) * total;
        let chosen = channels[channels.length - 1];
        for (const channel of channels) {
            pick -= channel.rightX - channel.leftX;
            if (pick < 0) {
                chosen = channel;
                break;
            }
        }
        if (!chosen) return null;
        const x = chosen.leftX + (chosen.rightX - chosen.leftX) * (0.3 + 0.4 * roll(3));
        const candidate: Box = { x, y, width: c.width, height: c.height };
        if (!boxTouchesLand(world, candidate)) return { id: slot, x, y };

        // Fallback: the middle of the widest channel (banks can bulge within 45 units).
        let widest = channels[0];
        for (const channel of channels) {
            if (!widest || channel.rightX - channel.leftX > widest.rightX - widest.leftX) widest = channel;
        }
        if (!widest) return null;
        const centred: Box = { ...candidate, x: (widest.leftX + widest.rightX) / 2 };
        return boxTouchesLand(world, centred) ? null : { id: slot, x: centred.x, y };
    }
}
