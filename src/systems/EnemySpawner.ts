import { Mulberry32, combineSeed } from '../core/PRNG.js';
import type { DepotWorld, DepotPlacement } from '../entities/FuelDepot.js';
import { Enemy, patrolBounds, type EnemyKind, type Heading } from '../entities/enemies/Enemy.js';
import { FighterJet, FIGHTER_HEIGHT, FIGHTER_MAX_SPEED, FIGHTER_MIN_SPEED, FIGHTER_TRIGGER_DISTANCE, FIGHTER_WIDTH } from '../entities/enemies/FighterJet.js';
import { Helicopter, HELICOPTER_HEIGHT, HELICOPTER_MAX_SPEED, HELICOPTER_MIN_SPEED, HELICOPTER_WIDTH } from '../entities/enemies/Helicopter.js';
import { PatrolBoat, PATROL_BOAT_HEIGHT, PATROL_BOAT_MAX_SPEED, PATROL_BOAT_MIN_SPEED, PATROL_BOAT_WIDTH, type PatrolBoatMode } from '../entities/enemies/PatrolBoat.js';
import { boxTouchesLand, type Box } from './CollisionSystem.js';

export interface EnemySpawnConfig {
    /** Master switch (tests and tutorials can turn the armada off). */
    enabled: boolean;
    /** Distance between spawn slots along the river. */
    spacing: number;
    /** Each slot is jittered by up to +/- this much. */
    jitter: number;
    /** Nothing spawns below this world Y (the opening stretch stays calm). */
    minY: number;
    /** Keep-out distance above and below a bridge deck. */
    bridgeClearance: number;
    /** Extra gap kept between an enemy's Y band and a depot's. */
    depotClearance: number;
    /** Chance that a slot spawns anything in stage 0 ... */
    baseChance: number;
    /** ... plus this much per stage ... */
    chancePerStage: number;
    /** ... capped here. */
    maxChance: number;
    /** First stage (bridges destroyed) in which fighters appear. */
    fighterStage: number;
    /** First stage in which chokepoints and canyons get helicopter pairs. */
    pairStage: number;
    /** Cruiser patrols need at least this much room to sweep. */
    minPatrolSpan: number;
    /** Distance a drifting boat is assumed to slide while in play; reserved below it. */
    driftReach: number;
}

export const DEFAULT_ENEMY_SPAWN_CONFIG: Readonly<EnemySpawnConfig> = {
    enabled: true,
    spacing: 280,
    jitter: 70,
    minY: 700,
    bridgeClearance: 150,
    depotClearance: 70,
    baseChance: 0.5,
    chancePerStage: 0.1,
    maxChance: 0.9,
    fighterStage: 2,
    pairStage: 3,
    minPatrolSpan: 60,
    driftReach: 160,
};

interface PlacementBase {
    /** Stable identity: slot * 4 + index. */
    readonly id: number;
    readonly x: number;
    readonly y: number;
    /** Stage (bridges before it) that decided this placement's difficulty. */
    readonly stage: number;
}

export interface HelicopterPlacement extends PlacementBase {
    readonly kind: 'helicopter';
    readonly speed: number;
    readonly direction: Heading;
}

export interface BoatPlacement extends PlacementBase {
    readonly kind: 'patrol-boat';
    readonly mode: PatrolBoatMode;
    readonly speed: number;
    readonly direction: Heading;
}

export interface FighterPlacement extends PlacementBase {
    readonly kind: 'fighter';
    readonly speed: number;
    /** Streak direction; also which bank it waits on (+1 = left bank). */
    readonly direction: Heading;
    readonly triggerDistance: number;
}

export type EnemyPlacement = HelicopterPlacement | BoatPlacement | FighterPlacement;

/** The river and depot queries the spawner needs. `RiverGenerator` satisfies it. */
export interface EnemySpawnWorld extends DepotWorld {
    readonly config: DepotWorld['config'] & {
        readonly worldWidth: number;
        readonly sectionLength: number;
        readonly bridgeEverySections: number;
    };
    sample(worldY: number): { readonly leftBankX: number; readonly rightBankX: number };
    getSectionAt(worldY: number): { readonly kind: string };
}

/** The depot layout, used to keep enemies out of depots' Y bands. */
export interface DepotLayout {
    slotRange(minY: number, maxY: number): readonly [first: number, last: number];
    place(slot: number): DepotPlacement | null;
    readonly config: { readonly height: number };
}

const SALT_ENEMY = 0xe4e41000;
const MAX_CACHED_SLOTS = 1024;
const DEPOT_SCAN_PAD = 160;

export function createEnemy(placement: EnemyPlacement): Enemy {
    switch (placement.kind) {
        case 'helicopter':
            return new Helicopter(placement.id, placement.x, placement.y, { speed: placement.speed, direction: placement.direction });
        case 'patrol-boat':
            return new PatrolBoat(placement.id, placement.x, placement.y, {
                mode: placement.mode, speed: placement.speed, direction: placement.direction,
            });
        case 'fighter':
            return new FighterJet(placement.id, placement.x, placement.y, {
                speed: placement.speed, direction: placement.direction, triggerDistance: placement.triggerDistance,
            });
    }
}

function validateConfig(c: EnemySpawnConfig): void {
    const fail = (message: string): never => {
        throw new RangeError(`Invalid EnemySpawnConfig: ${message}`);
    };
    for (const [name, value] of Object.entries(c)) {
        if (typeof value === 'number' && !Number.isFinite(value)) fail(`${name} must be finite.`);
    }
    if (c.spacing <= 0) fail('spacing must be positive.');
    if (c.jitter < 0 || c.jitter * 2 >= c.spacing) fail('jitter must be in [0, spacing / 2).');
    if (c.baseChance < 0 || c.maxChance > 1 || c.baseChance > c.maxChance) fail('chances must satisfy 0 <= baseChance <= maxChance <= 1.');
    if (c.chancePerStage < 0) fail('chancePerStage must be non-negative.');
    if (c.bridgeClearance < 0 || c.depotClearance < 0 || c.driftReach < 0 || c.minPatrolSpan < 0) fail('distances must be non-negative.');
    if (!Number.isInteger(c.fighterStage) || c.fighterStage < 0) fail('fighterStage must be a non-negative integer.');
    if (!Number.isInteger(c.pairStage) || c.pairStage < 0) fail('pairStage must be a non-negative integer.');
}

/**
 * Deterministic enemy layout.
 *
 * Like the river and the depots, every slot's outcome is a pure function of
 * (seed, slot index): placements can be generated, discarded and regenerated in any
 * order and come out identical. A run is therefore replayable from its seed alone.
 *
 * Pacing (stage = bridges before the position, i.e. floor(y / 3200)):
 *  - Density: 50% of slots in stage 0, +10% per stage, capped at 90%.
 *  - Stage 0: patrol boats and slow helicopters (80-98 units/s) only.
 *  - Fighters appear from stage 2 (about 15% of spawns) and reach 30% from stage 4.
 *  - From stage 3, chokepoints and canyons also get helicopter pairs patrolling in
 *    opposite directions, and helicopters reach the full 80-140 units/s.
 *  - Where an island splits the river, each channel can hold its own enemy.
 *
 * Placement rules: patrollers (helicopters, boats) are verified to be in open water with
 * enough room to sweep; fighters wait just outside a bank. Enemies keep clear of bridges
 * and of every depot's Y band (including the water a drifting boat will slide through).
 */
export class EnemySpawner {
    readonly config: Readonly<EnemySpawnConfig>;
    private readonly world: EnemySpawnWorld;
    private readonly depots: DepotLayout;
    private readonly bridgeSpacing: number;
    private readonly cache = new Map<number, readonly EnemyPlacement[]>();

    constructor(world: EnemySpawnWorld, depots: DepotLayout, config: Partial<EnemySpawnConfig> = {}) {
        this.world = world;
        this.depots = depots;
        this.config = { ...DEFAULT_ENEMY_SPAWN_CONFIG, ...config };
        validateConfig(this.config);
        this.bridgeSpacing = world.config.bridgeEverySections * world.config.sectionLength;
    }

    /** Difficulty stage at a world Y: the number of bridges below it. */
    stageAt(worldY: number): number {
        return Math.max(0, Math.floor(worldY / this.bridgeSpacing));
    }

    /** Probability that a slot in `stage` spawns anything. */
    chanceFor(stage: number): number {
        const c = this.config;
        return Math.min(c.maxChance, c.baseChance + c.chancePerStage * Math.max(0, stage));
    }

    /** Spawn mix for a stage. Weights sum to 1. */
    weightsFor(stage: number): { readonly boat: number; readonly helicopter: number; readonly fighter: number } {
        const s = Math.max(0, stage);
        const fighter = s < this.config.fighterStage ? 0 : Math.min(0.3, 0.15 + 0.075 * (s - this.config.fighterStage));
        const boat = Math.max(0.2, 0.6 - 0.1 * s);
        return { boat, helicopter: 1 - boat - fighter, fighter };
    }

    /** Inclusive range of slots whose placements can fall inside [minY, maxY]. */
    slotRange(minY: number, maxY: number): readonly [first: number, last: number] {
        const { spacing, jitter } = this.config;
        const reach = jitter + 120; // pairs and island partners sit up to ~120 above their slot
        return [Math.max(0, Math.ceil((minY - reach) / spacing)), Math.floor((maxY + jitter) / spacing)];
    }

    /** Everything slot `slot` spawns (possibly nothing). Memoised. */
    place(slot: number): readonly EnemyPlacement[] {
        const cached = this.cache.get(slot);
        if (cached) return cached;
        const placements = this.config.enabled ? this.compute(slot) : [];
        if (this.cache.size >= MAX_CACHED_SLOTS) this.cache.clear();
        this.cache.set(slot, placements);
        return placements;
    }

    /** All placements with Y in [minY, maxY], ascending. */
    placementsIn(minY: number, maxY: number): EnemyPlacement[] {
        const [first, last] = this.slotRange(minY, maxY);
        const out: EnemyPlacement[] = [];
        for (let slot = first; slot <= last; slot++) {
            for (const p of this.place(slot)) if (p.y >= minY && p.y <= maxY) out.push(p);
        }
        return out.sort((a, b) => a.y - b.y || a.id - b.id);
    }

    create(placement: EnemyPlacement): Enemy {
        return createEnemy(placement);
    }

    // ----------------------------------------------------------- generation

    private compute(slot: number): readonly EnemyPlacement[] {
        const c = this.config;
        const world = this.world;
        if (slot < 0) return [];
        const rng = new Mulberry32(combineSeed(world.seed, slot, SALT_ENEMY));
        const baseY = slot * c.spacing + (rng.next() * 2 - 1) * c.jitter;
        const roll = rng.next();
        if (baseY < c.minY) return [];
        const stage = this.stageAt(baseY);
        if (roll >= this.chanceFor(stage)) return [];

        const section = world.getSectionAt(baseY).kind;
        const channels = world.getChannels(baseY);
        const out: EnemyPlacement[] = [];
        const add = (p: EnemyPlacement | null): void => {
            if (p) out.push(p);
        };

        if (section === 'channel' && channels.length === 2) {
            // Island: each channel gets its own enemy (never a fighter: those cross the whole river).
            for (let i = 0; i < 2; i++) {
                const channel = channels[i];
                if (!channel) continue;
                if (i === 1 && rng.next() > 0.75) continue;
                const kind = this.pickKind(stage, rng, false);
                const y = baseY + (i === 0 ? 0 : rng.range(45, 100));
                add(this.patroller(slot * 4 + i, kind, y, channel, stage, rng));
            }
            return out;
        }

        const kind = this.pickKind(stage, rng, true);
        if (kind === 'fighter') {
            add(this.fighter(slot * 4, baseY, stage, rng));
            return out;
        }
        const channel = channels[0];
        if (!channel) return out;
        const narrow = section === 'chokepoint' || section === 'canyon';
        if (kind === 'helicopter' && narrow && stage >= c.pairStage && rng.next() < 0.7) {
            // A pair patrolling in opposite directions, one behind the other.
            const gap = rng.range(70, 110);
            const first = this.patroller(slot * 4, 'helicopter', baseY, channel, stage, rng);
            const second = this.patroller(slot * 4 + 1, 'helicopter', baseY + gap, channel, stage, rng);
            add(first);
            if (first?.kind === 'helicopter' && second?.kind === 'helicopter') {
                add({ ...second, direction: first.direction === 1 ? -1 : 1 });
            } else {
                add(second);
            }
            return out;
        }
        add(this.patroller(slot * 4, kind, baseY, channel, stage, rng));
        return out;
    }

    private pickKind(stage: number, rng: Mulberry32, allowFighter: boolean): EnemyKind {
        const w = this.weightsFor(stage);
        const r = rng.next();
        if (allowFighter && r < w.fighter) return 'fighter';
        // Among the non-fighters, keep the boat : helicopter ratio of the stage.
        const boatShare = w.boat / (w.boat + w.helicopter);
        const t = allowFighter ? (r - w.fighter) / (1 - w.fighter) : r;
        return t < boatShare ? 'patrol-boat' : 'helicopter';
    }

    /** Helicopter or boat in a channel at `y`, or null if the water there cannot hold one. */
    private patroller(
        id: number,
        kind: EnemyKind,
        y: number,
        channel: { readonly leftX: number; readonly rightX: number },
        stage: number,
        rng: Mulberry32,
    ): HelicopterPlacement | BoatPlacement | null {
        const c = this.config;
        const isBoat = kind === 'patrol-boat';
        const width = isBoat ? PATROL_BOAT_WIDTH : HELICOPTER_WIDTH;
        const height = isBoat ? PATROL_BOAT_HEIGHT : HELICOPTER_HEIGHT;
        const stageFactor = Math.min(1, stage / 3);
        const direction: Heading = rng.next() < 0.5 ? -1 : 1;
        const along = rng.next();
        const speedRoll = rng.next();
        const modeRoll = rng.next();

        let mode: PatrolBoatMode = 'cruiser';
        if (isBoat && modeRoll < (stage === 0 ? 0.4 : 0.3)) mode = 'drifter';
        const drifts = isBoat && mode === 'drifter';
        const reachBelow = drifts ? c.driftReach : 0;
        if (!this.clearOfBridges(y - reachBelow, y)) return null;
        if (!this.clearOfDepots(y - height / 2 - reachBelow, y + height / 2)) return null;

        const centre = (channel.leftX + channel.rightX) / 2;
        const bounds = patrolBounds(this.world, centre, y, width / 2, height / 2);
        if (!bounds) return null;
        if (!drifts && bounds.max - bounds.min < c.minPatrolSpan) return null;
        // A drifter slides to lower Y: its channel must be roomy there too.
        if (drifts) {
            const lower = patrolBounds(this.world, centre, y - reachBelow, width / 2, height / 2);
            if (!lower || lower.max - lower.min < c.minPatrolSpan / 2) return null;
        }
        const x = bounds.min + (bounds.max - bounds.min) * (0.15 + 0.7 * along);
        const box: Box = { x, y, width, height };
        if (boxTouchesLand(this.world, box)) return null;

        if (isBoat) {
            const speed = PATROL_BOAT_MIN_SPEED + (PATROL_BOAT_MAX_SPEED - PATROL_BOAT_MIN_SPEED) * speedRoll;
            return { id, kind: 'patrol-boat', x, y, stage, mode, speed, direction };
        }
        // Stage 0 helicopters are slow (80-98); the full 80-140 opens up by stage 3.
        const speed = HELICOPTER_MIN_SPEED + (HELICOPTER_MAX_SPEED - HELICOPTER_MIN_SPEED) * speedRoll * (0.3 + 0.7 * stageFactor);
        return { id, kind: 'helicopter', x, y, stage, speed, direction };
    }

    /** A fighter parked on the bank beside the river at `y`. */
    private fighter(id: number, y: number, stage: number, rng: Mulberry32): FighterPlacement | null {
        const side = rng.next() < 0.5 ? 1 : -1; // +1: waits on the left bank, streaks right
        const speedRoll = rng.next();
        const triggerRoll = rng.next();
        if (!this.clearOfBridges(y - FIGHTER_HEIGHT / 2, y + FIGHTER_HEIGHT / 2)) return null;
        if (!this.clearOfDepots(y - FIGHTER_HEIGHT / 2, y + FIGHTER_HEIGHT / 2)) return null;
        const river = this.world.sample(y);
        const worldWidth = this.world.config.worldWidth;
        const offset = FIGHTER_WIDTH / 2 + 16;
        const x = side === 1
            ? Math.max(-FIGHTER_WIDTH, river.leftBankX - offset)
            : Math.min(worldWidth + FIGHTER_WIDTH, river.rightBankX + offset);
        return {
            id, kind: 'fighter', x, y, stage,
            speed: FIGHTER_MIN_SPEED + (FIGHTER_MAX_SPEED - FIGHTER_MIN_SPEED) * speedRoll,
            direction: side,
            triggerDistance: FIGHTER_TRIGGER_DISTANCE - 60 + 120 * triggerRoll,
        };
    }

    private clearOfBridges(minY: number, maxY: number): boolean {
        const pad = this.config.bridgeClearance;
        return this.world.findBridges(minY - pad, maxY + pad).length === 0;
    }

    /** True if no depot's Y band (plus clearance) overlaps [minY, maxY]. */
    private clearOfDepots(minY: number, maxY: number): boolean {
        const pad = this.config.depotClearance;
        const half = this.depots.config.height / 2;
        const [first, last] = this.depots.slotRange(minY - DEPOT_SCAN_PAD, maxY + DEPOT_SCAN_PAD);
        for (let slot = first; slot <= last; slot++) {
            const depot = this.depots.place(slot);
            if (!depot) continue;
            if (depot.y + half + pad > minY && depot.y - half - pad < maxY) return false;
        }
        return true;
    }
}

