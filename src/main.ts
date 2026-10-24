import { SoundEngine } from './audio/SoundEngine.js';
import { Engine } from './core/Engine.js';
import { resolveDisplayFlags } from './core/DisplayFlags.js';
import { InputManager } from './core/InputManager.js';
import { parseSeed, randomSeed } from './core/PRNG.js';
import { defaultStorage } from './core/Storage.js';
import { speedToThrottle } from './core/Throttle.js';
import { loadGameMode, saveGameMode } from './game/GameMode.js';
import { GameSession } from './game/GameSession.js';
import { GameRenderer } from './rendering/GameRenderer.js';
import { VIEW_HEIGHT } from './rendering/RiverRenderer.js';
import { HighScoreBoard } from './systems/HighScoreSystem.js';
import { InitialsEntry } from './ui/InitialsEntry.js';
import { LeaderboardView } from './ui/LeaderboardView.js';
import { OptionsModal } from './ui/OptionsModal.js';
import { RiverGenerator } from './world/RiverGenerator.js';

function byId<T extends HTMLElement>(id: string, type: new () => T): T {
    const element = document.getElementById(id);
    if (!(element instanceof type)) throw new Error(`Missing or wrong element type: #${id}`);
    return element;
}

const canvas = byId('river-canvas', HTMLCanvasElement);
const stage = byId('stage', HTMLElement);
const debug = byId('debug', HTMLElement);
const hint = byId('focus-hint', HTMLElement);
const seedInput = byId('seed-input', HTMLInputElement);
const applyButton = byId('seed-apply', HTMLButtonElement);
const randomButton = byId('seed-random', HTMLButtonElement);
const guidesToggle = byId('guides-toggle', HTMLInputElement);
const debugToggle = byId('debug-toggle', HTMLInputElement);
const restartButton = byId('restart', HTMLButtonElement);
const muteButton = byId('mute-toggle', HTMLButtonElement);
const volumeSlider = byId('volume', HTMLInputElement);
const optionsButton = byId('options-button', HTMLButtonElement);
const scoresButton = byId('scores-button', HTMLButtonElement);

// Settings (keybinds, audio, game mode) persist through localStorage where it is available;
// private modes and sandboxed frames just skip it.
const storage = defaultStorage();

const params = new URLSearchParams(location.search);
let seedSource = params.get('seed') ?? '';
let seed = seedSource === '' ? randomSeed() : parseSeed(seedSource);
if (seedSource === '') seedSource = String(seed);

// Production defaults: hitboxes and the debug overlay are OFF on every load. Only an explicit dev flag
// in the URL (?debug=1, ?hitboxes=1, ?dev=1) turns them on; the header toggles do it for one session.
// The checkboxes are set from the flags rather than trusted, so a browser restoring a ticked box on reload cannot leak.
const displayFlags = resolveDisplayFlags(location.search);
guidesToggle.checked = displayFlags.showHitboxes;
debugToggle.checked = displayFlags.showDebugOverlay;
debug.hidden = !displayFlags.showDebugOverlay;

const input = new InputManager({ deadzone: 0.15, storage });
const session = new GameSession({ viewHeight: VIEW_HEIGHT, mode: loadGameMode(storage) });
const renderer = new GameRenderer(canvas, new RiverGenerator(seed), session, { showGuides: displayFlags.showHitboxes });
const engine = new Engine({ seed, input, renderer, simulation: session });
seedInput.value = seedSource;

function refreshAudioControls(): void {
    const state = sound.state;
    muteButton.textContent = state === 'muted' ? 'Unmute (M)' : state === 'unsupported' ? 'No audio' : 'Mute (M)';
    muteButton.disabled = state === 'unsupported';
    muteButton.setAttribute('aria-pressed', String(sound.muted));
    volumeSlider.disabled = state === 'unsupported';
}

const sound = new SoundEngine({ storage, onChange: () => refreshAudioControls() });
renderer.audioState = () => sound.state;
volumeSlider.value = String(Math.round(sound.masterVolume * 100));
refreshAudioControls();
// The header slider, the Mute button and the options screen all edit the same settings.
sound.subscribe(config => {
    volumeSlider.value = String(Math.round(config.masterVolume * 100));
    refreshAudioControls();
});

const options = new OptionsModal({
    document,
    input,
    sound,
    getMode: () => session.mode,
    setMode: mode => {
        session.setMode(mode);
        saveGameMode(storage, mode);
    },
    holdPause: () => engine.holdPause(),
    returnFocus: canvas,
    campaignBridges: session.settings.victoryBridges,
    onOpenChange: open => {
        optionsButton.setAttribute('aria-expanded', String(open));
        if (open) hint.hidden = true;
    },
    canOpen: () => !scoresView.isOpen && !initials.isOpen,
    highScores: { show: () => scoresView.open(), reset: () => board.reset() },
});
optionsButton.addEventListener('click', () => {
    if (!scoresView.isOpen && !initials.isOpen) options.open();
});

// ---------------------------------------------------------------- high scores

const board = new HighScoreBoard({ storage });
/** The score screens. While one is open, or just after one closes, Fire must not restart the run. */
let restartBlockedUntil = 0;
const RESTART_GRACE_MS = 450;

const scoresView = new LeaderboardView({
    document,
    board,
    holdPause: () => engine.holdPause(),
    returnFocus: canvas,
    canOpen: () => !options.isOpen && !initials.isOpen,
    onOpenChange: open => {
        scoresButton.setAttribute('aria-expanded', String(open));
        if (open) hint.hidden = true;
        else restartBlockedUntil = performance.now() + RESTART_GRACE_MS;
    },
});
scoresButton.addEventListener('click', () => {
    if (!options.isOpen && !initials.isOpen) scoresView.open();
});

/** The run that earned a place, waiting for its initials. */
let pendingRun: { score: number; bridgesCleared: number; mode: 'campaign' | 'endless' } | null = null;

const initials = new InitialsEntry({
    document,
    returnFocus: canvas,
    play: cue => sound.play(cue),
    onOpenChange: open => {
        if (open) hint.hidden = true;
        else restartBlockedUntil = performance.now() + RESTART_GRACE_MS;
    },
    onSubmit: text => {
        const run = pendingRun;
        pendingRun = null;
        if (!run) return;
        board.submit({ initials: text, ...run });
        scoresView.open(); // Save -> show the table (with the new entry blinking) -> then restart is allowed
    },
});

/** Pause after the run ends before the qualification check: the verdict is on screen first. */
const RESULT_DELAY_DEFEAT = 1.5;
/** After a win the victory fanfare plays out first. */
const RESULT_DELAY_VICTORY = 3.2;
let runResultHandled = false;

function onRunEnded(): void {
    const summary = session.summary;
    const score = Math.floor(summary.score);
    const rank = board.rankFor(score);
    if (rank === null) return; // not good enough: the plain game-over card stands
    const isRecord = board.beatsRecord(score);
    renderer.celebration.start(isRecord ? 'record' : 'high-score');
    sound.play(isRecord ? 'record-broken' : 'new-high-score');
    pendingRun = { score, bridgesCleared: summary.bridges, mode: summary.mode };
    initials.open({ score, rank, isRecord });
}

session.onEvent(event => {
    // A run that makes the table gets the high-score fanfare instead of the sad game-over tune.
    if (event.type === 'game-over' && board.qualifies(Math.floor(event.score))) return;
    sound.handleEvent(event);
});
// Every rendered frame (including paused ones): drive the drone, refuel chime and klaxon.
engine.onFrame(stats => {
    const jet = session.jet;
    sound.syncGame({
        throttle: speedToThrottle(jet.speed, jet.config),
        engineOn: jet.isFlying && !session.fuel.isEmpty && !session.runEnded,
        refueling: session.isRefueling && jet.isFlying,
        lowFuel: session.fuel.isCritical && jet.isFlying && !session.runEnded,
        paused: stats.paused || session.runEnded,
    });
});


/** Starts a fresh run on the current seed: clears the celebration and the "result handled" latch too. */
function resetRun(): void {
    renderer.celebration.stop();
    runResultHandled = false;
    pendingRun = null;
    engine.reset(seed);
}

function restart(): void {
    resetRun();
    canvas.focus();
}

/** Y in the world for a point on the 960x720 screen, while the camera is parked at the end of a run. */
function screenToWorldY(screenY: number): number {
    return session.cameraY + (VIEW_HEIGHT - screenY);
}

engine.onTick(context => {
    // The fireworks of a high-score celebration.
    renderer.celebration.update(context.deltaTime, burst => {
        session.particles.celebrate(burst.x, screenToWorldY(burst.y), burst.scale);
        if (burst.index % 3 === 2) session.particles.explosion(burst.x, screenToWorldY(burst.y), 0.9);
    });
    if (!session.runEnded) return;
    // A moment after the run ends: does it make the table? If so, the initials screen opens.
    const delay = session.victory ? RESULT_DELAY_VICTORY : RESULT_DELAY_DEFEAT;
    if (!runResultHandled && session.gameOverTime >= delay) {
        runResultHandled = true;
        onRunEnded();
    }
    // After a short grace period (so a held Fire cannot skip the screen) a fresh Fire press starts a new
    // run, but never while a score screen is up or only just closed. Deferred: never reset from inside a tick.
    const screensClear = !initials.isOpen && !scoresView.isOpen && !options.isOpen && performance.now() >= restartBlockedUntil;
    if (session.gameOverTime > 1 && context.input.firePressed && screensClear) queueMicrotask(restart);
});

function setSeed(text: string): void {
    const trimmed = text.trim();
    seed = trimmed === '' ? randomSeed() : parseSeed(trimmed);
    seedSource = trimmed === '' ? String(seed) : trimmed;
    seedInput.value = seedSource;
    resetRun();
    // Keep any other query flags (?debug=1 and so on) when the seed changes.
    const url = new URL(location.href);
    url.searchParams.set('seed', String(seed));
    history.replaceState(null, '', url);
    canvas.focus();
}

applyButton.addEventListener('click', () => setSeed(seedInput.value));
randomButton.addEventListener('click', () => setSeed(''));
seedInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') setSeed(seedInput.value);
});
guidesToggle.addEventListener('change', () => {
    renderer.river.options.showGuides = guidesToggle.checked;
    canvas.focus();
});
debugToggle.addEventListener('change', () => {
    debug.hidden = !debugToggle.checked;
    canvas.focus();
});
restartButton.addEventListener('click', restart);
muteButton.addEventListener('click', () => {
    // The click is a user gesture, so it also unlocks audio.
    void sound.unlock();
    sound.toggleMute();
    canvas.focus();
});
volumeSlider.addEventListener('input', () => {
    sound.setMasterVolume(Number(volumeSlider.value) / 100);
});
volumeSlider.addEventListener('change', () => canvas.focus());

function bar(value: number, min: number, max: number, cells: number): string {
    const filled = Math.round(((value - min) / (max - min)) * cells);
    return '█'.repeat(Math.max(0, Math.min(cells, filled))).padEnd(cells, '░');
}

function updateDebug(): void {
    const s = engine.getStats();
    const world = engine.world;
    const river = world.sample(s.playerLineY);
    const section = world.getSectionAt(s.playerLineY);
    const bridgeIn = world.nextBridgeY(s.playerLineY) - s.playerLineY;
    const channels = world.getChannels(s.playerLineY);
    const cfg = engine.config;
    const seedText = seedSource === String(s.seed) ? `${s.seed}` : `${s.seed}  ("${seedSource}")`;
    const jet = session.jet;
    const fuel = session.fuel;
    const burn = fuel.burnRate(speedToThrottle(jet.speed, jet.config));
    debug.textContent = [
        `FPS        ${s.fps.toFixed(0).padStart(4)}   frame ${s.frameTimeMs.toFixed(1)} ms`,
        `Ticks/s    ${s.ticksPerSecond.toFixed(0).padStart(4)}   alpha ${s.alpha.toFixed(2)}`,
        `World Y    ${s.cameraY.toFixed(0).padStart(8)}   player line ${s.playerLineY.toFixed(0)}`,
        `River W    ${river.width.toFixed(0).padStart(4)}   ${channels.length > 1
            ? `split: ${channels.map(c => (c.rightX - c.leftX).toFixed(0)).join(' + ')}`
            : 'single channel'}`,
        `Section    #${section.index} ${section.kind}  (stage ${section.stage})`,
        `Bridge in  ${bridgeIn.toFixed(0)} units${river.isBridgeSection ? '  [ON BRIDGE]' : ''}`,
        `Speed      ${s.scrollSpeed.toFixed(0).padStart(4)}  ${bar(s.scrollSpeed, cfg.minSpeed, cfg.maxSpeed, 14)}`,
        `Throttle   ${s.throttle.toFixed(2).padStart(5)}  via ${s.activeDevice}${s.paused ? '   [PAUSED]' : ''}`,
        `Jet        ${jet.state}${jet.isInvulnerable ? ` (shield ${jet.invulnerableRemaining.toFixed(1)}s)` : ''}  x ${jet.x.toFixed(0)}  roll ${jet.rollDegrees.toFixed(0)}\u00b0`,
        `Fuel       ${fuel.level.toFixed(1)}/${fuel.capacity}  burn ${burn.toFixed(1)}/s${fuel.isCritical ? ' [LOW]' : ''}${fuel.isRefueling ? ' [REFUEL]' : ''}`,
        `Score      ${session.score}  jets ${session.lives}  section ${session.stage + 1}  next 1UP ${session.progression.nextBonusAt ?? '-'}`,
        `Shots      ${session.weapon.activeCount}/${session.weapon.config.maxActiveProjectiles}  depots ${session.depots.size}  enemies ${session.enemies.size}  particles ${session.particles.count}`,
        `Mode       ${session.mode}${session.victoryGoal > 0 ? ` (${session.stage}/${session.victoryGoal} bridges)` : ` (${session.stage} bridges, no victory)`}`,
        `Hardness   speed x${session.difficulty.speedScale.toFixed(2)}  burn x${session.difficulty.burnScale.toFixed(2)}  heli x${session.difficulty.helicopterSpeedScale.toFixed(2)}  fighter ${session.difficulty.fighterTrigger.toFixed(0)}  depots x${session.difficulty.depotChanceScale.toFixed(2)}`,
        `Scores     record ${board.record}  latest rank ${board.latestRank ?? '-'}`,
        `Sound      ${sound.state}  vol ${Math.round(sound.masterVolume * 100)}%  sfx ${sound.sfxEnabled ? 'on' : 'off'}  drone ${sound.droneEnabled ? 'on' : 'off'}  alarm ${sound.warningsEnabled ? 'on' : 'off'}`,
        `Seed       ${seedText}`,
    ].join('\n');
    const focused = document.activeElement === canvas && document.hasFocus();
    stage.classList.toggle('idle', !focused && !options.isOpen);
    hint.hidden = focused || options.isOpen;
}

let debugTimer = 0;

function start(): void {
    sound.attach(window);
    input.attach(canvas);
    canvas.focus();
    engine.start();
    window.clearInterval(debugTimer);
    debugTimer = window.setInterval(updateDebug, 100);
    updateDebug();
}

window.addEventListener('pagehide', () => {
    engine.stop();
    options.destroy();
    scoresView.destroy();
    initials.destroy();
    void sound.destroy();
    input.destroy();
    window.clearInterval(debugTimer);
});
window.addEventListener('pageshow', event => {
    if (event.persisted) start();
});
stage.addEventListener('pointerdown', () => canvas.focus());

// Debug handle for the browser console and automated browser checks.
declare global {
    interface Window {
        __riverRaid?: {
            engine: Engine; session: GameSession; sound: SoundEngine; input: InputManager; options: OptionsModal;
            board: HighScoreBoard; scores: LeaderboardView; initials: InitialsEntry; renderer: GameRenderer;
        };
    }
}
window.__riverRaid = { engine, session, sound, input, options, board, scores: scoresView, initials, renderer };

start();
