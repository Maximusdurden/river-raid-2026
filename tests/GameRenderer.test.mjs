import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { GameRenderer, drawJetSprite, fuelColor } from '../dist/src/rendering/GameRenderer.js';
import { RiverGenerator } from '../dist/src/world/RiverGenerator.js';
import { headlessGame, pilot } from './helpers.mjs';

/** A 2D context that records every call; enough surface for the renderers to run unchanged. */
function recordingContext(calls) {
    const state = {};
    return new Proxy({}, {
        get(_t, prop) {
            if (prop in state) return state[prop];
            if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
                return (...args) => {
                    calls.push([String(prop), ...args]);
                    return { addColorStop() {} };
                };
            }
            if (prop === 'createPattern') return () => ({ setTransform() {} });
            if (prop === 'measureText') return text => ({ width: String(text).length * 7 });
            return (...args) => {
                calls.push([String(prop), ...args]);
            };
        },
        set(_t, prop, value) {
            state[prop] = value;
            return true;
        },
    });
}

const saved = {};
let dom;
let calls;

before(() => {
    dom = new JSDOM('<canvas id="c"></canvas>');
    calls = [];
    const ctx = recordingContext(calls);
    dom.window.HTMLCanvasElement.prototype.getContext = () => ctx;
    for (const key of ['window', 'document', 'DOMMatrix', 'Path2D']) saved[key] = globalThis[key];
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.DOMMatrix = class { scale() { return this; } };
    globalThis.Path2D = class { moveTo() {} lineTo() {} closePath() {} };
});

after(() => {
    for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
    }
    dom.window.close();
});

function scene(options = {}) {
    const canvas = document.getElementById('c');
    const world = new RiverGenerator(options.seed ?? 2026);
    const game = headlessGame({ seed: options.seed ?? 2026, game: options.game ?? {}, script: options.script });
    const renderer = new GameRenderer(canvas, world, game.session);
    renderer.setWorld(game.engine.world);
    const draw = (paused = false, alpha = 0.5) => {
        calls.length = 0;
        const stats = game.engine.getStats();
        renderer.render({
            previousCameraY: stats.cameraY - 3, cameraY: stats.cameraY, previousTime: game.session.time - 1 / 60,
            time: game.session.time, paused,
        }, alpha);
        return calls.slice();
    };
    return { game, renderer, draw };
}

const texts = recorded => recorded.filter(c => c[0] === 'fillText').map(c => String(c[1]));

test('renders a full frame: river, jet, HUD', () => {
    const { game, draw } = scene({ script: (_f, g) => pilot(g.session, g.engine.world, { throttle: 0 }) });
    game.run(1);
    const frame = draw();
    assert.ok(frame.length > 300, `${frame.length} draw calls`);
    const t = texts(frame);
    assert.ok(t.includes('SCORE') && t.includes('FUEL') && t.includes('JETS'));
    assert.ok(t.includes('000000'));
    assert.ok(t.some(s => /^\d{1,3}%$/.test(s)), 'numeric fuel readout');
    assert.ok(t.some(s => s.startsWith('SECTION')));
    assert.ok(frame.some(c => c[0] === 'ellipse'), 'canopy');
    assert.equal(frame.at(-1)[0], 'restore');
});

test('fuel readout follows the tank; low fuel and refuelling show their warnings', () => {
    const { game, draw } = scene({ script: (_f, g) => pilot(g.session, g.engine.world, { throttle: -1 }) });
    game.run(0.2);
    game.session.fuel.setLevel(63.4);
    assert.ok(texts(draw()).includes('63%'));

    game.session.fuel.setLevel(15);
    let sawLow = false;
    for (let i = 0; i < 12; i++) {
        game.session.time = i * 0.04; // sweep the warning pulse
        if (texts(draw()).includes('LOW FUEL')) sawLow = true;
    }
    assert.equal(sawLow, true);

    game.session.fuel.setLevel(0);
    let sawOut = false;
    for (let i = 0; i < 12; i++) {
        game.session.time = i * 0.04;
        if (texts(draw()).includes('ENGINE OUT')) sawOut = true;
    }
    assert.equal(sawOut, true);

    const refuel = scene({ script: (_f, g) => pilot(g.session, g.engine.world, { throttle: -1 }) });
    refuel.game.session.fuel.setLevel(30);
    refuel.game.runUntil(h => h.session.isRefueling, 60);
    assert.equal(refuel.game.session.isRefueling, true);
    assert.ok(texts(refuel.draw()).includes('REFUELING +'));
});

test('depots are drawn with FUEL livery', () => {
    const { game, draw } = scene({ seed: 13, script: (_f, g) => pilot(g.session, g.engine.world, { throttle: 0, fire: false, seekDepots: false }) });
    assert.equal(game.runUntil(h => [...h.session.depots.values()].some(d => d.y - h.session.jet.y < 300 && d.y > h.session.jet.y), 60), true);
    const letters = texts(draw()).filter(s => s.length === 1 && 'FUEL'.includes(s));
    assert.deepEqual(letters.slice(0, 4), ['F', 'U', 'E', 'L']);
});

test('missiles get a glowing tracer', () => {
    const { game, draw } = scene({ script: (_f, g) => pilot(g.session, g.engine.world, { throttle: 0, fire: true, seekDepots: false }), game: { depots: { chance: 0 } } });
    assert.equal(game.runUntil(h => h.session.weapon.activeCount > 0, 5), true);
    const withMissile = draw();
    game.session.weapon.clear();
    const without = draw();
    // A tracer is a gradient-stroked line plus a bright head.
    assert.ok(withMissile.filter(c => c[0] === 'createLinearGradient').length > without.filter(c => c[0] === 'createLinearGradient').length);
    assert.ok(withMissile.filter(c => c[0] === 'arc').length > without.filter(c => c[0] === 'arc').length);
});

test('bridge ruins are drawn after a bridge falls; score popups appear', () => {
    const { game, draw } = scene({ script: (_f, g) => pilot(g.session, g.engine.world, { throttle: 0, fire: true, seekDepots: false }), game: { startY: 2900, depots: { chance: 0 } } });
    game.runUntil(h => h.of('bridge-destroyed').length > 0, 30);
    assert.equal(game.session.bridges.isDestroyed(1), true);
    const frame = draw();
    assert.ok(texts(frame).includes('+500'));
    assert.ok(frame.length > 400);
});

test('the jet blinks while protected and is hidden while exploding', () => {
    const { game, draw } = scene({ script: () => ({ moveX: -1 }), game: { depots: { chance: 0 } } });
    // The canopy ellipse is drawn once per jet sprite: the flying jet plus one icon per life in the HUD.
    const canopies = frame => frame.filter(c => c[0] === 'ellipse' && c[3] === 1.9).length;
    game.runUntil(h => h.of('jet-destroyed').length > 0, 10);
    assert.equal(canopies(draw()), game.session.lives, 'only the HUD icons while exploding');

    game.runUntil(h => h.of('respawn').length > 0, 10);
    const counts = new Set();
    for (let i = 0; i < 20; i++) {
        game.session.time = i * 0.03;
        counts.add(canopies(draw()) - game.session.lives);
    }
    assert.deepEqual([...counts].sort(), [0, 1], 'the jet blinks on and off');
});

test('game over and pause overlays', () => {
    const { game, draw } = scene({ script: () => ({ moveX: -1 }), game: { startLives: 1, depots: { chance: 0 } } });
    game.runUntil(h => h.session.gameOver, 20);
    game.run(1.5);
    let sawPrompt = false;
    for (let i = 0; i < 12; i++) {
        game.session.time = i * 0.05;
        const t = texts(draw());
        assert.ok(t.includes('GAME OVER'));
        assert.ok(t.some(s => s.startsWith('FINAL SCORE')));
        if (t.includes('PRESS FIRE TO PLAY AGAIN')) sawPrompt = true;
    }
    assert.equal(sawPrompt, true);

    const live = scene();
    live.game.run(0.5);
    assert.ok(texts(live.draw(true)).includes('PAUSED'));
    assert.equal(texts(live.draw(false)).includes('PAUSED'), false);
});

test('lives show as jet icons up to five, then as a number', () => {
    const { game, draw } = scene({ game: { startLives: 3 } });
    game.run(0.2);
    assert.equal(texts(draw()).some(s => s.startsWith('x')), false);
    const many = scene({ game: { startLives: 9 } });
    many.game.run(0.2);
    assert.ok(texts(many.draw()).includes('x9'));
});

test('hitbox overlay draws outlines only when enabled', () => {
    const { game, renderer, draw } = scene({ script: (_f, g) => pilot(g.session, g.engine.world, { fire: true }) });
    game.run(1);
    assert.equal(draw().filter(c => c[0] === 'strokeRect').length, 0);
    renderer.river.options.showGuides = true;
    assert.ok(draw().filter(c => c[0] === 'strokeRect').length >= 1);
});

test('rendering is safe at awkward alphas and with non-finite alpha', () => {
    const { game, draw } = scene();
    game.run(0.3);
    for (const alpha of [0, 0.25, 1, -3, 7, NaN, Infinity]) assert.ok(draw(false, alpha).length > 100);
});

test('drawJetSprite handles every throttle, roll and option combination', () => {
    const ctxCalls = [];
    const ctx = recordingContext(ctxCalls);
    for (const throttle of [-1, 0, 1]) {
        for (const roll of [-0.35, 0, 0.35]) {
            for (const flame of [true, false]) {
                drawJetSprite(ctx, { x: 100, y: 100, roll, maxRoll: 0.35, throttle, flame, time: 1.3, scale: 0.6, shadow: true });
            }
        }
    }
    drawJetSprite(ctx, { x: 0, y: 0, roll: 0, maxRoll: 0, throttle: 0, flame: false, time: 0 });
    assert.ok(ctxCalls.length > 500);
    const saves = ctxCalls.filter(c => c[0] === 'save').length;
    const restores = ctxCalls.filter(c => c[0] === 'restore').length;
    assert.equal(saves, restores, 'balanced save/restore');
});

test('afterburner flame grows with throttle', () => {
    const flameLength = throttle => {
        const rec = [];
        drawJetSprite(recordingContext(rec), { x: 0, y: 0, roll: 0, maxRoll: 0.35, throttle, flame: true, time: 0 });
        const tips = rec.filter(c => c[0] === 'quadraticCurveTo').map(c => c[4]);
        return Math.max(...tips);
    };
    assert.ok(flameLength(1) > flameLength(0) && flameLength(0) > flameLength(-1));
});

test('fuelColor goes green -> amber -> red', () => {
    const hue = f => Number(/hsl\((\d+)/.exec(fuelColor(f))[1]);
    assert.equal(hue(1), 138);
    assert.ok(hue(0.35) < hue(0.5) && hue(0.25) < hue(0.35));
    assert.equal(hue(0.1), 4);
    assert.ok(hue(0.2) <= 5);
    assert.equal(fuelColor(-1), fuelColor(0));
    assert.equal(fuelColor(5), fuelColor(1));
});
