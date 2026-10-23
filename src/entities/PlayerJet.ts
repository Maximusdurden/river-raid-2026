import {
    DEFAULT_SPEED_PROFILE,
    approachSpeed,
    computeTargetSpeed,
    speedToThrottle,
    type SpeedProfile,
} from '../core/Throttle.js';
import type { Box } from '../systems/CollisionSystem.js';

export const JetState = {
    Alive: 'ALIVE',
    Refueling: 'REFUELING',
    Exploding: 'EXPLODING',
    Dead: 'DEAD',
} as const;
export type JetState = (typeof JetState)[keyof typeof JetState];

/** Why the jet was destroyed. Fuel deaths ignore invulnerability; crashes do not. */
export type DeathCause = 'land' | 'bridge' | 'enemy' | 'fuel';

export interface PlayerJetConfig extends SpeedProfile {
    /** Hitbox size. */
    width: number;
    height: number;
    /** The jet is kept inside [0, worldWidth]. */
    worldWidth: number;
    /** Top sideways speed (units/s). */
    maxLateralSpeed: number;
    /** Sideways acceleration while building speed (units/s^2). */
    lateralAcceleration: number;
    /** Sideways deceleration when easing off or reversing (units/s^2). */
    lateralDeceleration: number;
    /** Visual roll at full lateral speed. */
    maxRollDegrees: number;
    /** How quickly the roll chases its target (1/s; higher = snappier). */
    rollResponse: number;
    /** Respawn protection from crashes. */
    invulnerableSeconds: number;
    /** Time spent in EXPLODING before the jet is DEAD. */
    explosionDuration: number;
    /** Engine-out glide before a fuel detonation. */
    stallDuration: number;
    /** Forward speed lost per second while the engine is out. */
    stallDeceleration: number;
}

export const DEFAULT_JET_CONFIG: Readonly<PlayerJetConfig> = {
    ...DEFAULT_SPEED_PROFILE,
    width: 28,
    height: 20,
    worldWidth: 960,
    maxLateralSpeed: 380,
    lateralAcceleration: 2600,
    lateralDeceleration: 3400,
    maxRollDegrees: 20,
    rollResponse: 16,
    invulnerableSeconds: 3,
    explosionDuration: 1,
    stallDuration: 0.5,
    stallDeceleration: 260,
};

export interface JetInput {
    /** -1 (left) .. +1 (right). */
    moveX: number;
    /** -1 (brake) .. +1 (boost). */
    moveY: number;
    /** False while the tank is empty: controls are ignored and the jet glides. */
    enginePowered: boolean;
}

export interface JetSpawnOptions {
    /** Start with respawn protection (blinking). */
    invulnerable?: boolean;
}

const EPSILON = 1e-9;

function clampUnit(value: number): number {
    return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
}

function moveToward(value: number, target: number, maxDelta: number): number {
    const delta = target - value;
    return Math.abs(delta) <= maxDelta ? target : value + Math.sign(delta) * maxDelta;
}

function validateJetConfig(c: PlayerJetConfig): void {
    const fail = (message: string): never => {
        throw new RangeError(`Invalid PlayerJetConfig: ${message}`);
    };
    for (const [name, value] of Object.entries(c)) {
        if (!Number.isFinite(value)) fail(`${name} must be finite.`);
    }
    if (!(c.minSpeed >= 0 && c.minSpeed <= c.cruiseSpeed && c.cruiseSpeed <= c.maxSpeed)) {
        fail('speeds must satisfy 0 <= minSpeed <= cruiseSpeed <= maxSpeed.');
    }
    if (c.acceleration <= 0 || c.deceleration <= 0) fail('acceleration and deceleration must be positive.');
    if (c.width <= 0 || c.height <= 0 || c.worldWidth < c.width) fail('invalid size.');
    if (c.maxLateralSpeed <= 0 || c.lateralAcceleration <= 0 || c.lateralDeceleration <= 0) {
        fail('lateral limits must be positive.');
    }
    if (c.maxRollDegrees < 0 || c.maxRollDegrees > 80 || c.rollResponse <= 0) fail('invalid roll settings.');
    if (c.invulnerableSeconds < 0 || c.explosionDuration < 0 || c.stallDuration < 0 || c.stallDeceleration < 0) {
        fail('durations must be non-negative.');
    }
}

/**
 * The player's jet: lateral flight model, throttle-driven forward speed, and the
 * ALIVE / REFUELING / EXPLODING / DEAD state machine.
 *
 *   ALIVE <-> REFUELING   (setRefueling, driven by depot overlap)
 *   ALIVE | REFUELING -> EXPLODING   (destroy)
 *   EXPLODING -> DEAD     (after explosionDuration)
 *   DEAD -> ALIVE         (spawn, called by the game after the respawn delay)
 *
 * Forward motion is world-space: the camera is tied to the jet (camera = y - anchor),
 * so forward speed IS the scroll speed. The jet freezes while exploding or dead, which
 * stops the scroll.
 *
 * Public position fields are written only by `spawn` / `update` / `destroy`.
 */
export class PlayerJet {
    readonly config: Readonly<PlayerJetConfig>;

    x = 0;
    y = 0;
    previousX = 0;
    previousY = 0;
    /** Sideways velocity (units/s, + = right). */
    vx = 0;
    /** Forward speed = scroll speed (units/s). */
    speed: number;
    /** Visual bank angle in radians (+ = banking right). */
    roll = 0;
    previousRoll = 0;
    state: JetState = JetState.Alive;
    /** Seconds spent in the current EXPLODING / DEAD state. */
    stateTime = 0;
    invulnerableRemaining = 0;
    /** Seconds the engine has been out. */
    stallTime = 0;
    deathCause: DeathCause | null = null;

    private readonly maxRollRadians: number;

    constructor(config: Partial<PlayerJetConfig> = {}) {
        this.config = { ...DEFAULT_JET_CONFIG, ...config };
        validateJetConfig(this.config);
        this.maxRollRadians = (this.config.maxRollDegrees * Math.PI) / 180;
        this.speed = this.config.cruiseSpeed;
    }

    /** (Re)starts the jet ALIVE at the given world position, cruising straight. */
    spawn(x: number, y: number, options: JetSpawnOptions = {}): void {
        const half = this.config.width / 2;
        this.x = Math.max(half, Math.min(this.config.worldWidth - half, x));
        this.y = y;
        this.previousX = this.x;
        this.previousY = this.y;
        this.vx = 0;
        this.speed = this.config.cruiseSpeed;
        this.roll = 0;
        this.previousRoll = 0;
        this.state = JetState.Alive;
        this.stateTime = 0;
        this.stallTime = 0;
        this.deathCause = null;
        this.invulnerableRemaining = options.invulnerable ? this.config.invulnerableSeconds : 0;
    }

    /** Advances one fixed step. Ignores non-positive or non-finite steps. */
    update(dt: number, input: JetInput): void {
        if (!(dt > 0) || !Number.isFinite(dt)) return;
        this.previousX = this.x;
        this.previousY = this.y;
        this.previousRoll = this.roll;

        if (this.state === JetState.Exploding) {
            this.stateTime += dt;
            if (this.stateTime >= this.config.explosionDuration - EPSILON) {
                this.state = JetState.Dead;
                this.stateTime = 0;
            }
            return;
        }
        if (this.state === JetState.Dead) {
            this.stateTime += dt;
            return;
        }

        const c = this.config;
        this.invulnerableRemaining = Math.max(0, this.invulnerableRemaining - dt);
        // Many 1/60 s subtractions can leave a few ulps behind; snap so protection ends on time.
        if (this.invulnerableRemaining < EPSILON) this.invulnerableRemaining = 0;
        const stalled = !input.enginePowered;
        this.stallTime = stalled ? this.stallTime + dt : 0;
        const moveX = stalled ? 0 : clampUnit(input.moveX);
        const moveY = stalled ? 0 : clampUnit(input.moveY);

        // Sideways: quick to build speed, quicker to shed it (feels responsive, with a hint of inertia).
        const targetVx = moveX * c.maxLateralSpeed;
        const buildingSpeed = Math.abs(targetVx) > Math.abs(this.vx)
            && (this.vx === 0 || Math.sign(targetVx) === Math.sign(this.vx));
        this.vx = moveToward(this.vx, targetVx, (buildingSpeed ? c.lateralAcceleration : c.lateralDeceleration) * dt);

        // Forward: throttle sets the target speed; with the engine out the jet just coasts down.
        this.speed = stalled
            ? Math.max(0, this.speed - c.stallDeceleration * dt)
            : approachSpeed(this.speed, computeTargetSpeed(moveY, c), dt, c);

        const half = c.width / 2;
        this.x += this.vx * dt;
        if (this.x < half || this.x > c.worldWidth - half) {
            this.x = Math.max(half, Math.min(c.worldWidth - half, this.x));
            this.vx = 0;
        }
        this.y += this.speed * dt;

        // Bank follows the real sideways velocity, so the visual lags the input slightly.
        const targetRoll = (this.vx / c.maxLateralSpeed) * this.maxRollRadians;
        this.roll += (targetRoll - this.roll) * (1 - Math.exp(-c.rollResponse * dt));

        if (stalled && this.stallTime >= c.stallDuration - EPSILON) this.destroy('fuel');
    }

    /** Switches between ALIVE and REFUELING. Has no effect in any other state. */
    setRefueling(active: boolean): void {
        if (active && this.state === JetState.Alive) this.state = JetState.Refueling;
        else if (!active && this.state === JetState.Refueling) this.state = JetState.Alive;
    }

    /** Crashes are blocked by respawn protection; running out of fuel is not. */
    canBeDestroyedBy(cause: DeathCause): boolean {
        return this.isFlying && (cause === 'fuel' || this.invulnerableRemaining <= 0);
    }

    /** Starts the explosion. Returns false if the jet is already destroyed or protected. */
    destroy(cause: DeathCause): boolean {
        if (!this.canBeDestroyedBy(cause)) return false;
        this.state = JetState.Exploding;
        this.stateTime = 0;
        this.deathCause = cause;
        this.speed = 0;
        this.vx = 0;
        return true;
    }

    /** ALIVE or REFUELING: controllable, collidable, burning fuel. */
    get isFlying(): boolean {
        return this.state === JetState.Alive || this.state === JetState.Refueling;
    }

    get isInvulnerable(): boolean {
        return this.invulnerableRemaining > 0;
    }

    get isStalled(): boolean {
        return this.isFlying && this.stallTime > 0;
    }

    /** Effective throttle in [-1, 1], derived from the actual (smoothed) speed. */
    get throttleLevel(): number {
        return speedToThrottle(this.speed, this.config);
    }

    /** Largest visual roll, in radians. */
    get maxRoll(): number {
        return this.maxRollRadians;
    }

    get rollDegrees(): number {
        return (this.roll * 180) / Math.PI;
    }

    get hitbox(): Box {
        return { x: this.x, y: this.y, width: this.config.width, height: this.config.height };
    }
}
