import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine } from '../dist/src/core/Engine.js';
import { GameSession } from '../dist/src/game/GameSession.js';
import {
    DEFAULT_GAME_MODE, GAME_MODES, isGameMode, loadGameMode, parseGameMode, saveGameMode,
} from '../dist/src/game/GameMode.js';
import { DT, headlessGame, idle, pilot } from './helpers.mjs';

const KEY = 'riverraid.game_mode';
class MemoryStorage {
    constructor(initial = {}) { this.data = new Map(Object.entries(initial)); this.failReads = false; this.failWrites = false; }
    getItem(key) { if (this.failReads) throw new Error('SecurityError'); return this.data.has(key) ? this.data.get(key) : null; }
    setItem(key, value) { if (this.failWrites) throw new Error('Quota'); this.data.set(key, String(value)); }
    removeItem(key) { this.data.delete(key); }
}

const calm = { depots: { chance: 0 } };
/** Autopilot with unlimited fuel that shoots everything: flies through bridges one after another. */
const bot = (options = {}) => (_f, g) => pilot(g.session, g.engine.world, { seekDepots: false, fire: true, throttle: 1, ...options });
const rich = { fuel: { capacity: 1e9, startLevel: 1e9 }, ...calm };

// ------------------------------------------------------------------ the type

test('the two modes, and campaign is the default', () => {
    assert.deepEqual([...GAME_MODES], ['campaign', 'endless']);
    assert.equal(DEFAULT_GAME_MODE, 'campaign');
    assert.ok(isGameMode('campaign') && isGameMode('endless'));
    for (const bad of ['Campaign', 'ENDLESS', '', 'story', null, undefined, 1, {}]) assert.equal(isGameMode(bad), false, String(bad));
});

test('anything that is not a known mode parses to the default', () => {
    assert.equal(parseGameMode('endless'), 'endless');
    assert.equal(parseGameMode('campaign'), 'campaign');
    assert.equal(parseGameMode('  endless \n'), 'endless');
    assert.equal(parseGameMode('"endless"'), 'endless', 'a JSON string is tolerated');
    for (const bad of [null, undefined, '', 'Endless', 'story', '{"mode":"endless"}', '[', 'null', '1']) {
        assert.equal(parseGameMode(bad), 'campaign', String(bad));
    }
});

test('the mode is saved under riverraid.game_mode and loaded back', () => {
    const storage = new MemoryStorage();
    assert.equal(loadGameMode(storage), 'campaign');
    assert.equal(saveGameMode(storage, 'endless'), true);
    assert.equal(storage.data.get(KEY), 'endless');
    assert.equal(loadGameMode(storage), 'endless');
    saveGameMode(storage, 'campaign');
    assert.equal(loadGameMode(storage), 'campaign');
});

test('storage that fails or is absent never throws and yields the default', () => {
    const broken = new MemoryStorage();
    broken.failReads = true;
    broken.failWrites = true;
    assert.equal(loadGameMode(broken), 'campaign');
    assert.equal(saveGameMode(broken, 'endless'), false);
    assert.equal(loadGameMode(null), 'campaign');
    assert.equal(saveGameMode(null, 'endless'), false);
    assert.equal(loadGameMode(new MemoryStorage({ [KEY]: 'garbage' })), 'campaign');
});

// ------------------------------------------------------------------- session

test('a session is a campaign unless told otherwise, and rejects an unknown mode', () => {
    assert.equal(new GameSession().mode, 'campaign');
    assert.equal(new GameSession({ mode: 'endless' }).mode, 'endless');
    assert.equal(new GameSession().summary.mode, 'campaign');
    assert.throws(() => new GameSession({ mode: 'story' }), RangeError);
    const session = new GameSession();
    assert.throws(() => session.setMode('story'), RangeError);
    assert.equal(session.mode, 'campaign', 'a refused change changes nothing');
});

test('the victory goal is the campaign length, and none at all in endless', () => {
    assert.equal(new GameSession().victoryGoal, 10);
    assert.equal(new GameSession({ victoryBridges: 4 }).victoryGoal, 4);
    assert.equal(new GameSession({ mode: 'endless' }).victoryGoal, 0);
    assert.equal(new GameSession({ mode: 'endless', victoryBridges: 4 }).victoryGoal, 0);
    assert.equal(new GameSession({ victoryBridges: 0 }).victoryGoal, 0, 'the old "0 = endless" setting still means no victory');
});

test('CAMPAIGN: the final bridge wins the run', () => {
    const g = headlessGame({ script: bot(), game: { startY: 2800, victoryBridges: 1, ...rich } });
    assert.equal(g.runUntil(h => h.session.victory, 60), true);
    assert.equal(g.of('victory').length, 1);
    assert.equal(g.session.runEnded, true);
    assert.equal(g.session.summary.mode, 'campaign');
});

test('ENDLESS: the same bridge scores 500, advances the stage and sets the checkpoint, but never wins', () => {
    const g = headlessGame({ script: bot(), game: { startY: 2800, victoryBridges: 1, mode: 'endless', ...rich } });
    assert.equal(g.runUntil(h => h.of('stage-clear').length > 0, 60), true);
    assert.equal(g.session.score, 500, 'a bridge is worth 500 in endless too');
    assert.equal(g.session.stage, 1);
    assert.equal(g.session.bridges.checkpoint.number, 1, 'still a checkpoint');
    assert.equal(g.session.victory, false);
    assert.equal(g.of('victory').length, 0);
    g.run(3);
    assert.equal(g.session.runEnded, false, 'the run just carries on');
    assert.equal(g.session.jet.isFlying, true);
    assert.ok(g.session.jet.y > 3300);
});

test('ENDLESS: the run flies past bridge 10 and well beyond without a victory screen', () => {
    // victoryBridges is 10 (the default), so a campaign would have ended at the tenth bridge.
    const g = headlessGame({
        seed: 2026, script: bot(), game: { startY: 3200 * 9 - 400, mode: 'endless', startLives: 50, ...rich, depots: { chance: 0 }, enemies: { enabled: false } },
    });
    assert.equal(g.session.victoryGoal, 0);
    assert.equal(g.runUntil(h => h.session.stage >= 12, 120), true, `only reached ${g.session.stage} bridges`);
    assert.ok(g.session.stage >= 12);
    assert.equal(g.session.victory, false);
    assert.equal(g.of('victory').length, 0);
    assert.equal(g.of('stage-clear').length >= 3, true);
    assert.ok(g.session.score >= 12 * 500 - 9 * 500, 'every bridge scored');
    assert.equal(g.session.summary.bridges, g.session.stage);
});

test('the same run in campaign mode really would have ended at bridge 10', () => {
    const g = headlessGame({
        seed: 2026, script: bot(), game: { startY: 3200 * 9 - 400, mode: 'campaign', startLives: 50, ...rich, enemies: { enabled: false } },
    });
    assert.equal(g.runUntil(h => h.session.victory, 120), true);
    assert.equal(g.session.stage, 10);
    assert.equal(g.of('victory').length, 1);
});

test('ENDLESS only ends when the last jet is lost', () => {
    const g = headlessGame({ script: () => ({ moveX: -1 }), game: { mode: 'endless', startLives: 1, ...calm } });
    assert.equal(g.runUntil(h => h.session.gameOver, 20), true);
    assert.equal(g.session.victory, false);
    assert.equal(g.of('game-over').length, 1);
    assert.equal(g.session.summary.mode, 'endless');
});

test('victoryBridges 0 behaves as endless even in campaign mode', () => {
    const g = headlessGame({ script: bot(), game: { startY: 2800, victoryBridges: 0, mode: 'campaign', ...rich } });
    g.runUntil(h => h.of('stage-clear').length > 0, 60);
    g.run(2);
    assert.equal(g.session.victory, false);
});

// ------------------------------------------------------------- switching mid-run

test('switching to endless mid-run cancels a victory that was about to happen', () => {
    const g = headlessGame({ script: bot(), game: { startY: 2800, victoryBridges: 1, ...rich } });
    g.session.setMode('endless');
    g.runUntil(h => h.of('stage-clear').length > 0, 60);
    g.run(2);
    assert.equal(g.session.victory, false);
    assert.equal(g.session.score, 500);
});

test('switching to campaign mid-run takes effect at the next bridge, not retroactively', () => {
    const g = headlessGame({ script: bot(), game: { startY: 2800, victoryBridges: 1, mode: 'endless', ...rich } });
    g.runUntil(h => h.of('stage-clear').length > 0, 60);
    g.session.setMode('campaign');
    g.run(1);
    assert.equal(g.session.victory, false, 'the bridge that already fell does not retroactively win');
    assert.equal(g.runUntil(h => h.session.victory, 120), true, 'the next one does (the goal of 1 was already passed)');
});

test('the mode survives a restart and a new seed (it is a setting, not run state)', () => {
    const g = headlessGame({ script: () => ({}), game: { mode: 'endless', ...calm } });
    g.engine.reset(777);
    assert.equal(g.session.mode, 'endless');
    g.engine.reset(2026);
    assert.equal(g.session.mode, 'endless');
    assert.equal(g.session.victory, false);
});

test('a restart clears a victory but keeps the chosen mode', () => {
    const g = headlessGame({ script: bot(), game: { startY: 2800, victoryBridges: 1, ...rich } });
    g.runUntil(h => h.session.victory, 60);
    g.session.setMode('endless');
    g.engine.reset(2026);
    assert.deepEqual([g.session.victory, g.session.runEnded, g.session.mode], [false, false, 'endless']);
});

// ------------------------------------------------------------- the HUD wording

test('the section line says how far through the campaign you are, or that it is endless', async () => {
    const { sectionLine } = await import('../dist/src/rendering/GameRenderer.js');
    assert.equal(sectionLine('campaign', 0, 10), 'SECTION 1 / 10');
    assert.equal(sectionLine('campaign', 4, 10), 'SECTION 5 / 10');
    assert.equal(sectionLine('endless', 0, 10), 'SECTION 1 \u00b7 ENDLESS');
    assert.equal(sectionLine('endless', 11, 10), 'SECTION 12 \u00b7 ENDLESS');
    assert.equal(sectionLine('campaign', 2, 0), 'SECTION 3');
});

// -------------------------------------------------------------- engine pause holds

function engineWithSim() {
    const ticks = [];
    const sim = { reset: () => 0, step: ctx => { ticks.push(ctx.tick); return { cameraY: ctx.cameraY + 1, scrollSpeed: 60, cameraTeleported: false }; } };
    // `frame` counts from the moment a script is installed, so a script can say "press on my first frame".
    let frame = 0;
    let script = () => ({});
    const renders = [];
    const engine = new Engine({
        seed: 1, simulation: sim,
        input: { update: () => idle(script(frame++)) },
        renderer: { setWorld() {}, render: (state, alpha) => renders.push({ ...state, alpha }) },
    });
    return {
        engine, ticks, renders,
        setScript: fn => { script = fn; frame = 0; },
        run: n => { for (let i = 0; i < n; i++) engine.runFrame(DT); },
    };
}

test('holdPause freezes the simulation but not the rendering, and release resumes it', () => {
    const e = engineWithSim();
    e.run(10);
    const ticked = e.ticks.length;
    const release = e.engine.holdPause();
    assert.equal(e.engine.isPaused, true);
    e.run(30);
    assert.equal(e.ticks.length, ticked, 'no ticks while held');
    assert.equal(e.renders.length, 40, 'but every frame was still drawn');
    assert.equal(e.engine.getStats().paused, true);
    release();
    assert.equal(e.engine.isPaused, false);
    e.run(10);
    assert.equal(e.ticks.length, ticked + 10);
});

test('holds stack: the game resumes only when the last one is released, and releasing twice is harmless', () => {
    const e = engineWithSim();
    const a = e.engine.holdPause();
    const b = e.engine.holdPause();
    a();
    a();
    assert.equal(e.engine.isPaused, true, 'b still holds');
    e.run(5);
    assert.equal(e.ticks.length, 0);
    b();
    assert.equal(e.engine.isPaused, false);
    e.run(5);
    assert.equal(e.ticks.length, 5);
});

test('the pause key does nothing while a hold is active, so the menu cannot be paused out from under', () => {
    const e = engineWithSim();
    const release = e.engine.holdPause();
    e.setScript(() => ({ pausePressed: true }));
    e.run(3);
    assert.equal(e.engine.isUserPaused, false);
    release();
    e.setScript(() => ({}));
    e.run(3);
    assert.equal(e.engine.isPaused, false, 'releasing does not leave a pause behind');
});

test('a player\u2019s own pause is neither cancelled by a hold nor lost when it ends', () => {
    const e = engineWithSim();
    e.setScript(f => (f === 0 ? { pausePressed: true } : {}));
    e.run(2);
    assert.equal(e.engine.isUserPaused, true);
    const release = e.engine.holdPause();
    e.run(3);
    release();
    assert.equal(e.engine.isPaused, true, 'the player is still paused after the menu closes');
    assert.equal(e.engine.isUserPaused, true);
    e.setScript(() => ({}));
    e.run(1); // the frame right after a release ignores pause (see the swallow tests below)
    e.setScript(() => ({ pausePressed: true }));
    e.run(1);
    assert.equal(e.engine.isPaused, false, 'and can unpause normally');
});

test('a pause press arriving in the frame right after the last hold is released is swallowed, once', () => {
    const e = engineWithSim();
    e.run(2);
    const release = e.engine.holdPause();
    e.run(2);
    release();
    e.setScript(f => (f === 0 ? { pausePressed: true } : {}));   // the Esc that closed the menu, latched until now
    e.run(1);
    assert.equal(e.engine.isUserPaused, false, 'that press belonged to closing the menu');
    e.setScript(f => (f === 1 ? { pausePressed: true } : {}));    // a deliberate press one frame later
    e.run(2);
    assert.equal(e.engine.isUserPaused, true, 'the swallow covers one frame only');
});

test('releasing one of two holds swallows nothing, because the game is still held', () => {
    const e = engineWithSim();
    const a = e.engine.holdPause();
    const b = e.engine.holdPause();
    a();
    e.setScript(f => (f === 0 ? { pausePressed: true } : {}));
    e.run(1);
    b();
    e.setScript(() => ({}));
    e.run(1);
    e.setScript(f => (f === 0 ? { pausePressed: true } : {}));
    e.run(1);
    assert.equal(e.engine.isUserPaused, true, 'the swallow is armed by the last release only, and spent after one frame');
});

test('releasing a hold twice does not arm a second swallow', () => {
    const e = engineWithSim();
    const release = e.engine.holdPause();
    release();
    e.run(1);                 // spends the swallow
    release();                // no-op: the hold is already gone
    e.setScript(f => (f === 0 ? { pausePressed: true } : {}));
    e.run(1);
    assert.equal(e.engine.isUserPaused, true);
});

test('only the player\u2019s pause is announced on the canvas; a menu hold is not', () => {
    const e = engineWithSim();
    e.run(1);
    assert.deepEqual([e.renders.at(-1).paused, e.renders.at(-1).userPaused], [false, false]);
    const release = e.engine.holdPause();
    e.run(1);
    assert.deepEqual([e.renders.at(-1).paused, e.renders.at(-1).userPaused], [true, false]);
    release();
    e.setScript(f => (f === 1 ? { pausePressed: true } : {}));   // frame 0 is the swallowed one
    e.run(2);
    assert.deepEqual([e.renders.at(-1).paused, e.renders.at(-1).userPaused], [true, true]);
});

test('a fire press made while a hold is active is discarded rather than queued for after it', () => {
    const ticksWithFire = [];
    const sim = { reset: () => 0, step: ctx => { if (ctx.input.firePressed) ticksWithFire.push(ctx.tick); return { cameraY: ctx.cameraY, scrollSpeed: 0, cameraTeleported: false }; } };
    let frame = 0;
    const engine = new Engine({
        seed: 1, simulation: sim,
        input: { update: () => idle({ firePressed: frame++ === 2 }) },
        renderer: { setWorld() {}, render() {} },
    });
    engine.runFrame(DT);
    const release = engine.holdPause();
    engine.runFrame(DT);
    engine.runFrame(DT); // frame 2: the press, while held
    release();
    for (let i = 0; i < 5; i++) engine.runFrame(DT);
    assert.deepEqual(ticksWithFire, [], 'it does not fire the moment the menu closes');
});

test('a reset leaves a hold alone but clears the player\u2019s pause', () => {
    const e = engineWithSim();
    e.setScript(f => (f === 0 ? { pausePressed: true } : {}));
    e.run(1);
    const release = e.engine.holdPause();
    e.engine.reset(5);
    assert.equal(e.engine.isUserPaused, false);
    assert.equal(e.engine.isPaused, true, 'the menu still holds');
    release();
    assert.equal(e.engine.isPaused, false);
});

test('a held game is silent: the audio sees paused, so the drone and alarms stop', () => {
    const g = headlessGame({ script: () => ({}), game: calm });
    const frames = [];
    g.engine.onFrame(stats => frames.push(stats.paused));
    g.run(0.1);
    const release = g.engine.holdPause();
    g.run(0.1);
    release();
    g.run(0.1);
    assert.equal(frames.at(5), false);
    assert.equal(frames.at(9), true);
    assert.equal(frames.at(-1), false);
});
