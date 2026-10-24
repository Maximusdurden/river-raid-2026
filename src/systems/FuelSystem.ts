export interface FuelConfig {
    /** Tank size. */
    capacity: number;
    /** Starting (and respawn) level. Must be within [0, capacity]. */
    startLevel: number;
    /** Burn rate (units/s) at neutral throttle. */
    cruiseBurnRate: number;
    /** Burn rate at full boost. */
    boostBurnRate: number;
    /** Burn rate at full brake. */
    brakeBurnRate: number;
    /** Below this level the low-fuel warning is raised. */
    criticalThreshold: number;
    /** Refuel rate over a depot (units/s). */
    refuelRate: number;
}

export const DEFAULT_FUEL_CONFIG: Readonly<FuelConfig> = {
    capacity: 100,
    startLevel: 100,
    cruiseBurnRate: 2.2,
    boostBurnRate: 4.5,
    brakeBurnRate: 1.4,
    criticalThreshold: 20,
    refuelRate: 28,
};

export interface FuelInput {
    /** Effective throttle in [-1, 1]. */
    throttle: number;
    /** True while the jet overlaps an intact depot. */
    refueling: boolean;
}

/** What changed during one `update`, for audio/HUD/state-machine reactions. */
export interface FuelUpdate {
    readonly burned: number;
    readonly refueled: number;
    readonly enteredCritical: boolean;
    readonly leftCritical: boolean;
    /** The tank just hit zero. */
    readonly depleted: boolean;
    readonly refuelStarted: boolean;
    readonly refuelStopped: boolean;
}

const NO_CHANGE: FuelUpdate = {
    burned: 0,
    refueled: 0,
    enteredCritical: false,
    leftCritical: false,
    depleted: false,
    refuelStarted: false,
    refuelStopped: false,
};

function validateFuelConfig(c: FuelConfig): void {
    const fail = (message: string): never => {
        throw new RangeError(`Invalid FuelConfig: ${message}`);
    };
    for (const [name, value] of Object.entries(c)) {
        if (!Number.isFinite(value)) fail(`${name} must be finite.`);
    }
    if (c.capacity <= 0) fail('capacity must be positive.');
    if (c.startLevel < 0 || c.startLevel > c.capacity) fail('startLevel must be within [0, capacity].');
    if (c.cruiseBurnRate < 0 || c.boostBurnRate < 0 || c.brakeBurnRate < 0) fail('burn rates must be non-negative.');
    if (c.criticalThreshold < 0 || c.criticalThreshold > c.capacity) fail('criticalThreshold must be within [0, capacity].');
    if (c.refuelRate < 0) fail('refuelRate must be non-negative.');
}

/**
 * Fuel tank.
 *
 * Burn rate is piecewise linear in throttle through the three anchor points
 * (brake 1.4, cruise 2.2, boost 4.5 units/s by default), so it varies smoothly as the
 * jet's speed eases between throttle settings. Refuelling adds on top of the burn, so
 * the net change over a depot is `refuelRate - burnRate`.
 *
 * Empty tank (level 0) means no engine power; the jet then stalls and detonates (that
 * logic lives in `PlayerJet`, keyed off `isEmpty`).
 */
export class FuelSystem {
    readonly config: Readonly<FuelConfig>;
    private currentLevel: number;
    private refuelActive = false;
    private burnMultiplier = 1;

    constructor(config: Partial<FuelConfig> = {}) {
        this.config = { ...DEFAULT_FUEL_CONFIG, ...config };
        validateFuelConfig(this.config);
        this.currentLevel = this.config.startLevel;
    }

    get level(): number {
        return this.currentLevel;
    }

    get capacity(): number {
        return this.config.capacity;
    }

    /** Level as a fraction of capacity, in [0, 1]. */
    get fraction(): number {
        return this.currentLevel / this.config.capacity;
    }

    get percent(): number {
        return this.fraction * 100;
    }

    /** Low-fuel warning: level strictly below the critical threshold. */
    get isCritical(): boolean {
        return this.currentLevel < this.config.criticalThreshold;
    }

    get isEmpty(): boolean {
        return this.currentLevel <= 0;
    }

    get isFull(): boolean {
        return this.currentLevel >= this.config.capacity;
    }

    /** True while fuel is actually flowing in (on a depot with room in the tank). */
    get isRefueling(): boolean {
        return this.refuelActive;
    }

    /** The difficulty multiplier on every burn rate (1 = as configured). Refuelling is not scaled. */
    get burnScale(): number {
        return this.burnMultiplier;
    }

    /** Multiplies every burn rate by `k` from now on. Throws unless `k` is positive and finite. */
    setBurnScale(k: number): void {
        if (!Number.isFinite(k) || k <= 0) throw new RangeError('Fuel burn scale must be a positive finite number.');
        this.burnMultiplier = k;
    }

    /** Units burned per second at the given throttle in [-1, 1], including the difficulty multiplier. */
    burnRate(throttle: number): number {
        const c = this.config;
        const t = Number.isFinite(throttle) ? Math.max(-1, Math.min(1, throttle)) : 0;
        const base = t >= 0
            ? c.cruiseBurnRate + (c.boostBurnRate - c.cruiseBurnRate) * t
            : c.cruiseBurnRate + (c.brakeBurnRate - c.cruiseBurnRate) * -t;
        return base * this.burnMultiplier;
    }

    /** Burns and/or refuels for one step. Ignores non-positive or non-finite steps. */
    update(dt: number, input: FuelInput): FuelUpdate {
        if (!(dt > 0) || !Number.isFinite(dt)) return NO_CHANGE;
        const c = this.config;
        const before = this.currentLevel;
        const wasCritical = this.isCritical;
        const wasRefueling = this.refuelActive;

        const burned = this.burnRate(input.throttle) * dt;
        // A depot also offsets the burn on a full tank, so the level holds at capacity
        // instead of flickering between full and just-below-full every step.
        const wantsRefuel = input.refueling;
        const afterBurn = before - burned;
        const refueled = wantsRefuel ? Math.min(c.refuelRate * dt, Math.max(0, c.capacity - afterBurn)) : 0;

        this.currentLevel = Math.max(0, Math.min(c.capacity, afterBurn + refueled));
        this.refuelActive = wantsRefuel && this.currentLevel < c.capacity;

        return {
            burned: Math.min(burned, before),
            refueled,
            enteredCritical: !wasCritical && this.isCritical,
            leftCritical: wasCritical && !this.isCritical,
            depleted: before > 0 && this.currentLevel <= 0,
            refuelStarted: !wasRefueling && this.refuelActive,
            refuelStopped: wasRefueling && !this.refuelActive,
        };
    }

    /** Forces the refuelling flag off (e.g. the jet was destroyed). Returns whether it was on. */
    cancelRefuel(): boolean {
        const was = this.refuelActive;
        this.refuelActive = false;
        return was;
    }

    /** Sets the level directly (clamped). For respawns, cheats and tests. */
    setLevel(level: number): void {
        if (!Number.isFinite(level)) throw new RangeError('Fuel level must be finite.');
        this.currentLevel = Math.max(0, Math.min(this.config.capacity, level));
    }

    reset(): void {
        this.currentLevel = this.config.startLevel;
        this.refuelActive = false;
    }
}
