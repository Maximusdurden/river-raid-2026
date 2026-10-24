/**
 * Endless-mode difficulty: how much faster, hungrier and meaner the river gets with every
 * bridge. Pure maths, no state, so it can be tested without a game.
 *
 * Everything is a function of `stage`, the number of bridges destroyed (or, for things that
 * are placed in the world, the number of bridges below that spot, which is the same thing for
 * anything the player is flying toward). Stage 0 is exactly the campaign game: every scale is 1
 * and nothing extra spawns, so campaign mode never needs to know this file exists.
 *
 * The curves, with the default numbers:
 *
 *   speed        +3.5% per bridge in a straight line until the multiplier is 60% of the way to
 *                the 1.8x ceiling (about bridge 14, x1.48), then easing off smoothly toward it
 *                (a "soft cap": no sudden wall, and the ceiling is approached but never passed).
 *                Scales forward speeds AND the jet's sideways speed and accelerations by the same
 *                factor, which is what keeps steep banks flyable: the steepest bank asks for
 *                sideways speed in proportion to forward speed, and both grow together.
 *   fuel burn    +2.5% per bridge, hard cap 1.6x.
 *   helicopters  +5% sweep speed per bridge, hard cap 1.75x.
 *   fighters     launch from 600 units away at first and from 850 at full strength, and streak
 *                up to 580 units/s (from 460), both ramping over `fighterRampBridges` bridges.
 *   depots       15% fewer after bridge 10 (eased in over ten bridges, so it is never a cliff).
 *   enemy waves  an extra enemy between the regular ones: +6% chance per bridge, up to 60%.
 */

export interface DifficultyConfig {
    /** Speed gain per bridge at the start of the curve (0.035 = +3.5%). */
    readonly speedGrowth: number;
    /** The speed multiplier the soft cap approaches. */
    readonly speedCap: number;
    /** Growth is a straight line until the multiplier has covered this fraction of the way to the cap, then it eases off. */
    readonly speedKnee: number;
    readonly burnGrowth: number;
    readonly burnCap: number;
    readonly helicopterGrowth: number;
    readonly helicopterCap: number;
    /** Depots start thinning after this many bridges ... */
    readonly depotThinAfter: number;
    /** ... reaching the full reduction this many bridges later ... */
    readonly depotThinOver: number;
    /** ... where the chance of a depot is `1 - depotThinBy` of normal. */
    readonly depotThinBy: number;
    readonly fighterTriggerStart: number;
    readonly fighterTriggerEnd: number;
    /** Fastest streak (units/s) a fighter reaches at full ramp. */
    readonly fighterSpeedEnd: number;
    /** The fastest streak at stage 0, which `fighterSpeedEnd` is scaled from. */
    readonly fighterSpeedStart: number;
    readonly fighterRampBridges: number;
    readonly extraEnemyPerBridge: number;
    readonly extraEnemyMax: number;
}

export const DEFAULT_DIFFICULTY: Readonly<DifficultyConfig> = {
    speedGrowth: 0.035,
    speedCap: 1.8,
    speedKnee: 0.6,
    burnGrowth: 0.025,
    burnCap: 1.6,
    helicopterGrowth: 0.05,
    helicopterCap: 1.75,
    depotThinAfter: 10,
    depotThinOver: 10,
    depotThinBy: 0.15,
    fighterTriggerStart: 600,
    fighterTriggerEnd: 850,
    fighterSpeedStart: 460,
    fighterSpeedEnd: 580,
    fighterRampBridges: 15,
    extraEnemyPerBridge: 0.06,
    extraEnemyMax: 0.6,
};

/** Everything the game needs to know about how hard it is at one stage. */
export interface DifficultyProfile {
    /** Bridges destroyed (whole number, never negative). */
    readonly stage: number;
    /** Multiplies forward speeds and every sideways limit of the jet, together. */
    readonly speedScale: number;
    /** Multiplies fuel burn. */
    readonly burnScale: number;
    /** Multiplies helicopter sweep speed. */
    readonly helicopterSpeedScale: number;
    /** Multiplies the chance that a depot slot holds a depot (1 = unchanged). */
    readonly depotChanceScale: number;
    /** How far ahead of the player a parked fighter launches. */
    readonly fighterTrigger: number;
    /** Multiplies a fighter's streak speed. */
    readonly fighterSpeedScale: number;
    /** Chance of an extra enemy between the regular waves. */
    readonly extraEnemyChance: number;
}

/** Turns anything into a whole stage >= 0. */
export function normalizeStage(stage: number): number {
    return Number.isFinite(stage) ? Math.max(0, Math.floor(stage)) : 0;
}

/**
 * 1 at stage 0, rising by `growth` per stage in a straight line until it has covered `knee` of the
 * way to `cap`, then easing into `cap` along an exponential that starts at exactly the same slope
 * (so there is no kink): `cap - (cap - m) * e^(-growth * (n - nKnee) / (cap - m))` where `m` is the
 * multiplier at the knee. Strictly increasing and never reaches `cap`.
 */
export function softCapScale(stage: number, growth: number, cap: number, knee = 0.6): number {
    const span = cap - 1;
    if (!(span > 0) || !(growth > 0)) return 1;
    const n = normalizeStage(stage);
    const k = Math.min(Math.max(knee, 0), 0.999);
    const kneeScale = 1 + span * k;
    const kneeStage = (span * k) / growth;
    if (n <= kneeStage) return 1 + growth * n;
    const remaining = cap - kneeScale;
    return cap - remaining * Math.exp((-growth * (n - kneeStage)) / remaining);
}

/** 1 at stage 0, rising by `growth` per stage in a straight line, stopping dead at `cap`. */
export function hardCapScale(stage: number, growth: number, cap: number): number {
    return Math.min(cap, 1 + growth * normalizeStage(stage));
}

/** 0 at stage 0 up to 1 at `bridges`, in a straight line. */
function ramp(stage: number, bridges: number): number {
    return bridges > 0 ? Math.min(1, normalizeStage(stage) / bridges) : 1;
}

/** The difficulty at `stage`. */
export function difficultyAt(stage: number, config: Readonly<DifficultyConfig> = DEFAULT_DIFFICULTY): DifficultyProfile {
    const n = normalizeStage(stage);
    const c = config;
    const fighterRamp = ramp(n, c.fighterRampBridges);
    const thin = c.depotThinOver > 0
        ? Math.min(1, Math.max(0, (n - c.depotThinAfter) / c.depotThinOver))
        : (n > c.depotThinAfter ? 1 : 0);
    return {
        stage: n,
        speedScale: softCapScale(n, c.speedGrowth, c.speedCap, c.speedKnee),
        burnScale: hardCapScale(n, c.burnGrowth, c.burnCap),
        helicopterSpeedScale: hardCapScale(n, c.helicopterGrowth, c.helicopterCap),
        depotChanceScale: 1 - c.depotThinBy * thin,
        fighterTrigger: c.fighterTriggerStart + (c.fighterTriggerEnd - c.fighterTriggerStart) * fighterRamp,
        fighterSpeedScale: 1 + (c.fighterSpeedEnd / c.fighterSpeedStart - 1) * fighterRamp,
        extraEnemyChance: Math.min(c.extraEnemyMax, c.extraEnemyPerBridge * n),
    };
}

/** The profile of the plain campaign game: nothing scaled, nothing extra. */
export const CAMPAIGN_DIFFICULTY: DifficultyProfile = difficultyAt(0);

/** A way to look up the difficulty of a stage; spawners are given one in endless mode. */
export type DifficultyCurve = (stage: number) => DifficultyProfile;

export function validateDifficultyConfig(config: Readonly<DifficultyConfig>): void {
    const fail = (message: string): never => {
        throw new RangeError(`Invalid DifficultyConfig: ${message}`);
    };
    for (const [name, value] of Object.entries(config)) {
        if (!Number.isFinite(value)) fail(`${name} must be finite.`);
    }
    if (config.speedGrowth < 0 || config.burnGrowth < 0 || config.helicopterGrowth < 0) fail('growth rates must be non-negative.');
    if (config.speedCap < 1 || config.burnCap < 1 || config.helicopterCap < 1) fail('caps must be at least 1.');
    if (config.speedKnee < 0 || config.speedKnee >= 1) fail('speedKnee must be in [0, 1).');
    if (config.depotThinBy < 0 || config.depotThinBy >= 1) fail('depotThinBy must be in [0, 1).');
    if (config.depotThinAfter < 0 || config.depotThinOver < 0) fail('depot thinning bridges must be non-negative.');
    if (config.fighterTriggerStart <= 0 || config.fighterTriggerEnd < config.fighterTriggerStart) fail('fighter trigger distances must be positive and not shrink.');
    if (config.fighterSpeedStart <= 0 || config.fighterSpeedEnd < config.fighterSpeedStart) fail('fighter speeds must be positive and not shrink.');
    if (config.fighterRampBridges < 0) fail('fighterRampBridges must be non-negative.');
    if (config.extraEnemyPerBridge < 0 || config.extraEnemyMax < 0 || config.extraEnemyMax > 1) fail('extra enemy chances must be in [0, 1].');
}
