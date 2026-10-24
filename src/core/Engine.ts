import type { InputState } from './InputManager.js';
import type { RenderState } from '../rendering/RiverRenderer.js';
import { RiverGenerator, type RiverConfig } from '../world/RiverGenerator.js';
import { DEFAULT_SPEED_PROFILE, approachSpeed, computeTargetSpeed } from './Throttle.js';

// Kept here for Phase 2 callers; the implementation is shared with the jet and fuel systems.
export { computeTargetSpeed };

/** Anything that yields one input snapshot per call (InputManager satisfies this). */
export interface InputSource {
    update(): InputState;
}

/** The drawing side of the engine (RiverRenderer satisfies this). */
export interface FrameRenderer {
    setWorld(world: RiverGenerator): void;
    render(state: RenderState, alpha: number): void;
}

export interface EngineConfig {
    /** Fixed simulation step in seconds. */
    fixedDeltaTime: number;
    /** Longest frame the simulation will absorb (guards against tab-switch spikes). */
    maxFrameTime: number;
    /** Maximum fixed steps per rendered frame; any extra backlog is discarded. */
    maxStepsPerFrame: number;
    /** Scroll speed (world units per second) with a neutral throttle. */
    cruiseSpeed: number;
    /** Scroll speed at full brake (moveY = -1). */
    minSpeed: number;
    /** Scroll speed at full boost (moveY = +1). */
    maxSpeed: number;
    /** Speed gain, units/s^2. */
    acceleration: number;
    /** Speed loss, units/s^2. */
    deceleration: number;
    /** Height of the player line above the bottom of the view, in world units. */
    playerLineOffset: number;
    /** World units of already-scrolled river kept in the slice cache. */
    cacheBehind: number;
}

export const DEFAULT_ENGINE_CONFIG: Readonly<EngineConfig> = {
    fixedDeltaTime: 1 / 60,
    maxFrameTime: 0.25,
    maxStepsPerFrame: 8,
    ...DEFAULT_SPEED_PROFILE,
    // Screen Y ~540 of 720: the jet sits in the lower third of the view.
    playerLineOffset: 180,
    cacheBehind: 256,
};

/** Input as seen by one simulation tick. */
export interface TickInput extends InputState {
    /** Pause is handled by the engine itself, so this is always false in ticks. */
    pausePressed: false;
}

export interface TickContext {
    readonly deltaTime: number;
    /** Number of ticks completed including this one. */
    readonly tick: number;
    /** Simulation time in seconds after this tick. */
    readonly time: number;
    readonly cameraY: number;
    readonly scrollSpeed: number;
    readonly input: TickInput;
    readonly world: RiverGenerator;
}

export type TickListener = (context: TickContext) => void;

/** Called once per rendered frame, after drawing, with the engine's current stats. */
export type FrameListener = (stats: EngineStats) => void;

export interface EngineStats {
    fps: number;
    frameTimeMs: number;
    ticksPerSecond: number;
    tickCount: number;
    alpha: number;
    cameraY: number;
    /** World Y of the player line (where Phase 3 places the jet). */
    playerLineY: number;
    scrollSpeed: number;
    throttle: number;
    paused: boolean;
    running: boolean;
    seed: number;
    activeDevice: InputState['activeDevice'];
}

/** Everything a simulation sees for one fixed tick. */
export interface SimulationContext {
    readonly deltaTime: number;
    /** Number of ticks completed including this one. */
    readonly tick: number;
    /** Simulation time in seconds after this tick. */
    readonly time: number;
    /** Camera (bottom edge of the view, world units) before this tick. */
    readonly cameraY: number;
    readonly input: TickInput;
    readonly world: RiverGenerator;
    /** World distance from the bottom of the view up to the player's line. */
    readonly playerLineOffset: number;
}

/** What a simulation hands back: where the camera now is, and how fast it is scrolling. */
export interface SimulationResult {
    cameraY: number;
    /** World units per second (reported in the engine stats). */
    scrollSpeed: number;
    /** True when the camera jumped (respawn): the renderer must not interpolate across it. */
    cameraTeleported: boolean;
}

/**
 * Gameplay plugged into the engine's fixed step. With a simulation attached, the
 * simulation owns the camera (Phase 3: the camera follows the jet); without one, the
 * engine free-scrolls from the throttle alone (Phase 2).
 */
export interface Simulation {
    /** Starts a new run on `world`. Returns the initial camera Y. */
    reset(world: RiverGenerator, playerLineOffset: number): number;
    /** Advances one fixed step. */
    step(context: SimulationContext): SimulationResult;
}

export interface EngineOptions {
    seed: number;
    input: InputSource;
    renderer: FrameRenderer;
    riverConfig?: Partial<RiverConfig>;
    config?: Partial<EngineConfig>;
    simulation?: Simulation;
}

function validateEngineConfig(c: EngineConfig): void {
    const fail = (message: string): never => {
        throw new RangeError(`Invalid EngineConfig: ${message}`);
    };
    for (const [name, value] of Object.entries(c)) {
        if (!Number.isFinite(value)) fail(`${name} must be finite.`);
    }
    if (c.fixedDeltaTime <= 0) fail('fixedDeltaTime must be positive.');
    if (c.maxFrameTime < c.fixedDeltaTime) fail('maxFrameTime must be at least fixedDeltaTime.');
    if (!Number.isInteger(c.maxStepsPerFrame) || c.maxStepsPerFrame < 1) {
        fail('maxStepsPerFrame must be an integer >= 1.');
    }
    if (!(c.minSpeed >= 0 && c.minSpeed <= c.cruiseSpeed && c.cruiseSpeed <= c.maxSpeed)) {
        fail('speeds must satisfy 0 <= minSpeed <= cruiseSpeed <= maxSpeed.');
    }
    if (c.acceleration <= 0 || c.deceleration <= 0) fail('acceleration and deceleration must be positive.');
    if (c.playerLineOffset < 0 || c.cacheBehind < 0) fail('offsets must be non-negative.');
}

/**
 * Fixed-timestep engine host.
 *
 * Each display frame: poll input once, add the (clamped) frame time to an
 * accumulator, run as many fixed `fixedDeltaTime` ticks as fit, then draw once with
 * `alpha = accumulator / fixedDeltaTime` so the renderer can interpolate between the
 * last two simulation states. Simulation therefore behaves identically at 30, 60,
 * 144 or 240 Hz displays.
 *
 * Input contract: level controls (moveY) use the latest polled value for all ticks of
 * a frame. `firePressed` is latched until a tick consumes it, so a press is neither
 * lost on frames that run zero ticks (high refresh rates) nor repeated on frames that
 * run several. Pause is handled here and freezes the simulation, not the renderer.
 *
 * The engine does not own the InputSource: attach/destroy it yourself.
 */
export class Engine {
    readonly config: Readonly<EngineConfig>;

    private readonly input: InputSource;
    private readonly renderer: FrameRenderer;
    private readonly riverConfig: Partial<RiverConfig>;
    private readonly simulation: Simulation | null;
    private readonly listeners = new Set<TickListener>();
    private readonly frameListeners = new Set<FrameListener>();
    private currentWorld: RiverGenerator;

    private cameraY = 0;
    private previousCameraY = 0;
    private time = 0;
    private previousTime = 0;
    private speed: number;
    private throttle = 0;
    private tickCount = 0;
    private accumulator = 0;
    private alpha = 0;
    /** The player's own pause (Esc / P). */
    private userPaused = false;
    /** Open menus and the like, each freezing the simulation until it releases its hold. */
    private readonly pauseHolds = new Set<symbol>();
    /**
     * Set when the last hold is released: the very next frame ignores a pause press and a fire
     * press. The key that closes a menu (Esc, or Space / Enter on a screen's button) is also a game
     * key, and its press is latched by the input manager until the next frame, by which time the
     * hold is gone. Without this, closing the menu with Esc would leave the game paused, and
     * closing a screen with Enter would fire a missile (or restart a finished run).
     */
    private swallowEdges = false;
    private pendingFire = false;
    private lastInput: InputState = {
        moveX: 0, moveY: 0, fire: false, firePressed: false, pausePressed: false, activeDevice: 'keyboard',
    };

    private running = false;
    private rafId = 0;
    private lastTimestamp: number | null = null;

    private statsWindow = 0;
    private statsFrames = 0;
    private statsTicks = 0;
    private fps = 0;
    private ticksPerSecond = 0;
    private frameTimeMs = 0;

    constructor(options: EngineOptions) {
        this.config = { ...DEFAULT_ENGINE_CONFIG, ...options.config };
        validateEngineConfig(this.config);
        this.input = options.input;
        this.renderer = options.renderer;
        this.riverConfig = options.riverConfig ?? {};
        this.currentWorld = new RiverGenerator(options.seed, this.riverConfig);
        this.speed = this.config.cruiseSpeed;
        this.simulation = options.simulation ?? null;
        this.renderer.setWorld(this.currentWorld);
        if (this.simulation) {
            this.cameraY = this.simulation.reset(this.currentWorld, this.config.playerLineOffset);
            this.previousCameraY = this.cameraY;
        }
    }

    get world(): RiverGenerator {
        return this.currentWorld;
    }

    /** True while the simulation is frozen, by the player's pause or by a `holdPause` hold. */
    get isPaused(): boolean {
        return this.userPaused || this.pauseHolds.size > 0;
    }

    /** True only for the player's own pause (what the PAUSED banner is about). */
    get isUserPaused(): boolean {
        return this.userPaused;
    }

    /**
     * Freezes the simulation (rendering and audio carry on) until the returned function is
     * called. Holds stack: the game resumes when the last one is released, and a pause the
     * player made themselves is neither undone by a hold nor lost when it ends. While a hold is
     * active the pause key does nothing. Calling the release function again is harmless.
     */
    holdPause(): () => void {
        const hold = Symbol('pause-hold');
        this.pauseHolds.add(hold);
        return () => {
            if (this.pauseHolds.delete(hold) && this.pauseHolds.size === 0) this.swallowEdges = true;
        };
    }

    /** Subscribes to every simulation tick. Returns an unsubscribe function. */
    onTick(listener: TickListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * Subscribes to every rendered frame (after the draw). Unlike ticks, frames also run
     * while paused, which is what audio and other presentation code needs.
     * Returns an unsubscribe function.
     */
    onFrame(listener: FrameListener): () => void {
        this.frameListeners.add(listener);
        return () => {
            this.frameListeners.delete(listener);
        };
    }

    /** Restarts the run from the beginning of a (new) seed. */
    reset(seed: number): void {
        this.currentWorld = new RiverGenerator(seed, this.riverConfig);
        this.renderer.setWorld(this.currentWorld);
        this.cameraY = this.simulation ? this.simulation.reset(this.currentWorld, this.config.playerLineOffset) : 0;
        this.previousCameraY = this.cameraY;
        this.time = 0;
        this.previousTime = 0;
        this.speed = this.config.cruiseSpeed;
        this.throttle = 0;
        this.tickCount = 0;
        this.accumulator = 0;
        this.alpha = 0;
        this.userPaused = false; // holds belong to whoever took them, so a reset leaves them alone
        this.pendingFire = false;
    }

    start(): void {
        if (this.running) return;
        if (typeof requestAnimationFrame !== 'function') {
            throw new Error('Engine.start() requires requestAnimationFrame; use runFrame() headlessly.');
        }
        this.running = true;
        this.lastTimestamp = null;
        this.rafId = requestAnimationFrame(this.onAnimationFrame);
    }

    stop(): void {
        this.running = false;
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.rafId);
    }

    /** Stops the loop and drops listeners. Does not destroy the input or renderer. */
    destroy(): void {
        this.stop();
        this.listeners.clear();
        this.frameListeners.clear();
    }

    /**
     * Advances by one display frame of `frameTime` seconds: poll, simulate, render.
     * Driven by requestAnimationFrame in the browser; callable directly for tests.
     */
    runFrame(frameTime: number): void {
        const raw = Number.isFinite(frameTime) && frameTime > 0 ? frameTime : 0;
        this.recordStats(raw);

        const input = this.input.update();
        this.lastInput = input;
        const swallow = this.swallowEdges;
        this.swallowEdges = false; // only ever covers the one frame right after the release
        if (input.pausePressed && this.pauseHolds.size === 0 && !swallow) this.userPaused = !this.userPaused;
        const paused = this.isPaused;
        if (paused) this.pendingFire = false; // Presses made while paused are discarded.
        else if (input.firePressed && !swallow) this.pendingFire = true;
        this.throttle = input.moveY;

        const dt = this.config.fixedDeltaTime;
        if (!paused) {
            // While paused the accumulator is left untouched, so resuming is seamless.
            this.accumulator += Math.min(raw, this.config.maxFrameTime);
            let steps = 0;
            while (this.accumulator >= dt && steps < this.config.maxStepsPerFrame) {
                this.step(dt);
                this.accumulator -= dt;
                steps++;
            }
            if (this.accumulator >= dt) this.accumulator %= dt; // Drop unrecoverable backlog.
        }
        this.alpha = this.accumulator / dt;

        this.currentWorld.prune(this.cameraY - this.config.cacheBehind);
        this.renderer.render(
            {
                previousCameraY: this.previousCameraY,
                cameraY: this.cameraY,
                previousTime: this.previousTime,
                time: this.time,
                paused,
                userPaused: this.userPaused,
            },
            this.alpha,
        );
        if (this.frameListeners.size > 0) {
            const stats = this.getStats();
            for (const listener of this.frameListeners) listener(stats);
        }
    }

    getStats(): EngineStats {
        return {
            fps: this.fps,
            frameTimeMs: this.frameTimeMs,
            ticksPerSecond: this.ticksPerSecond,
            tickCount: this.tickCount,
            alpha: this.alpha,
            cameraY: this.cameraY,
            playerLineY: this.cameraY + this.config.playerLineOffset,
            scrollSpeed: this.speed,
            throttle: this.throttle,
            paused: this.isPaused,
            running: this.running,
            seed: this.currentWorld.seed,
            activeDevice: this.lastInput.activeDevice,
        };
    }

    // -------------------------------------------------------------- internals

    private readonly onAnimationFrame = (timestamp: number): void => {
        if (!this.running) return;
        this.rafId = requestAnimationFrame(this.onAnimationFrame);
        const elapsed = this.lastTimestamp === null ? 0 : (timestamp - this.lastTimestamp) / 1000;
        this.lastTimestamp = timestamp;
        this.runFrame(elapsed);
    };

    private step(dt: number): void {
        const c = this.config;
        this.previousCameraY = this.cameraY;
        this.previousTime = this.time;
        this.time += dt;
        this.tickCount++;
        this.statsTicks++;

        const input: TickInput = { ...this.lastInput, firePressed: this.pendingFire, pausePressed: false };
        this.pendingFire = false;

        if (this.simulation) {
            const result = this.simulation.step({
                deltaTime: dt,
                tick: this.tickCount,
                time: this.time,
                cameraY: this.cameraY,
                input,
                world: this.currentWorld,
                playerLineOffset: c.playerLineOffset,
            });
            if (!Number.isFinite(result.cameraY) || !Number.isFinite(result.scrollSpeed)) {
                throw new RangeError('Simulation.step returned a non-finite camera position or speed.');
            }
            // A teleport must not be interpolated across, or the view would sweep over the jump.
            if (result.cameraTeleported) this.previousCameraY = result.cameraY;
            this.cameraY = result.cameraY;
            this.speed = result.scrollSpeed;
        } else {
            this.speed = approachSpeed(this.speed, computeTargetSpeed(this.lastInput.moveY, c), dt, c);
            this.cameraY += this.speed * dt;
        }
        if (this.listeners.size > 0) {
            const context: TickContext = {
                deltaTime: dt,
                tick: this.tickCount,
                time: this.time,
                cameraY: this.cameraY,
                scrollSpeed: this.speed,
                input,
                world: this.currentWorld,
            };
            for (const listener of this.listeners) listener(context);
        }
    }

    private recordStats(rawFrameTime: number): void {
        this.frameTimeMs = this.frameTimeMs === 0
            ? rawFrameTime * 1000
            : this.frameTimeMs + (rawFrameTime * 1000 - this.frameTimeMs) * 0.1;
        this.statsFrames++;
        this.statsWindow += rawFrameTime;
        if (this.statsWindow >= 0.5) {
            this.fps = this.statsFrames / this.statsWindow;
            this.ticksPerSecond = this.statsTicks / this.statsWindow;
            this.statsWindow = 0;
            this.statsFrames = 0;
            this.statsTicks = 0;
        }
    }
}
