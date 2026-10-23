/** What each kind of target is worth. */
export interface PointTable {
    readonly patrolBoat: number;
    readonly helicopter: number;
    readonly depot: number;
    readonly fighter: number;
    readonly bridge: number;
}

export const DEFAULT_POINT_TABLE: Readonly<PointTable> = {
    patrolBoat: 30,
    helicopter: 60,
    depot: 80,
    fighter: 100,
    bridge: 500,
};

export type ScoreSource = keyof PointTable;

export interface ProgressionConfig {
    startLives: number;
    /** An extra life is awarded each time the score passes a multiple of this. 0 disables. */
    bonusLifeEvery: number;
    /** Most lives that can be held at once (bonus lives beyond it are lost). */
    maxLives: number;
    points: PointTable;
}

export const DEFAULT_PROGRESSION_CONFIG: Readonly<ProgressionConfig> = {
    startLives: 3,
    bonusLifeEvery: 10000,
    maxLives: 99,
    points: DEFAULT_POINT_TABLE,
};

/** Number of targets destroyed so far, by kind. */
export type KillCounts = { [K in ScoreSource]: number };

export interface AwardResult {
    /** Points added (0 for non-positive or invalid input). */
    readonly points: number;
    /** Extra lives granted by this award (0 when the cap blocked them). */
    readonly bonusLives: number;
    /** Score after the award. */
    readonly score: number;
}

const NO_AWARD = (score: number): AwardResult => ({ points: 0, bonusLives: 0, score });

function emptyKills(): KillCounts {
    return { patrolBoat: 0, helicopter: 0, depot: 0, fighter: 0, bridge: 0 };
}

/**
 * Score, lives and stage progression for a run.
 *
 * - Points come from a table (boat 30, helicopter 60, depot 80, fighter 100, bridge 500).
 * - An extra life is granted every `bonusLifeEvery` points. The number owed is derived
 *   from the score (`floor(score / every) - granted`), so one big award that skips
 *   several thresholds grants all of them, and none is ever granted twice.
 * - The stage counter is the number of bridges destroyed; stage 1 is the start of the river.
 */
export class ProgressionSystem {
    readonly config: Readonly<ProgressionConfig>;
    private currentScore = 0;
    private currentLives: number;
    private bonusesGranted = 0;
    private bridgesDestroyed = 0;
    private readonly counts: KillCounts = emptyKills();

    constructor(config: Partial<Omit<ProgressionConfig, 'points'>> & { points?: Partial<PointTable> } = {}) {
        this.config = {
            ...DEFAULT_PROGRESSION_CONFIG,
            ...config,
            points: { ...DEFAULT_POINT_TABLE, ...config.points },
        };
        const c = this.config;
        if (!Number.isInteger(c.startLives) || c.startLives < 1) throw new RangeError('Invalid ProgressionConfig: startLives must be an integer >= 1.');
        if (!Number.isInteger(c.maxLives) || c.maxLives < c.startLives) throw new RangeError('Invalid ProgressionConfig: maxLives must be an integer >= startLives.');
        if (!Number.isFinite(c.bonusLifeEvery) || c.bonusLifeEvery < 0) throw new RangeError('Invalid ProgressionConfig: bonusLifeEvery must be >= 0.');
        for (const [name, value] of Object.entries(c.points)) {
            if (!Number.isFinite(value) || value < 0) throw new RangeError(`Invalid ProgressionConfig: points.${name} must be a non-negative number.`);
        }
        this.currentLives = c.startLives;
    }

    get score(): number {
        return this.currentScore;
    }

    get lives(): number {
        return this.currentLives;
    }

    /** Bridges destroyed so far (0 at the start). */
    get stage(): number {
        return this.bridgesDestroyed;
    }

    /** Human-facing section number: 1 at the start, +1 per bridge. */
    get stageNumber(): number {
        return this.bridgesDestroyed + 1;
    }

    get bonusLivesGranted(): number {
        return this.bonusesGranted;
    }

    /** The score at which the next extra life is awarded, or null when bonus lives are off. */
    get nextBonusAt(): number | null {
        const every = this.config.bonusLifeEvery;
        return every > 0 ? (this.bonusesGranted + 1) * every : null;
    }

    /** Copy of the kill counters. */
    get kills(): Readonly<KillCounts> {
        return { ...this.counts };
    }

    /** Total targets destroyed (all kinds). */
    get totalKills(): number {
        let n = 0;
        for (const value of Object.values(this.counts)) n += value;
        return n;
    }

    pointsFor(source: ScoreSource): number {
        return this.config.points[source];
    }

    /** Adds raw points (no kill is recorded). Grants any extra lives the score has earned. */
    addPoints(points: number): AwardResult {
        if (!Number.isFinite(points) || points <= 0) return NO_AWARD(this.currentScore);
        this.currentScore += points;
        return { points, bonusLives: this.grantBonusLives(), score: this.currentScore };
    }

    /** Awards the table value for destroying `source` and records the kill. */
    award(source: ScoreSource): AwardResult {
        this.counts[source]++;
        if (source === 'bridge') this.bridgesDestroyed++;
        return this.addPoints(this.config.points[source]);
    }

    /** Spends a life. Returns the lives left (never below 0). */
    loseLife(): number {
        this.currentLives = Math.max(0, this.currentLives - 1);
        return this.currentLives;
    }

    /** Starts a fresh run. */
    reset(): void {
        this.currentScore = 0;
        this.currentLives = this.config.startLives;
        this.bonusesGranted = 0;
        this.bridgesDestroyed = 0;
        Object.assign(this.counts, emptyKills());
    }

    private grantBonusLives(): number {
        const every = this.config.bonusLifeEvery;
        if (every <= 0) return 0;
        const owed = Math.floor(this.currentScore / every) - this.bonusesGranted;
        if (owed <= 0) return 0;
        // The threshold counts as passed even if the cap stops us paying out the life.
        this.bonusesGranted += owed;
        const room = Math.max(0, this.config.maxLives - this.currentLives);
        const given = Math.min(owed, room);
        this.currentLives += given;
        return given;
    }
}
