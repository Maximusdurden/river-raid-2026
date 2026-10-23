import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { FighterJet } from '../dist/src/entities/enemies/FighterJet.js';
import { Helicopter } from '../dist/src/entities/enemies/Helicopter.js';
import { PatrolBoat } from '../dist/src/entities/enemies/PatrolBoat.js';
import {
    GameRenderer, audioLabel, drawAudioIcon, drawFighter, drawHelicopter, drawPatrolBoat, popupColor,
} from '../dist/src/rendering/GameRenderer.js';
import { RiverGenerator } from '../dist/src/world/RiverGenerator.js';
import { headlessGame, pilot } from './helpers.mjs';

/** A 2D context that records every call so drawing code can be inspected without a browser. */
function recorder(calls) {
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
            calls.push(['set:' + String(prop), value]);
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
    const ctx = recorder(calls);
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

function scene(game = {}, { fire = false } = {}) {
    const world = new RiverGenerator(2026);
    const g = headlessGame({ seed: 2026, game: { depots: { chance: 0 }, ...game }, script: (_f, h) => pilot(h.session, h.engine.world, { seekDepots: false, fire }) });
    const renderer = new GameRenderer(document.getElementById('c'), world, g.session);
    renderer.setWorld(g.engine.world);
    const draw = (paused = false) => {
        calls.length = 0;
        const stats = g.engine.getStats();
        renderer.render({ previousCameraY: stats.cameraY - 3, cameraY: stats.cameraY, previousTime: g.session.time - 1 / 60, time: g.session.time, paused }, 0.5);
        return calls.slice();
    };
    return { g, renderer, draw };
}

const sprite = (fn, options) => {
    const rec = [];
    fn(recorder(rec), options);
    return rec;
};
const count = (rec, name) => rec.filter(c => c[0] === name).length;
const texts = rec => rec.filter(c => c[0] === 'fillText').map(c => String(c[1]));
const balanced = rec => count(rec, 'save') === count(rec, 'restore');
const HELI = { x: 100, y: 100, facing: 1, rotor: 0.4, lean: 0 };
const BOAT = { x: 100, y: 100, facing: 1, time: 1, speedFraction: 0.6, drifting: false, seed: 3 };
const JET = { x: 100, y: 100, facing: 1, streaking: false, time: 1, seed: 3 };

// ---------------------------------------------------------------- helicopter

test('helicopter sprite: balanced state, canopy, skids, tail rotor and a main rotor', () => {
    const rec = sprite(drawHelicopter, HELI);
    assert.ok(balanced(rec));
    assert.ok(count(rec, 'ellipse') >= 4, 'fuselage, canopy, highlight and shadow');
    assert.ok(count(rec, 'arc') >= 3, 'rotor disc, tail-rotor disc and hub');
    assert.ok(count(rec, 'stroke') >= 8, 'skids, blades and blur sweeps');
});

test('the main rotor is animated: blades move with the rotor angle', () => {
    const lines = options => sprite(drawHelicopter, options).filter(c => c[0] === 'lineTo').map(c => `${c[1].toFixed(3)},${c[2].toFixed(3)}`);
    assert.notDeepEqual(lines({ ...HELI, rotor: 0 }), lines({ ...HELI, rotor: 0.9 }));
    assert.deepEqual(lines({ ...HELI, rotor: 0.4 }), lines({ ...HELI, rotor: 0.4 }));
    // The blur sweeps trail behind each blade: more strokes than a bare two-blade rotor.
    assert.ok(sprite(drawHelicopter, HELI).filter(c => c[0] === 'stroke').length > 6);
});

test('the helicopter faces its direction of travel', () => {
    const scaleX = options => sprite(drawHelicopter, options).find(c => c[0] === 'scale')[1];
    assert.equal(scaleX({ ...HELI, facing: 1 }), 1);
    assert.equal(scaleX({ ...HELI, facing: -1 }), -1);
});

// ---------------------------------------------------------------- patrol boat

test('boat sprite: hull, deck, cabin, cannon, bow wave and wake, with balanced state', () => {
    const rec = sprite(drawPatrolBoat, BOAT);
    assert.ok(balanced(rec));
    assert.ok(count(rec, 'fill') >= 6 && count(rec, 'fillRect') >= 5);
    assert.ok(rec.some(c => c[0] === 'setLineDash' && c[1].length > 0), 'a dashed V wake');
    assert.ok(count(rec, 'quadraticCurveTo') >= 2, 'curved bow wave');
});

test('a cruising boat draws a wake that grows with speed; a drifting one draws ripples instead', () => {
    const wakeLength = fraction => Math.max(...sprite(drawPatrolBoat, { ...BOAT, speedFraction: fraction })
        .filter(c => c[0] === 'lineTo').map(c => Math.abs(c[1])));
    assert.ok(wakeLength(1) > wakeLength(0.1));
    const drifting = sprite(drawPatrolBoat, { ...BOAT, drifting: true });
    const cruising = sprite(drawPatrolBoat, BOAT);
    assert.ok(count(drifting, 'ellipse') >= count(cruising, 'ellipse') + 2, 'spreading ripples');
    assert.ok(!drifting.some(c => c[0] === 'setLineDash' && c[1].length > 0), 'no wake while adrift');
});

test('the deck cannon sweeps over time and each boat has its own phase', () => {
    const aim = options => sprite(drawPatrolBoat, options).filter(c => c[0] === 'rotate').map(c => +c[1].toFixed(4));
    assert.notDeepEqual(aim({ ...BOAT, time: 0 }), aim({ ...BOAT, time: 2 }));
    assert.notDeepEqual(aim({ ...BOAT, seed: 1 }), aim({ ...BOAT, seed: 5 }));
});

// -------------------------------------------------------------------- fighter

test('fighter sprite: swept wings, tailplanes, fuselage and canopy, with balanced state', () => {
    const rec = sprite(drawFighter, JET);
    assert.ok(balanced(rec));
    assert.ok(count(rec, 'lineTo') >= 20);
    assert.ok(count(rec, 'ellipse') >= 2, 'canopy');
});

test('a streaking fighter burns an additive afterburner; a parked one blinks its wing lights instead', () => {
    const streaking = sprite(drawFighter, { ...JET, streaking: true });
    const parked = sprite(drawFighter, JET);
    assert.ok(streaking.some(c => c[0] === 'set:globalCompositeOperation' && c[1] === 'lighter'));
    assert.ok(!parked.some(c => c[0] === 'set:globalCompositeOperation' && c[1] === 'lighter'));
    assert.ok(count(streaking, 'quadraticCurveTo') >= 6, 'three flame layers');
    const lights = time => count(sprite(drawFighter, { ...JET, time }), 'fillRect');
    assert.notEqual(lights(0), lights(0.6), 'the lights alternate');
});

test('the fighter faces the way it streaks', () => {
    const scaleX = facing => sprite(drawFighter, { ...JET, facing }).find(c => c[0] === 'scale')[1];
    assert.equal(scaleX(1), 1);
    assert.equal(scaleX(-1), -1);
});

// --------------------------------------------------------------------- audio HUD

test('the speaker icon shows waves when on, a slash when muted and a dim pulse while waiting', () => {
    const icon = state => {
        const rec = [];
        drawAudioIcon(recorder(rec), 0, 0, state, 1);
        return rec;
    };
    assert.equal(count(icon('on'), 'arc'), 2);
    assert.equal(count(icon('locked'), 'arc'), 2);
    assert.equal(count(icon('muted'), 'arc'), 0);
    assert.ok(count(icon('muted'), 'moveTo') > count(icon('on'), 'moveTo'), 'the red cross');
    assert.ok(count(icon('unsupported'), 'moveTo') > count(icon('on'), 'moveTo'));
    const alpha = (state, time) => {
        const rec = [];
        drawAudioIcon(recorder(rec), 0, 0, state, time);
        return rec.find(c => c[0] === 'set:globalAlpha')[1];
    };
    assert.equal(alpha('on', 0), 1);
    assert.notEqual(alpha('locked', 0), alpha('locked', 0.4), 'waiting-for-a-key pulses');
    for (const state of ['on', 'muted', 'locked', 'unsupported']) assert.ok(balanced(icon(state)));
});

test('audio labels are short and tell the player what to do', () => {
    assert.equal(audioLabel('on'), 'SOUND  [M]');
    assert.equal(audioLabel('muted'), 'MUTED  [M]');
    assert.equal(audioLabel('locked'), 'PRESS A KEY');
    assert.equal(audioLabel('unsupported'), 'NO AUDIO');
});

test('the HUD reflects the sound engine\u2019s state', () => {
    const { renderer, draw } = scene();
    renderer.audioState = () => 'muted';
    assert.ok(texts(draw()).includes('MUTED  [M]'));
    renderer.audioState = () => 'on';
    assert.ok(texts(draw()).includes('SOUND  [M]'));
    renderer.audioState = () => 'locked';
    assert.ok(texts(draw()).includes('PRESS A KEY'));
});

test('score popups are colour-tiered: the bigger the prize, the warmer the colour', () => {
    const colors = [30, 60, 80, 100, 500].map(popupColor);
    assert.equal(new Set(colors).size, 5, 'five distinct tiers');
    assert.notEqual(popupColor(0), colors[0], '1UP has its own colour');
    assert.equal(popupColor(1000), popupColor(500));
});

// ------------------------------------------------------------- in the game scene

test('every enemy type in play is drawn, and enemies off-screen are not', () => {
    const { g, draw } = scene();
    const jet = g.session.jet;
    const baseline = draw().length;
    g.session.enemies.set(1, new Helicopter(1, jet.x, jet.y + 250, { speed: 100, direction: 1 }));
    g.session.enemies.set(2, new PatrolBoat(2, jet.x + 80, jet.y + 320, { mode: 'cruiser', speed: 45, direction: -1 }));
    g.session.enemies.set(3, new FighterJet(3, 40, jet.y + 400, { speed: 400, direction: 1 }));
    const withEnemies = draw();
    assert.ok(withEnemies.length > baseline + 150, `${withEnemies.length} vs ${baseline}`);
    assert.ok(count(withEnemies, 'setLineDash') > 0, 'the boat\u2019s wake');
    for (const id of [1, 2, 3]) g.session.enemies.delete(id);
    g.session.enemies.set(4, new Helicopter(4, jet.x, jet.y + 5000, { speed: 100, direction: 1 }));
    g.session.enemies.set(5, new PatrolBoat(5, jet.x, jet.y - 900, { mode: 'cruiser', speed: 45, direction: 1 }));
    g.session.enemies.set(6, new FighterJet(6, 5000, jet.y + 300, { speed: 400, direction: 1 }));
    assert.equal(draw().length, baseline, 'nothing is drawn for enemies outside the view');
});

test('hitbox outlines include the enemies', () => {
    const { g, renderer, draw } = scene();
    const jet = g.session.jet;
    renderer.river.options.showGuides = true;
    const before = count(draw(), 'strokeRect');
    g.session.enemies.set(1, new Helicopter(1, jet.x, jet.y + 250, { speed: 100, direction: 1 }));
    g.session.enemies.set(2, new PatrolBoat(2, jet.x + 80, jet.y + 320, { mode: 'drifter', speed: 0, direction: 1 }));
    assert.equal(count(draw(), 'strokeRect'), before + 2);
});

test('a helicopter\u2019s rotor turns between frames (time-driven animation)', () => {
    const { g, draw } = scene();
    const jet = g.session.jet;
    g.session.enemies.set(1, new Helicopter(1, jet.x, jet.y + 250, { speed: 100, direction: 1 }));
    const lines = () => draw().filter(c => c[0] === 'lineTo').map(c => `${c[1].toFixed(2)},${c[2].toFixed(2)}`).join('|');
    const a = lines();
    g.session.time += 0.013;
    assert.notEqual(lines(), a);
});

test('floating scores and banners are drawn from the session', () => {
    const { g, draw } = scene();
    g.session.popups.push({ x: 400, y: 300, text: '+60', points: 60, age: 0.1, life: 1.2 });
    g.session.popups.push({ x: 300, y: 300, text: '+500', points: 500, age: 0.1, life: 1.2 });
    g.session.popups.push({ x: 500, y: 300, text: '1UP', points: 0, age: 0.1, life: 1.9 });
    g.session.notices.push({ kind: 'stage-clear', title: 'SECTION 1 CLEARED', subtitle: 'BRIDGE DESTROYED  +500', age: 0.5, life: 2.6 });
    g.session.notices.push({ kind: 'extra-life', title: 'EXTRA JET!', subtitle: '10,000 POINTS', age: 0.5, life: 2.6 });
    const t = texts(draw());
    for (const expected of ['+60', '+500', '1UP', 'SECTION 1 CLEARED', 'BRIDGE DESTROYED  +500', 'EXTRA JET!', '10,000 POINTS']) {
        assert.ok(t.includes(expected), expected);
    }
});

test('banners fade in and out and popups rise as they age', () => {
    const { g, draw } = scene();
    const alphaOf = (age, collection) => {
        const rec = draw();
        const idx = rec.findIndex(c => c[0] === 'fillText' && c[1] === collection);
        const prior = rec.slice(0, idx).filter(c => c[0] === 'set:globalAlpha');
        return prior.at(-1)[1];
    };
    g.session.notices.push({ kind: 'stage-clear', title: 'FADE TEST', subtitle: 'x', age: 0.01, life: 2.6 });
    const early = alphaOf(0.01, 'FADE TEST');
    g.session.notices[0].age = 1.3;
    const middle = alphaOf(1.3, 'FADE TEST');
    g.session.notices[0].age = 2.55;
    const late = alphaOf(2.55, 'FADE TEST');
    assert.ok(early < middle && late < middle, `${early} ${middle} ${late}`);
    assert.equal(middle, 1);

    g.session.notices.length = 0;
    const popupY = age => {
        g.session.popups.length = 0;
        g.session.popups.push({ x: 400, y: 300, text: '+80', points: 80, age, life: 1.2 });
        const rec = draw();
        const move = rec.filter(c => c[0] === 'translate').find(c => c[1] === 400);
        return move[2];
    };
    assert.ok(popupY(0.8) < popupY(0.1), 'it floats upward');
});

// -------------------------------------------------------------------- end screens

test('game over: a stat card with the run\u2019s kills, and a replay prompt after a moment', () => {
    const { g, draw } = scene({ startLives: 1 });
    g.session.progression.award('helicopter');
    g.session.progression.award('helicopter');
    g.session.progression.award('patrolBoat');
    g.session.progression.award('fighter');
    g.session.progression.award('depot');
    g.session.progression.award('bridge');
    g.session.jet.destroy('land');
    g.runUntil(h => h.session.gameOver, 10);
    g.run(1.5);
    const found = new Set();
    for (let i = 0; i < 16; i++) {
        g.session.time = i * 0.07;
        for (const line of texts(draw())) found.add(line);
    }
    // 2 x 60 + 30 + 100 + 80 + 500 = 830
    for (const expected of ['GAME OVER', 'FINAL SCORE 830', 'HELICOPTERS', 'PATROL BOATS', 'FIGHTERS', 'FUEL DEPOTS', 'BRIDGES', '2 x 60', '1 x 30', '1 x 100', '1 x 80', '1 x 500', '120', '30', '100', '80', '500']) {
        assert.ok(found.has(expected), `missing "${expected}"`);
    }
    assert.ok([...found].some(s => s.startsWith('SECTION REACHED 2')));
    assert.ok(found.has('PRESS FIRE TO PLAY AGAIN'));
    assert.ok(!found.has('RIVER CLEARED'));
});

test('victory: its own headline, a bridges line and a different prompt', () => {
    const { g, draw } = scene({ startY: 2800, victoryBridges: 1 }, { fire: true });
    g.session.progression.award('fighter');
    g.runUntil(h => h.session.victory, 40);
    g.run(1.5);
    const found = new Set();
    for (let i = 0; i < 16; i++) {
        g.session.time = i * 0.07;
        for (const line of texts(draw())) found.add(line);
    }
    assert.ok(found.has('RIVER CLEARED'));
    assert.ok(found.has('ALL 1 BRIDGES DESTROYED'));
    assert.ok(found.has('PRESS FIRE TO FLY AGAIN'));
    assert.ok(![...found].includes('GAME OVER'));
    assert.ok([...found].some(s => s.startsWith('FINAL SCORE 600')));
});

test('the end screen fades in rather than snapping, and shows an extra-jets line when earned', () => {
    const { g, draw } = scene({ startLives: 1 });
    g.session.progression.addPoints(10000); // earns a spare jet (2 lives)...
    g.session.progression.loseLife(); // ...which is spent again, so the next loss ends the run
    g.session.jet.destroy('land');
    g.runUntil(h => h.session.gameOver, 10);
    g.session.gameOverTime = 0.05;
    const alphaAtDimmer = () => {
        const rec = draw();
        const idx = rec.findIndex(c => c[0] === 'fillRect' && c[3] === 960 && c[4] === 720);
        return rec.slice(0, idx).filter(c => c[0] === 'set:globalAlpha').at(-1)[1];
    };
    const early = alphaAtDimmer();
    g.session.gameOverTime = 1;
    assert.ok(early < alphaAtDimmer());
    assert.ok(texts(draw()).includes('EXTRA JETS EARNED 1'));
});

test('pause still overlays the playfield but never replaces an end screen', () => {
    const { g, draw } = scene();
    g.run(0.3);
    assert.ok(texts(draw(true)).includes('PAUSED'));
    g.session.victory = true;
    const t = texts(draw(true));
    assert.ok(!t.includes('PAUSED'));
    assert.ok(t.includes('RIVER CLEARED'));
});
