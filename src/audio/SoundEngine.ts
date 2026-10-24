import { Mulberry32 } from '../core/PRNG.js';
import { STORAGE_KEYS, readItem, resolveStorage, writeItem, type KeyValueStorage } from '../core/Storage.js';
import type { GameEvent } from '../game/GameSession.js';

/**
 * Procedural sound for River Raid: everything is synthesised with the Web Audio API
 * (oscillators, filtered noise, gain envelopes). There are no audio files to load.
 *
 * Continuous sounds follow the game state and are updated every frame:
 *   - the engine drone, whose pitch, brightness and level follow the throttle;
 *   - the refuel chime, a pulsing ascending arpeggio while a depot is refuelling the jet;
 *   - the low-fuel klaxon, an urgent two-tone alarm below 20 units of fuel.
 * One-shot cues (`SoundCue`) are triggered by game events.
 *
 * Routing: every sound belongs to one of three channels, each with its own gain node, and
 * the channels mix into one compressor (which doubles as a limiter) and then the master
 * volume. Volume therefore comes last, so the limiter always sees the same signal whatever
 * the volume is set to.
 *
 *   sfx gain     -> compressor   weapons, explosions, fanfares, 1UP, refuel chime, respawn, game over
 *   drone gain   -> compressor   the engine drone
 *   warning gain -> compressor   the low-fuel klaxon
 *   compressor   -> master gain -> speakers
 *
 * A channel can be switched off at any time (`setSfxEnabled`, `setDroneEnabled`,
 * `setWarningsEnabled`): its gain fades to silence within a few milliseconds and nothing new
 * is scheduled for it. The channel settings, volume and mute are saved to localStorage.
 *
 * Browsers keep an AudioContext suspended until the user interacts with the page, so the
 * context is created and resumed on the first pointer press or key press (`attach`).
 * Until then every call is a safe no-op. `M` toggles mute from anywhere on the page
 * (except while typing in a field).
 */

export type SoundCue =
    | 'fire'
    | 'hit'
    | 'explosion-enemy'
    | 'explosion-depot'
    | 'explosion-jet'
    | 'explosion-bridge'
    | 'fanfare'
    | 'extra-life'
    | 'respawn'
    | 'game-over'
    | 'victory'
    | 'fighter-launch'
    /** The run made the Top 10. */
    | 'new-high-score'
    /** The run beat the all-time record: the grandest cue in the game. */
    | 'record-broken'
    /** One step of the initials picker (a letter cycles). */
    | 'menu-tick'
    /** A slot of the initials picker was confirmed. */
    | 'menu-select'
    /** The initials were saved. */
    | 'score-saved';

/** What the HUD shows: `locked` means sound is available but waiting for a first click or key press. */
export type AudioState = 'unsupported' | 'locked' | 'on' | 'muted';

export interface CueRequest {
    readonly cue: SoundCue;
    /** Seconds to wait before it starts. */
    readonly delay: number;
}

/** The slice of game state that drives the continuous sounds. */
export interface GameAudioState {
    /** Effective throttle in [-1, 1] (speed 90 / 220 / 420 maps to -1 / 0 / +1). */
    readonly throttle: number;
    /** The engine is running (jet flying with fuel). */
    readonly engineOn: boolean;
    readonly refueling: boolean;
    readonly lowFuel: boolean;
    /** The simulation is paused, or the run has ended: silence the drone and the alarms. */
    readonly paused: boolean;
}

/** Everything the player can set about the sound. Serialised as `riverraid.audio_settings`. */
export interface AudioChannelConfig {
    /** 0.0 to 1.0. */
    masterVolume: number;
    /** Silences everything, whatever the channels say. */
    muted: boolean;
    /** Weapons, explosions, bridge fanfares, 1UP chimes, the refuel chime and other cues. */
    sfxEnabled: boolean;
    /** The continuous engine drone. */
    droneEnabled: boolean;
    /** The low-fuel alarm. */
    warningsEnabled: boolean;
}

export const DEFAULT_AUDIO_CHANNELS: Readonly<AudioChannelConfig> = {
    masterVolume: 0.6,
    muted: false,
    sfxEnabled: true,
    droneEnabled: true,
    warningsEnabled: true,
};

/** Which of the three buses a sound goes through. */
export type AudioBus = 'sfx' | 'drone' | 'warning';

function pickBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

/** Turns anything (usually parsed JSON) into a valid config; bad fields keep their defaults. Never throws. */
export function sanitizeAudioSettings(raw: unknown, base: Readonly<AudioChannelConfig> = DEFAULT_AUDIO_CHANNELS): AudioChannelConfig {
    const record = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const volume = record.masterVolume;
    return {
        masterVolume: typeof volume === 'number' && Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : base.masterVolume,
        muted: pickBoolean(record.muted, base.muted),
        sfxEnabled: pickBoolean(record.sfxEnabled, base.sfxEnabled),
        droneEnabled: pickBoolean(record.droneEnabled, base.droneEnabled),
        warningsEnabled: pickBoolean(record.warningsEnabled, base.warningsEnabled),
    };
}

/**
 * Reads the saved audio settings. Missing or corrupt data gives the defaults. If there are
 * no new-style settings yet but Phase 4's separate volume and mute keys exist, those are
 * carried over.
 */
export function loadAudioSettings(storage: KeyValueStorage | null): AudioChannelConfig {
    const saved = readItem(storage, STORAGE_KEYS.audio);
    if (saved !== null) {
        try {
            return sanitizeAudioSettings(JSON.parse(saved) as unknown);
        } catch {
            return { ...DEFAULT_AUDIO_CHANNELS };
        }
    }
    const legacyVolume = readItem(storage, STORAGE_KEYS.legacyVolume);
    const legacyMuted = readItem(storage, STORAGE_KEYS.legacyMuted);
    if (legacyVolume === null && legacyMuted === null) return { ...DEFAULT_AUDIO_CHANNELS };
    const volume = legacyVolume === null || legacyVolume.trim() === '' ? NaN : Number(legacyVolume);
    return sanitizeAudioSettings({ masterVolume: volume, muted: legacyMuted === '1' });
}

export function serializeAudioSettings(config: Readonly<AudioChannelConfig>): string {
    return JSON.stringify({
        masterVolume: config.masterVolume,
        muted: config.muted,
        sfxEnabled: config.sfxEnabled,
        droneEnabled: config.droneEnabled,
        warningsEnabled: config.warningsEnabled,
    });
}

export interface SoundEngineOptions {
    /** Creates the AudioContext. Defaults to `window.AudioContext` / `webkitAudioContext`. */
    createContext?: () => AudioContext;
    /** Master volume in [0, 1]. Default 0.6. Overrides the saved value. */
    masterVolume?: number;
    /** Start muted. Overrides the saved value. */
    muted?: boolean;
    /** Channel switches (and anything else in the config). Override the saved values. */
    channels?: Partial<AudioChannelConfig>;
    /**
     * Where the settings are saved (`riverraid.audio_settings`). Omit to use the page's
     * `localStorage`; pass `null` to neither load nor save.
     */
    storage?: KeyValueStorage | null;
    /** Called whenever the mute flag or the context state changes. */
    onChange?: (state: AudioState) => void;
    /** Seed for the deterministic noise and variation. */
    seed?: number;
}

// --------------------------------------------------------------------- tuning

export const ENGINE_PITCH_HZ = { brake: 52, cruise: 88, boost: 196 } as const;
export const ENGINE_CUTOFF_HZ = { brake: 320, cruise: 680, boost: 2600 } as const;
export const ENGINE_LEVEL = { brake: 0.1, cruise: 0.15, boost: 0.21 } as const;

/** Refuel chime: C5 E5 G5 C6, then a rest, repeating. Zero is a rest. */
export const REFUEL_PATTERN_HZ: readonly number[] = [523.25, 659.25, 783.99, 1046.5, 0];
export const REFUEL_STEP_SECONDS = 0.085;

/** Low-fuel klaxon: two alternating tones, twice, then a pause. */
export const KLAXON_PATTERN_HZ: readonly number[] = [740, 988, 740, 988, 0, 0];
export const KLAXON_STEP_SECONDS = 0.15;

const LOOKAHEAD_SECONDS = 0.14;
const NOISE_SECONDS = 2.5;
/** Level of the effects channel when it is on. */
const SFX_LEVEL = 0.9;
/** Time constant of a channel switching on or off: fast enough to feel instant, slow enough not to click. */
const BUS_FADE_SECONDS = 0.015;

function clamp(value: number, min: number, max: number): number {
    return value < min ? min : value > max ? max : value;
}

function finiteThrottle(throttle: number): number {
    return Number.isFinite(throttle) ? clamp(throttle, -1, 1) : 0;
}

/** Engine pitch in Hz: drops to 52 on the brake, hums at 88 at cruise, screams to 196 at full boost. */
export function enginePitchHz(throttle: number): number {
    const t = finiteThrottle(throttle);
    return t >= 0
        ? ENGINE_PITCH_HZ.cruise + (ENGINE_PITCH_HZ.boost - ENGINE_PITCH_HZ.cruise) * t
        : ENGINE_PITCH_HZ.cruise + (ENGINE_PITCH_HZ.cruise - ENGINE_PITCH_HZ.brake) * t;
}

/** Low-pass cutoff in Hz: dull at the brake, wide open and bright at boost (interpolated in log space). */
export function engineCutoffHz(throttle: number): number {
    const t = finiteThrottle(throttle);
    return t >= 0
        ? ENGINE_CUTOFF_HZ.cruise * Math.pow(ENGINE_CUTOFF_HZ.boost / ENGINE_CUTOFF_HZ.cruise, t)
        : ENGINE_CUTOFF_HZ.cruise * Math.pow(ENGINE_CUTOFF_HZ.brake / ENGINE_CUTOFF_HZ.cruise, -t);
}

/** Drone loudness (linear gain) for a throttle value. */
export function engineLevel(throttle: number): number {
    const t = finiteThrottle(throttle);
    return t >= 0
        ? ENGINE_LEVEL.cruise + (ENGINE_LEVEL.boost - ENGINE_LEVEL.cruise) * t
        : ENGINE_LEVEL.cruise + (ENGINE_LEVEL.cruise - ENGINE_LEVEL.brake) * t;
}

export type ExplosionKind = 'enemy' | 'depot' | 'jet' | 'bridge';

export interface ExplosionSpec {
    /** Length of the noise burst in seconds. */
    readonly duration: number;
    /** Low-pass sweep: the burst starts bright and ends dark. */
    readonly lowpassFrom: number;
    readonly lowpassTo: number;
    /** Filter resonance. */
    readonly q: number;
    readonly peak: number;
    /** Optional sub-bass boom underneath the noise. */
    readonly boom?: { readonly from: number; readonly to: number; readonly duration: number; readonly peak: number };
}

/** Enemies and depots pop; the jet thuds; a bridge is a long, deep boom. */
export const EXPLOSION_SPECS: Readonly<Record<ExplosionKind, ExplosionSpec>> = {
    enemy: { duration: 0.42, lowpassFrom: 3000, lowpassTo: 300, q: 4, peak: 1.1 },
    depot: { duration: 0.75, lowpassFrom: 2000, lowpassTo: 140, q: 5, peak: 1.05, boom: { from: 120, to: 40, duration: 0.45, peak: 0.55 } },
    jet: { duration: 1.0, lowpassFrom: 1500, lowpassTo: 90, q: 6, peak: 1.05, boom: { from: 95, to: 32, duration: 0.8, peak: 0.7 } },
    bridge: { duration: 1.9, lowpassFrom: 1100, lowpassTo: 55, q: 8, peak: 1.2, boom: { from: 75, to: 24, duration: 1.5, peak: 0.95 } },
};

/** Which sounds a game event triggers. Pure, so it can be tested without any audio. */
export function cuesForEvent(event: GameEvent): readonly CueRequest[] {
    switch (event.type) {
        case 'fire':
            return [{ cue: 'fire', delay: 0 }];
        case 'enemy-destroyed':
            // A missile kill also gets the "hit" tick; ramming is just the crash.
            return event.rammed
                ? [{ cue: 'explosion-enemy', delay: 0 }]
                : [{ cue: 'hit', delay: 0 }, { cue: 'explosion-enemy', delay: 0.01 }];
        case 'depot-destroyed':
            return [{ cue: 'explosion-depot', delay: 0 }];
        case 'bridge-destroyed':
            return [{ cue: 'explosion-bridge', delay: 0 }, { cue: 'fanfare', delay: 0.45 }];
        case 'jet-destroyed':
            return [{ cue: 'explosion-jet', delay: 0 }];
        case 'extra-life':
            return [{ cue: 'extra-life', delay: 0.1 }];
        case 'respawn':
            return [{ cue: 'respawn', delay: 0 }];
        case 'game-over':
            return [{ cue: 'game-over', delay: 0.5 }];
        case 'victory':
            return [{ cue: 'victory', delay: 0.6 }];
        case 'fighter-launch':
            return [{ cue: 'fighter-launch', delay: 0 }];
        default:
            return [];
    }
}

interface ToneSpec {
    readonly type: OscillatorType;
    readonly freq: number;
    /** Optional glide target (exponential). */
    readonly endFreq?: number;
    readonly start: number;
    readonly duration: number;
    readonly peak: number;
    readonly attack?: number;
    /** Low-pass filter in front of the gain. */
    readonly filterHz?: number;
    readonly detune?: number;
    /** Which channel it belongs to. Default 'sfx'. */
    readonly bus?: AudioBus;
}

interface Graph {
    readonly master: GainNode;
    readonly compressor: DynamicsCompressorNode;
    readonly sfx: GainNode;
    readonly drone: GainNode;
    readonly warning: GainNode;
    readonly noise: AudioBuffer;
    readonly saw: OscillatorNode;
    readonly triangle: OscillatorNode;
    readonly lfo: OscillatorNode;
    readonly lfoDepth: GainNode;
    readonly filter: BiquadFilterNode;
    readonly engineGain: GainNode;
}

function defaultContextFactory(): (() => AudioContext) | null {
    const scope = globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext };
    const Ctor = typeof AudioContext !== 'undefined' ? AudioContext : scope.webkitAudioContext;
    return Ctor ? () => new Ctor() : null;
}

function isEditable(target: EventTarget | null): boolean {
    if (!target || !('nodeType' in target) || (target as Node).nodeType !== 1) return false;
    const element = target as HTMLElement;
    return element.isContentEditable || element.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null;
}

export class SoundEngine {
    private readonly factory: (() => AudioContext) | null;
    private readonly onChange: ((state: AudioState) => void) | undefined;
    private readonly seed: number;
    private readonly storage: KeyValueStorage | null;
    private volume: number;
    private isMuted: boolean;
    private sfxOn: boolean;
    private droneOn: boolean;
    private warningsOn: boolean;
    private readonly settingsListeners = new Set<(config: Readonly<AudioChannelConfig>) => void>();

    private ctx: AudioContext | null = null;
    private graph: Graph | null = null;
    private rng: Mulberry32;

    private host: Window | null = null;
    private suspendedByUs = false;

    // Continuous-sound state.
    private throttle = 0;
    private engineOn = false;
    private refueling = false;
    private lowFuel = false;
    private paused = false;
    private refuelNext = 0;
    private refuelStep = 0;
    private klaxonNext = 0;
    private klaxonStep = 0;
    private lastApplied = { pitch: NaN, cutoff: NaN, level: NaN };
    private readonly cueLog: SoundCue[] = [];

    constructor(options: SoundEngineOptions = {}) {
        this.factory = options.createContext ?? defaultContextFactory();
        this.onChange = options.onChange;
        this.seed = options.seed ?? 0x50d5eed;
        this.rng = new Mulberry32(this.seed);
        this.storage = resolveStorage(options.storage);
        // Saved settings first, then whatever the caller insisted on.
        const stored = loadAudioSettings(this.storage);
        const explicit: Partial<AudioChannelConfig> = { ...options.channels };
        if (options.masterVolume !== undefined) explicit.masterVolume = options.masterVolume;
        if (options.muted !== undefined) explicit.muted = options.muted;
        const config = sanitizeAudioSettings(explicit, stored);
        this.volume = config.masterVolume;
        this.isMuted = config.muted;
        this.sfxOn = config.sfxEnabled;
        this.droneOn = config.droneEnabled;
        this.warningsOn = config.warningsEnabled;
    }

    // ------------------------------------------------------------- read model

    get muted(): boolean {
        return this.isMuted;
    }

    get masterVolume(): number {
        return this.volume;
    }

    get sfxEnabled(): boolean {
        return this.sfxOn;
    }

    get droneEnabled(): boolean {
        return this.droneOn;
    }

    get warningsEnabled(): boolean {
        return this.warningsOn;
    }

    /** A copy of every setting (volume, mute and the three channel switches). */
    get channels(): AudioChannelConfig {
        return {
            masterVolume: this.volume,
            muted: this.isMuted,
            sfxEnabled: this.sfxOn,
            droneEnabled: this.droneOn,
            warningsEnabled: this.warningsOn,
        };
    }

    get state(): AudioState {
        if (!this.factory) return 'unsupported';
        if (this.isMuted) return 'muted';
        return this.ctx && this.ctx.state === 'running' ? 'on' : 'locked';
    }

    /** The audio context, once it has been created (after the first user gesture). */
    get context(): AudioContext | null {
        return this.ctx;
    }

    /** The most recent cues that were actually played (newest last, at most 64). For tests and debugging. */
    get recentCues(): readonly SoundCue[] {
        return this.cueLog;
    }

    // --------------------------------------------------------------- lifecycle

    /**
     * Listens for the first pointer press or key press (to unlock audio) and for `M`
     * (to mute). Safe to call again: it re-attaches to the new window.
     */
    attach(host: Window = window): void {
        this.detach();
        this.host = host;
        host.addEventListener('pointerdown', this.onPointerDown, true);
        host.addEventListener('keydown', this.onKeyDown, true);
        host.document.addEventListener('visibilitychange', this.onVisibility);
    }

    detach(): void {
        const host = this.host;
        if (!host) return;
        host.removeEventListener('pointerdown', this.onPointerDown, true);
        host.removeEventListener('keydown', this.onKeyDown, true);
        host.document.removeEventListener('visibilitychange', this.onVisibility);
        this.host = null;
    }

    /**
     * Creates the audio context if needed and asks the browser to start it. Must be called
     * from a user gesture to succeed in browsers that block autoplay. Resolves to whether
     * sound is now running.
     */
    async unlock(): Promise<boolean> {
        if (!this.factory) return false;
        const ctx = this.ensureContext();
        if (!ctx) return false;
        if (ctx.state === 'suspended') {
            try {
                await ctx.resume();
            } catch {
                return false;
            }
        }
        this.suspendedByUs = false;
        this.notify();
        return ctx.state === 'running';
    }

    /** Stops everything and releases the audio context. The engine can be unlocked again later. */
    async destroy(): Promise<void> {
        this.detach();
        const graph = this.graph;
        const ctx = this.ctx;
        this.graph = null;
        this.ctx = null;
        if (graph) {
            for (const osc of [graph.saw, graph.triangle, graph.lfo]) {
                try {
                    osc.stop();
                } catch {
                    // Already stopped.
                }
            }
        }
        if (ctx) {
            ctx.onstatechange = null;
            try {
                await ctx.close();
            } catch {
                // Already closed.
            }
        }
        this.refuelNext = 0;
        this.klaxonNext = 0;
        this.lastApplied = { pitch: NaN, cutoff: NaN, level: NaN };
    }

    // ------------------------------------------------------------ mute / volume

    setMuted(muted: boolean): void {
        if (this.isMuted === muted) return;
        this.isMuted = muted;
        this.applyMaster();
        if (muted) {
            this.refuelNext = 0;
            this.klaxonNext = 0;
        }
        this.settingsChanged();
        this.notify();
    }

    toggleMute(): boolean {
        this.setMuted(!this.isMuted);
        return this.isMuted;
    }

    setMasterVolume(volume: number): void {
        if (!Number.isFinite(volume)) return;
        const next = clamp(volume, 0, 1);
        if (next === this.volume) return;
        this.volume = next;
        this.applyMaster();
        this.settingsChanged();
    }

    /** Weapons, explosions, fanfares, 1UP and other cues. Takes effect immediately. */
    setSfxEnabled(enabled: boolean): void {
        if (this.sfxOn === enabled) return;
        this.sfxOn = enabled;
        if (!enabled) this.refuelNext = 0;
        this.applyBuses();
        this.settingsChanged();
    }

    /** The continuous engine drone. Takes effect immediately. */
    setDroneEnabled(enabled: boolean): void {
        if (this.droneOn === enabled) return;
        this.droneOn = enabled;
        this.applyBuses();
        this.settingsChanged();
    }

    /** The low-fuel klaxon. Takes effect immediately. */
    setWarningsEnabled(enabled: boolean): void {
        if (this.warningsOn === enabled) return;
        this.warningsOn = enabled;
        if (!enabled) this.klaxonNext = 0;
        this.applyBuses();
        this.settingsChanged();
    }

    /** Calls `listener` after any change to volume, mute or a channel switch. Returns an unsubscribe function. */
    subscribe(listener: (config: Readonly<AudioChannelConfig>) => void): () => void {
        this.settingsListeners.add(listener);
        return () => {
            this.settingsListeners.delete(listener);
        };
    }

    private settingsChanged(): void {
        writeItem(this.storage, STORAGE_KEYS.audio, serializeAudioSettings(this.channels));
        const snapshot = this.channels;
        for (const listener of this.settingsListeners) listener(snapshot);
    }

    // ------------------------------------------------------ continuous sounds

    /** Feeds the game state to the drone and the alarms, then schedules whatever is due. Call every frame. */
    syncGame(game: GameAudioState): void {
        this.throttle = finiteThrottle(game.throttle);
        this.engineOn = game.engineOn;
        this.refueling = game.refueling;
        this.lowFuel = game.lowFuel;
        this.paused = game.paused;
        this.applyEngine();
        this.update();
    }

    /** Schedules the refuel arpeggio and the klaxon a little ahead of the audio clock. */
    update(): void {
        const ctx = this.ctx;
        if (!ctx || !this.graph) return;
        if (ctx.state !== 'running' || this.isMuted || this.paused) {
            // Restart both patterns from their first note when they next become due.
            this.refuelNext = 0;
            this.klaxonNext = 0;
            return;
        }
        const now = ctx.currentTime;
        const horizon = now + LOOKAHEAD_SECONDS;

        if (this.refueling && this.sfxOn) {
            if (this.refuelNext < now) {
                this.refuelNext = now;
                this.refuelStep = 0;
            }
            while (this.refuelNext < horizon) {
                const freq = REFUEL_PATTERN_HZ[this.refuelStep % REFUEL_PATTERN_HZ.length] ?? 0;
                if (freq > 0) this.chimeNote(freq, this.refuelNext);
                this.refuelNext += REFUEL_STEP_SECONDS;
                this.refuelStep++;
            }
        } else {
            this.refuelNext = 0;
        }

        if (this.lowFuel && this.warningsOn) {
            if (this.klaxonNext < now) {
                this.klaxonNext = now;
                this.klaxonStep = 0;
            }
            while (this.klaxonNext < horizon) {
                const freq = KLAXON_PATTERN_HZ[this.klaxonStep % KLAXON_PATTERN_HZ.length] ?? 0;
                if (freq > 0) this.klaxonNote(freq, this.klaxonNext);
                this.klaxonNext += KLAXON_STEP_SECONDS;
                this.klaxonStep++;
            }
        } else {
            this.klaxonNext = 0;
        }
    }

    // ---------------------------------------------------------------- one-shots

    /** Plays the sounds a game event calls for. */
    handleEvent(event: GameEvent): void {
        for (const request of cuesForEvent(event)) this.play(request.cue, request.delay);
    }

    /** Plays one cue. Returns false if nothing was played (muted, effects off, locked, or no audio). */
    play(cue: SoundCue, delay = 0): boolean {
        const ctx = this.ctx;
        if (!ctx || !this.graph || this.isMuted || !this.sfxOn || ctx.state !== 'running') return false;
        const t = ctx.currentTime + Math.max(0, Number.isFinite(delay) ? delay : 0);
        switch (cue) {
            case 'fire': this.playFire(t); break;
            case 'hit': this.playHit(t); break;
            case 'explosion-enemy': this.playExplosion(EXPLOSION_SPECS.enemy, t); break;
            case 'explosion-depot': this.playExplosion(EXPLOSION_SPECS.depot, t); break;
            case 'explosion-jet': this.playExplosion(EXPLOSION_SPECS.jet, t); break;
            case 'explosion-bridge': this.playExplosion(EXPLOSION_SPECS.bridge, t); break;
            case 'fanfare': this.playFanfare(t, false); break;
            case 'victory': this.playFanfare(t, true); break;
            case 'extra-life': this.playExtraLife(t); break;
            case 'respawn': this.playRespawn(t); break;
            case 'game-over': this.playGameOver(t); break;
            case 'fighter-launch': this.playWhoosh(t); break;
            case 'new-high-score': this.playNewHighScore(t); break;
            case 'record-broken': this.playRecordBroken(t); break;
            case 'menu-tick': this.playMenuTick(t); break;
            case 'menu-select': this.playMenuSelect(t); break;
            case 'score-saved': this.playScoreSaved(t); break;
        }
        this.cueLog.push(cue);
        if (this.cueLog.length > 64) this.cueLog.shift();
        return true;
    }

    // --------------------------------------------------------------- internals

    private readonly onPointerDown = (): void => {
        void this.unlock();
    };

    private readonly onKeyDown = (event: KeyboardEvent): void => {
        if (event.code === 'KeyM' && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey && !isEditable(event.target)) {
            this.toggleMute();
        }
        // Any key counts as a gesture. Modifier-only presses do not unlock audio in some browsers, which is harmless.
        void this.unlock();
    };

    private readonly onVisibility = (): void => {
        const ctx = this.ctx;
        const doc = this.host?.document;
        if (!ctx || !doc) return;
        if (doc.hidden && ctx.state === 'running') {
            this.suspendedByUs = true;
            void ctx.suspend();
        } else if (!doc.hidden && this.suspendedByUs) {
            this.suspendedByUs = false;
            void ctx.resume();
        }
    };

    private notify(): void {
        this.onChange?.(this.state);
    }

    private ensureContext(): AudioContext | null {
        if (this.ctx) return this.ctx;
        if (!this.factory) return null;
        let ctx: AudioContext;
        try {
            ctx = this.factory();
        } catch {
            return null;
        }
        this.ctx = ctx;
        ctx.onstatechange = () => this.notify();
        this.graph = this.build(ctx);
        this.applyMaster();
        this.applyBuses();
        this.applyEngine();
        return ctx;
    }

    private build(ctx: AudioContext): Graph {
        const master = ctx.createGain();
        master.gain.value = this.isMuted ? 0 : this.volume;
        // Doubles as a limiter: the biggest blasts must not clip even with the volume at 100%.
        const compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = -20;
        compressor.knee.value = 6;
        compressor.ratio.value = 14;
        compressor.attack.value = 0.002;
        compressor.release.value = 0.22;
        compressor.connect(master);
        master.connect(ctx.destination);

        // One gain node per channel, each feeding the compressor.
        const sfx = ctx.createGain();
        sfx.gain.value = this.sfxOn ? SFX_LEVEL : 0;
        sfx.connect(compressor);
        const drone = ctx.createGain();
        drone.gain.value = this.droneOn ? 1 : 0;
        drone.connect(compressor);
        const warning = ctx.createGain();
        warning.gain.value = this.warningsOn ? 1 : 0;
        warning.connect(compressor);

        // Engine: a sawtooth plus a triangle an octave down, through a resonant low-pass,
        // with a slow vibrato whose depth grows with the throttle.
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.Q.value = 3.2;
        filter.frequency.value = ENGINE_CUTOFF_HZ.cruise;
        const engineGain = ctx.createGain();
        engineGain.gain.value = 0;
        const saw = ctx.createOscillator();
        saw.type = 'sawtooth';
        saw.frequency.value = ENGINE_PITCH_HZ.cruise;
        const triangle = ctx.createOscillator();
        triangle.type = 'triangle';
        triangle.frequency.value = ENGINE_PITCH_HZ.cruise / 2;
        const triangleGain = ctx.createGain();
        triangleGain.gain.value = 0.7;
        const lfo = ctx.createOscillator();
        lfo.type = 'sine';
        lfo.frequency.value = 6;
        const lfoDepth = ctx.createGain();
        lfoDepth.gain.value = 10;
        lfo.connect(lfoDepth);
        lfoDepth.connect(saw.detune);
        lfoDepth.connect(triangle.detune);
        saw.connect(filter);
        triangle.connect(triangleGain);
        triangleGain.connect(filter);
        filter.connect(engineGain);
        engineGain.connect(drone);
        saw.start();
        triangle.start();
        lfo.start();

        return { master, compressor, sfx, drone, warning, noise: this.makeNoise(ctx), saw, triangle, lfo, lfoDepth, filter, engineGain };
    }

    /** Pink-ish noise (Paul Kellet's filter) from the seeded generator, so it is reproducible. */
    private makeNoise(ctx: AudioContext): AudioBuffer {
        const length = Math.max(1, Math.floor(ctx.sampleRate * NOISE_SECONDS));
        const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        const r = new Mulberry32(this.seed ^ 0x9e3779b9);
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        for (let i = 0; i < length; i++) {
            const white = r.next() * 2 - 1;
            b0 = 0.99886 * b0 + white * 0.0555179;
            b1 = 0.99332 * b1 + white * 0.0750759;
            b2 = 0.969 * b2 + white * 0.153852;
            b3 = 0.8665 * b3 + white * 0.3104856;
            b4 = 0.55 * b4 + white * 0.5329522;
            b5 = -0.7616 * b5 - white * 0.016898;
            data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
            b6 = white * 0.115926;
        }
        return buffer;
    }

    private applyMaster(): void {
        const graph = this.graph;
        const ctx = this.ctx;
        if (!graph || !ctx) return;
        graph.master.gain.setTargetAtTime(this.isMuted ? 0 : this.volume, ctx.currentTime, 0.02);
    }

    /** Fades each channel to its switch (on = its level, off = silence). */
    private applyBuses(): void {
        const graph = this.graph;
        const ctx = this.ctx;
        if (!graph || !ctx) return;
        const now = ctx.currentTime;
        graph.sfx.gain.setTargetAtTime(this.sfxOn ? SFX_LEVEL : 0, now, BUS_FADE_SECONDS);
        graph.drone.gain.setTargetAtTime(this.droneOn ? 1 : 0, now, BUS_FADE_SECONDS);
        graph.warning.gain.setTargetAtTime(this.warningsOn ? 1 : 0, now, BUS_FADE_SECONDS);
    }

    private applyEngine(): void {
        const graph = this.graph;
        const ctx = this.ctx;
        if (!graph || !ctx) return;
        const now = ctx.currentTime;
        const on = this.engineOn && !this.paused;
        const pitch = enginePitchHz(this.throttle);
        const cutoff = engineCutoffHz(this.throttle);
        const level = on ? engineLevel(this.throttle) : 0;
        const last = this.lastApplied;
        if (!(Math.abs(pitch - last.pitch) < 0.05) || !(Math.abs(cutoff - last.cutoff) < 1)) {
            graph.saw.frequency.setTargetAtTime(pitch, now, 0.08);
            graph.triangle.frequency.setTargetAtTime(pitch / 2, now, 0.08);
            graph.filter.frequency.setTargetAtTime(cutoff, now, 0.08);
            const boost = Math.max(0, this.throttle);
            graph.lfoDepth.gain.setTargetAtTime(8 + 24 * boost, now, 0.1);
            graph.lfo.frequency.setTargetAtTime(5 + 5 * ((this.throttle + 1) / 2), now, 0.1);
            this.lastApplied = { pitch, cutoff, level: last.level };
        }
        if (!(Math.abs(level - last.level) < 0.002)) {
            graph.engineGain.gain.setTargetAtTime(level, now, on ? 0.08 : 0.2);
            this.lastApplied = { ...this.lastApplied, level };
        }
    }

    private tone(spec: ToneSpec): void {
        const ctx = this.ctx;
        const graph = this.graph;
        if (!ctx || !graph) return;
        const osc = ctx.createOscillator();
        osc.type = spec.type;
        osc.frequency.setValueAtTime(spec.freq, spec.start);
        if (spec.endFreq !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, spec.endFreq), spec.start + spec.duration);
        if (spec.detune) osc.detune.value = spec.detune;
        const gain = ctx.createGain();
        const attack = spec.attack ?? 0.008;
        gain.gain.setValueAtTime(0.0001, spec.start);
        gain.gain.linearRampToValueAtTime(spec.peak, spec.start + attack);
        gain.gain.exponentialRampToValueAtTime(0.0001, spec.start + spec.duration);
        let tail: AudioNode = osc;
        if (spec.filterHz !== undefined) {
            const filter = ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = spec.filterHz;
            osc.connect(filter);
            tail = filter;
        }
        tail.connect(gain);
        gain.connect(spec.bus === 'warning' ? graph.warning : graph.sfx);
        osc.start(spec.start);
        osc.stop(spec.start + spec.duration + 0.05);
        osc.onended = () => {
            osc.disconnect();
            gain.disconnect();
        };
    }

    /** A burst of shaped noise: gain envelope, optionally a swept filter. */
    private noiseBurst(start: number, duration: number, peak: number, filter: { type: BiquadFilterType; from: number; to: number; q: number }): void {
        const ctx = this.ctx;
        const graph = this.graph;
        if (!ctx || !graph) return;
        const src = ctx.createBufferSource();
        src.buffer = graph.noise;
        const biquad = ctx.createBiquadFilter();
        biquad.type = filter.type;
        biquad.Q.value = filter.q;
        biquad.frequency.setValueAtTime(filter.from, start);
        biquad.frequency.exponentialRampToValueAtTime(Math.max(1, filter.to), start + duration);
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.linearRampToValueAtTime(peak, start + Math.min(0.012, duration / 4));
        gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
        src.connect(biquad);
        biquad.connect(gain);
        gain.connect(graph.sfx);
        const offset = this.rng.range(0, Math.max(0, NOISE_SECONDS - duration - 0.1));
        src.start(start, offset, duration + 0.05);
        src.onended = () => {
            src.disconnect();
            biquad.disconnect();
            gain.disconnect();
        };
    }

    private playFire(t: number): void {
        // A punchy downward chirp with a click of noise on the front.
        this.tone({ type: 'square', freq: 1150, endFreq: 120, start: t, duration: 0.14, peak: 0.2, attack: 0.002, filterHz: 4200 });
        this.tone({ type: 'sawtooth', freq: 420, endFreq: 70, start: t, duration: 0.1, peak: 0.12, attack: 0.002 });
        this.noiseBurst(t, 0.04, 0.16, { type: 'highpass', from: 2500, to: 5200, q: 0.7 });
    }

    private playHit(t: number): void {
        this.tone({ type: 'triangle', freq: 1500, endFreq: 640, start: t, duration: 0.06, peak: 0.2, attack: 0.001 });
    }

    private playExplosion(spec: ExplosionSpec, t: number): void {
        this.noiseBurst(t, spec.duration, spec.peak, { type: 'lowpass', from: spec.lowpassFrom, to: spec.lowpassTo, q: spec.q });
        if (spec.boom) {
            const boom = spec.boom;
            this.tone({ type: 'sine', freq: boom.from, endFreq: boom.to, start: t, duration: boom.duration, peak: boom.peak, attack: 0.006 });
        }
        if (spec.duration > 1) {
            // Debris crackle trailing off a big blast.
            this.noiseBurst(t + 0.3, spec.duration * 0.7, spec.peak * 0.25, { type: 'bandpass', from: 2600, to: 700, q: 1.2 });
        }
    }

    private chord(freqs: readonly number[], start: number, duration: number, peak: number, type: OscillatorType = 'sawtooth'): void {
        for (let i = 0; i < freqs.length; i++) {
            const freq = freqs[i] ?? 0;
            this.tone({ type, freq, start, duration, peak: peak / Math.sqrt(freqs.length), attack: 0.012, filterHz: 3200, detune: i % 2 === 0 ? -6 : 6 });
        }
    }

    /** A rising IV - V - I cadence with a bass root: unmistakably "you did it". */
    private playFanfare(t: number, grand: boolean): void {
        this.chord([349.23, 440.0, 523.25], t, 0.2, 0.34);
        this.chord([392.0, 493.88, 587.33], t + 0.17, 0.2, 0.36);
        this.chord([523.25, 659.25, 783.99, 1046.5], t + 0.34, grand ? 1.5 : 1.0, 0.44);
        this.tone({ type: 'triangle', freq: 130.81, start: t + 0.34, duration: grand ? 1.5 : 1.0, peak: 0.3, attack: 0.02 });
        this.tone({ type: 'sine', freq: 87.31, start: t, duration: 0.33, peak: 0.22, attack: 0.01 });
        if (grand) {
            this.chord([659.25, 783.99, 987.77, 1318.5], t + 0.9, 1.4, 0.4, 'square');
            this.tone({ type: 'triangle', freq: 196.0, start: t + 0.9, duration: 1.4, peak: 0.26, attack: 0.02 });
        }
    }

    private playExtraLife(t: number): void {
        const notes = [1046.5, 1318.5, 1568.0, 2093.0];
        for (let i = 0; i < notes.length; i++) {
            this.tone({ type: 'sine', freq: notes[i] ?? 1000, start: t + i * 0.075, duration: i === notes.length - 1 ? 0.5 : 0.16, peak: 0.2, attack: 0.004 });
        }
        this.tone({ type: 'triangle', freq: 523.25, start: t, duration: 0.45, peak: 0.12 });
    }

    /** The bridge fanfare with a rising run of chimes on top: you are on the board. */
    private playNewHighScore(t: number): void {
        this.playFanfare(t, false);
        this.playExtraLife(t + 0.55);
    }

    /**
     * The all-time record: the grand victory fanfare, then the extra-life arpeggio three times, each a
     * little higher than the last, over a shimmer of square-wave chords.
     */
    private playRecordBroken(t: number): void {
        this.playFanfare(t, true);
        this.playExtraLife(t + 0.55);
        this.playExtraLife(t + 1.2);
        this.playExtraLife(t + 1.85);
        this.chord([1046.5, 1318.5, 1568.0, 2093.0], t + 2.2, 1.1, 0.3, 'square');
        this.tone({ type: 'triangle', freq: 261.63, start: t + 2.2, duration: 1.1, peak: 0.24, attack: 0.02 });
    }

    private playMenuTick(t: number): void {
        this.tone({ type: 'square', freq: 1320, endFreq: 990, start: t, duration: 0.035, peak: 0.1, attack: 0.001, filterHz: 3600 });
    }

    private playMenuSelect(t: number): void {
        this.tone({ type: 'triangle', freq: 660, endFreq: 1100, start: t, duration: 0.09, peak: 0.2, attack: 0.002 });
    }

    /** A bright four-note chime that settles on a chord: saved. */
    private playScoreSaved(t: number): void {
        const notes = [783.99, 987.77, 1174.66, 1567.98];
        for (let i = 0; i < notes.length; i++) {
            this.tone({ type: 'triangle', freq: notes[i] ?? 800, start: t + i * 0.065, duration: 0.14, peak: 0.2, attack: 0.003 });
        }
        this.chord([523.25, 659.25, 783.99], t + 0.28, 0.5, 0.26, 'triangle');
    }

    private playRespawn(t: number): void {
        const notes = [440, 660, 880];
        for (let i = 0; i < notes.length; i++) {
            this.tone({ type: 'square', freq: notes[i] ?? 440, start: t + i * 0.07, duration: 0.09, peak: 0.1, attack: 0.003, filterHz: 3000 });
        }
    }

    private playGameOver(t: number): void {
        const notes = [392.0, 349.23, 311.13, 261.63];
        for (let i = 0; i < notes.length; i++) {
            this.tone({ type: 'triangle', freq: notes[i] ?? 300, start: t + i * 0.3, duration: 0.34, peak: 0.28, attack: 0.01 });
        }
        this.tone({ type: 'sawtooth', freq: 130.81, endFreq: 98.0, start: t + 1.2, duration: 1.3, peak: 0.2, attack: 0.03, filterHz: 700 });
    }

    private playWhoosh(t: number): void {
        this.noiseBurst(t, 0.7, 0.3, { type: 'bandpass', from: 500, to: 3600, q: 2.2 });
        this.tone({ type: 'sawtooth', freq: 180, endFreq: 760, start: t, duration: 0.6, peak: 0.08, attack: 0.05, filterHz: 1800 });
    }

    private chimeNote(freq: number, start: number): void {
        this.tone({ type: 'sine', freq, start, duration: 0.11, peak: 0.13, attack: 0.004 });
        this.tone({ type: 'triangle', freq: freq * 2, start, duration: 0.07, peak: 0.04, attack: 0.003 });
    }

    private klaxonNote(freq: number, start: number): void {
        this.tone({ type: 'square', freq, start, duration: KLAXON_STEP_SECONDS * 0.92, peak: 0.1, attack: 0.006, filterHz: 2200, bus: 'warning' });
    }
}
