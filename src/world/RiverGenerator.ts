import { Mulberry32, combineSeed, valueNoise1D } from '../core/PRNG.js';

/**
 * Deterministic procedural river.
 *
 * Coordinates: world X is 0..worldWidth (left to right). World Y increases
 * "upstream": the camera advances toward +Y, so the scenery scrolls down the screen.
 *
 * The river is a pure function of (seed, config): every slice can be computed in any
 * order, discarded and recomputed, and always comes out identical. Slices are
 * therefore only a cache, and `prune()` can drop old ones safely.
 *
 * Pacing, per "stage" (the span between two bridges, `bridgeEverySections` sections):
 *   strait (calm after a bridge) -> canyon / channel / chokepoint (shuffled per stage)
 *   -> strait (calm approach) -> BRIDGE (checkpoint at the section boundary)
 * The first `trainingSections` sections are always wide, gentle straits.
 */

export type SectionKind = 'strait' | 'canyon' | 'chokepoint' | 'channel';

export interface RiverConfig {
    /** World/logical width in units (the renderer maps 1 unit to 1 logical pixel). */
    worldWidth: number;
    /** Vertical spacing between slices. Must divide `sectionLength`. */
    sliceHeight: number;
    /** Length of a section (a stretch with one character) in world units. */
    sectionLength: number;
    /** Length over which width eases between neighbouring sections (<= sectionLength). */
    transitionLength: number;
    /** Minimum distance between any bank and the world edge. */
    sideMargin: number;
    /** Guaranteed minimum navigable river width, including bank wobble. */
    minRiverWidth: number;
    /** Guaranteed minimum width of each channel around an island. */
    minChannelWidth: number;
    /** Maximum +/- shoreline irregularity per bank. */
    bankWobble: number;
    /** Maximum distance the river centre line may wander from the world centre. */
    maxMeander: number;
    /** Sections per stage; a bridge is placed every this many sections. */
    bridgeEverySections: number;
    /** Half the bridge thickness along Y. */
    bridgeHalfThickness: number;
    /** Number of initial wide, gentle sections. */
    trainingSections: number;
}

export const DEFAULT_RIVER_CONFIG: Readonly<RiverConfig> = {
    worldWidth: 960,
    sliceHeight: 8,
    sectionLength: 640,
    transitionLength: 512,
    sideMargin: 40,
    minRiverWidth: 180,
    minChannelWidth: 140,
    bankWobble: 12,
    maxMeander: 180,
    bridgeEverySections: 5,
    bridgeHalfThickness: 24,
    trainingSections: 2,
};

/** One horizontal slice of the river. Immutable once generated. */
export interface RiverSlice {
    readonly index: number;
    readonly worldY: number;
    readonly leftBankX: number;
    readonly rightBankX: number;
    /** True for the slices making up a bridge span. */
    readonly isBridgeSection: boolean;
    /** True when a central island splits the river into two channels. */
    readonly isBranching: boolean;
    /** Island extents. Equal to each other (zero width) when not branching. */
    readonly islandLeftX: number;
    readonly islandRightX: number;
    readonly sectionIndex: number;
    readonly sectionKind: SectionKind;
}

export interface RiverSection {
    readonly index: number;
    /** Which bridge-to-bridge stage this section belongs to. */
    readonly stage: number;
    /** Position within the stage (0 = right after a bridge). */
    readonly position: number;
    readonly kind: SectionKind;
    readonly startY: number;
    readonly endY: number;
    /** Nominal river width for this section. */
    readonly width: number;
    /** How much a chokepoint narrows the river at its centre. */
    readonly pinchDepth: number;
    /** Target island half width (channel sections only; otherwise 0). */
    readonly islandHalfWidth: number;
    /** Island centre offset as a fraction of river width. */
    readonly islandOffset: number;
    /** 0 (easy) .. 1 (hardest). */
    readonly difficulty: number;
}

/** Interpolated river geometry at an arbitrary world Y. */
export interface RiverSample {
    readonly worldY: number;
    readonly leftBankX: number;
    readonly rightBankX: number;
    readonly centerX: number;
    /** rightBankX - leftBankX (the outer river width, island included). */
    readonly width: number;
    readonly isBranching: boolean;
    readonly islandLeftX: number;
    readonly islandRightX: number;
    readonly isBridgeSection: boolean;
    readonly sectionIndex: number;
    readonly sectionKind: SectionKind;
}

export interface RiverChannel {
    readonly leftX: number;
    readonly rightX: number;
}

export interface BridgeSpan {
    /** 1-based bridge number; also the number of checkpoints passed when crossing it. */
    readonly number: number;
    readonly centerY: number;
    readonly bottomY: number;
    readonly topY: number;
}

/** Collision-friendly view of the river at one Y. */
export interface RiverBounds {
    leftBankX: number;
    rightBankX: number;
    isLand(worldX: number, worldY: number): boolean;
}

const SALT_SECTION = 0x5ec71001;
const SALT_DECK = 0xdec40002;
const CH_CENTER_LOW = 1;
const CH_CENTER_HIGH = 2;
const CH_WOBBLE_LEFT = 3;
const CH_WOBBLE_RIGHT = 4;
const CH_ISLAND = 5;

const MIDDLE_KINDS: readonly SectionKind[] = ['canyon', 'channel', 'chokepoint'];
const MAX_CACHED_SLICES = 8192;

function clamp(value: number, min: number, max: number): number {
    return value < min ? min : value > max ? max : value;
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
    const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
}

function validateConfig(c: RiverConfig): void {
    const fail = (message: string): never => {
        throw new RangeError(`Invalid RiverConfig: ${message}`);
    };
    const positive = (name: string, value: number): void => {
        if (!Number.isFinite(value) || value <= 0) fail(`${name} must be a positive finite number.`);
    };
    const nonNegative = (name: string, value: number): void => {
        if (!Number.isFinite(value) || value < 0) fail(`${name} must be a non-negative finite number.`);
    };
    positive('worldWidth', c.worldWidth);
    positive('sliceHeight', c.sliceHeight);
    positive('sectionLength', c.sectionLength);
    positive('transitionLength', c.transitionLength);
    positive('minRiverWidth', c.minRiverWidth);
    positive('minChannelWidth', c.minChannelWidth);
    nonNegative('sideMargin', c.sideMargin);
    nonNegative('bankWobble', c.bankWobble);
    nonNegative('maxMeander', c.maxMeander);
    nonNegative('bridgeHalfThickness', c.bridgeHalfThickness);
    const ratio = c.sectionLength / c.sliceHeight;
    if (Math.abs(ratio - Math.round(ratio)) > 1e-9) fail('sliceHeight must evenly divide sectionLength.');
    if (c.transitionLength > c.sectionLength) fail('transitionLength must not exceed sectionLength.');
    if (!Number.isInteger(c.bridgeEverySections) || c.bridgeEverySections < 2) {
        fail('bridgeEverySections must be an integer >= 2.');
    }
    if (!Number.isInteger(c.trainingSections) || c.trainingSections < 0) {
        fail('trainingSections must be a non-negative integer.');
    }
    if (c.sideMargin < c.bankWobble) fail('sideMargin must be at least bankWobble.');
    if (c.minRiverWidth + 2 * c.bankWobble > c.worldWidth - 2 * c.sideMargin) {
        fail('minRiverWidth does not fit inside the world.');
    }
    if (c.bridgeHalfThickness * 4 > c.sectionLength) fail('bridgeHalfThickness is too large.');
}

export class RiverGenerator {
    readonly seed: number;
    readonly config: Readonly<RiverConfig>;

    private readonly slices = new Map<number, RiverSlice>();
    private readonly sections = new Map<number, RiverSection>();
    private readonly decks = new Map<number, readonly SectionKind[]>();
    private readonly floorWidth: number;
    private readonly ceilingWidth: number;
    private readonly bridgeSpacing: number;
    private readonly isLandFn = (worldX: number, worldY: number): boolean => this.isLand(worldX, worldY);

    constructor(seed: number, config: Partial<RiverConfig> = {}) {
        if (!Number.isFinite(seed)) throw new RangeError('seed must be a finite number.');
        this.seed = seed >>> 0;
        this.config = { ...DEFAULT_RIVER_CONFIG, ...config };
        validateConfig(this.config);
        this.floorWidth = this.config.minRiverWidth + 2 * this.config.bankWobble;
        this.ceilingWidth = this.config.worldWidth - 2 * this.config.sideMargin;
        this.bridgeSpacing = this.config.bridgeEverySections * this.config.sectionLength;
    }

    // ---------------------------------------------------------------- slices

    get cachedSliceCount(): number {
        return this.slices.size;
    }

    /** Index of the slice at or just below `worldY`. */
    sliceIndexAt(worldY: number): number {
        return Math.floor(worldY / this.config.sliceHeight);
    }

    /** Returns slice `index` (world Y = index * sliceHeight). Negative indices are valid. */
    getSlice(index: number): RiverSlice {
        let slice = this.slices.get(index);
        if (!slice) {
            if (this.slices.size >= MAX_CACHED_SLICES) this.slices.clear();
            slice = this.computeSlice(index);
            this.slices.set(index, slice);
        }
        return slice;
    }

    /** Drops cached slices entirely below `worldY`. They are recomputed on demand. */
    prune(worldY: number): void {
        const limit = this.sliceIndexAt(worldY);
        for (const index of this.slices.keys()) {
            if (index < limit) this.slices.delete(index);
        }
    }

    // -------------------------------------------------------------- sections

    getSection(index: number): RiverSection {
        const k = Math.max(0, Math.floor(index));
        let section = this.sections.get(k);
        if (!section) {
            section = this.computeSection(k);
            this.sections.set(k, section);
        }
        return section;
    }

    getSectionAt(worldY: number): RiverSection {
        return this.getSection(Math.floor(Math.max(0, worldY) / this.config.sectionLength));
    }

    // --------------------------------------------------------------- bridges

    /** True if `worldY` lies on a bridge span. */
    isBridge(worldY: number): boolean {
        const m = Math.round(worldY / this.bridgeSpacing);
        return m >= 1 && Math.abs(worldY - m * this.bridgeSpacing) <= this.config.bridgeHalfThickness + 1e-9;
    }

    /** Bridges overlapping [minY, maxY], ascending. */
    findBridges(minY: number, maxY: number): BridgeSpan[] {
        const half = this.config.bridgeHalfThickness;
        const spans: BridgeSpan[] = [];
        const first = Math.max(1, Math.ceil((minY - half) / this.bridgeSpacing));
        const last = Math.floor((maxY + half) / this.bridgeSpacing);
        for (let m = first; m <= last; m++) {
            const centerY = m * this.bridgeSpacing;
            spans.push({ number: m, centerY, bottomY: centerY - half, topY: centerY + half });
        }
        return spans;
    }

    /** World Y of the first bridge centre strictly above `worldY`. */
    nextBridgeY(worldY: number): number {
        return Math.max(1, Math.floor(worldY / this.bridgeSpacing) + 1) * this.bridgeSpacing;
    }

    // ------------------------------------------------------- spatial queries

    /** Geometry at `worldY`, linearly interpolated between slices (exactly what is drawn). */
    sample(worldY: number): RiverSample {
        const h = this.config.sliceHeight;
        const i0 = Math.floor(worldY / h);
        const t = (worldY - i0 * h) / h;
        const a = this.getSlice(i0);
        const b = this.getSlice(i0 + 1);
        const left = lerp(a.leftBankX, b.leftBankX, t);
        const right = lerp(a.rightBankX, b.rightBankX, t);
        const islandLeft = lerp(a.islandLeftX, b.islandLeftX, t);
        const islandRight = lerp(a.islandRightX, b.islandRightX, t);
        const section = this.getSectionAt(worldY);
        return {
            worldY,
            leftBankX: left,
            rightBankX: right,
            centerX: (left + right) / 2,
            width: right - left,
            isBranching: islandRight - islandLeft > 1e-6,
            islandLeftX: islandLeft,
            islandRightX: islandRight,
            isBridgeSection: this.isBridge(worldY),
            sectionIndex: section.index,
            sectionKind: section.kind,
        };
    }

    /** Navigable channels at `worldY`: one normally, two around an island. */
    getChannels(worldY: number): RiverChannel[] {
        const s = this.sample(worldY);
        if (!s.isBranching) return [{ leftX: s.leftBankX, rightX: s.rightBankX }];
        return [
            { leftX: s.leftBankX, rightX: s.islandLeftX },
            { leftX: s.islandRightX, rightX: s.rightBankX },
        ];
    }

    /** True if (worldX, worldY) is bank, island or outside the world. Bridges are not land. */
    isLand(worldX: number, worldY: number): boolean {
        if (!(worldX >= 0 && worldX <= this.config.worldWidth)) return true;
        const s = this.sample(worldY);
        if (worldX < s.leftBankX || worldX > s.rightBankX) return true;
        return s.isBranching && worldX >= s.islandLeftX && worldX <= s.islandRightX;
    }

    /** Bank positions at `worldY` plus an `isLand` query usable for any position. */
    getBounds(worldY: number): RiverBounds {
        const s = this.sample(worldY);
        return { leftBankX: s.leftBankX, rightBankX: s.rightBankX, isLand: this.isLandFn };
    }

    // -------------------------------------------------------------- internals

    private getDeck(stage: number): readonly SectionKind[] {
        let deck = this.decks.get(stage);
        if (!deck) {
            deck = new Mulberry32(combineSeed(this.seed, stage, SALT_DECK)).shuffle(MIDDLE_KINDS);
            this.decks.set(stage, deck);
        }
        return deck;
    }

    private computeSection(k: number): RiverSection {
        const c = this.config;
        const n = c.bridgeEverySections;
        const stage = Math.floor(k / n);
        const position = k - stage * n;
        const difficulty = clamp(k / (n * 12), 0, 1);

        let kind: SectionKind = 'strait';
        if (k >= c.trainingSections && position !== 0 && position !== n - 1) {
            const deck = this.getDeck(stage);
            kind = deck[(position - 1) % deck.length] ?? 'strait';
        }

        // A fixed number of draws per section keeps streams independent of `kind`.
        const rng = new Mulberry32(combineSeed(this.seed, k, SALT_SECTION));
        const a = rng.next();
        const b = rng.next();
        const cc = rng.next();

        let width: number;
        let pinchDepth = 0;
        let islandHalfWidth = 0;
        let islandOffset = 0;
        switch (kind) {
            case 'strait':
                width = k < c.trainingSections ? lerp(720, 800, a) : lerp(540, 700, a) - 90 * difficulty;
                break;
            case 'canyon':
                width = lerp(270, 350, a) - 55 * difficulty;
                break;
            case 'chokepoint': {
                width = lerp(440, 540, a);
                const target = Math.max(this.floorWidth, lerp(215, 255, b) - 25 * difficulty);
                pinchDepth = Math.max(0, width - target);
                break;
            }
            case 'channel':
                width = lerp(680, 800, a);
                islandHalfWidth = lerp(65, 125, b);
                islandOffset = (cc * 2 - 1) * 0.08;
                break;
        }
        return {
            index: k,
            stage,
            position,
            kind,
            startY: k * c.sectionLength,
            endY: (k + 1) * c.sectionLength,
            width: clamp(width, this.floorWidth, this.ceilingWidth),
            pinchDepth,
            islandHalfWidth,
            islandOffset,
            difficulty,
        };
    }

    /** Smooth nominal width at `y` (>= 0): plateau per section, eased across boundaries. */
    private widthAt(section: RiverSection, f: number): number {
        const L = this.config.sectionLength;
        const T = this.config.transitionLength;
        const local = f * L;
        let width = section.width;
        if (section.index > 0 && local < T / 2) {
            const t = smoothstep(0, 1, (local + T / 2) / T);
            width = lerp(this.getSection(section.index - 1).width, section.width, t);
        } else if (local > L - T / 2) {
            const t = smoothstep(0, 1, (local - (L - T / 2)) / T);
            width = lerp(section.width, this.getSection(section.index + 1).width, t);
        }
        if (section.pinchDepth > 0) {
            // 1 across the middle of the section, easing to 0 at both ends.
            const d = Math.abs(2 * f - 1);
            width -= section.pinchDepth * (1 - smoothstep(0, 1, d));
        }
        return clamp(width, this.floorWidth, this.ceilingWidth);
    }

    private computeSlice(index: number): RiverSlice {
        const c = this.config;
        const worldY = index * c.sliceHeight;
        const y = Math.max(0, worldY);
        const k = Math.floor(y / c.sectionLength);
        const section = this.getSection(k);
        const f = (y - k * c.sectionLength) / c.sectionLength;

        const width = this.widthAt(section, f);
        const slack = Math.min(c.maxMeander, (c.worldWidth - 2 * c.sideMargin - width) / 2);
        const ramp = c.trainingSections > 0
            ? lerp(0.2, 1, smoothstep(0, c.trainingSections * c.sectionLength, y))
            : 1;
        const meander = 0.72 * valueNoise1D(this.seed, CH_CENTER_LOW, y / 1700)
            + 0.28 * valueNoise1D(this.seed, CH_CENTER_HIGH, y / 800);
        const center = c.worldWidth / 2 + meander * slack * ramp;

        const leftBankX = center - width / 2 + valueNoise1D(this.seed, CH_WOBBLE_LEFT, y / 200) * c.bankWobble;
        const rightBankX = center + width / 2 + valueNoise1D(this.seed, CH_WOBBLE_RIGHT, y / 200) * c.bankWobble;

        let half = 0;
        let islandCenter = center;
        if (section.kind === 'channel') {
            islandCenter = center + section.islandOffset * width;
            // Tapers to nothing at both ends of the section, so islands never touch bridges.
            const envelope = smoothstep(0.14, 0.36, f) * (1 - smoothstep(0.64, 0.86, f));
            const limit = width / 2 - Math.abs(islandCenter - center) - c.minChannelWidth - c.bankWobble;
            half = Math.min(
                section.islandHalfWidth * envelope * (1 + 0.12 * valueNoise1D(this.seed, CH_ISLAND, y / 70)),
                limit,
            );
            if (half < 1) half = 0;
        }

        return {
            index,
            worldY,
            leftBankX,
            rightBankX,
            isBridgeSection: this.isBridge(worldY),
            isBranching: half > 0,
            islandLeftX: islandCenter - half,
            islandRightX: islandCenter + half,
            sectionIndex: section.index,
            sectionKind: section.kind,
        };
    }
}
