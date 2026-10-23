import { SoundEngine } from './audio/SoundEngine.js';
import { Engine } from './core/Engine.js';
import { InputManager } from './core/InputManager.js';
import { parseSeed, randomSeed } from './core/PRNG.js';
import { defaultStorage } from './core/Storage.js';
import { speedToThrottle } from './core/Throttle.js';
import { loadGameMode, saveGameMode } from './game/GameMode.js';
import { GameSession } from './game/GameSession.js';
import { GameRenderer } from './rendering/GameRenderer.js';
import { VIEW_HEIGHT } from './rendering/RiverRenderer.js';
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

// Settings (keybinds, audio, game mode) persist through localStorage where it is available;
// private modes and sandboxed frames just skip it.
const storage = defaultStorage();

const params = new URLSearchParams(location.search);
let seedSource = params.get('seed') ?? '';
let seed = seedSource === '' ? randomSeed() : parseSeed(seedSource);
if (seedSource === '') seedSource = String(seed);

const input = new InputManager({ deadzone: 0.15, storage });
const session = new GameSession({ viewHeight: VIEW_HEIGHT, mode: loadGameMode(storage) });
const renderer = new GameRenderer(canvas, new RiverGenerator(seed), session, { showGuides: guidesToggle.checked });
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
});
optionsButton.addEventListener('click', () => options.open());

session.onEvent(event => sound.handleEvent(event));
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


function restart(): void {
    engine.reset(seed);
    canvas.focus();
}

// After the run ends (and a short grace period so a held fire button cannot skip the screen),
// a fresh Fire press starts a new run. Deferred: never reset the engine from inside a tick.
engine.onTick(context => {
    if (session.runEnded && session.gameOverTime > 1 && context.input.firePressed) queueMicrotask(restart);
});

function setSeed(text: string): void {
    const trimmed = text.trim();
    seed = trimmed === '' ? randomSeed() : parseSeed(trimmed);
    seedSource = trimmed === '' ? String(seed) : trimmed;
    seedInput.value = seedSource;
    engine.reset(seed);
    history.replaceState(null, '', `?seed=${encodeURIComponent(String(seed))}`);
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
        __riverRaid?: { engine: Engine; session: GameSession; sound: SoundEngine; input: InputManager; options: OptionsModal };
    }
}
window.__riverRaid = { engine, session, sound, input, options };

start();
