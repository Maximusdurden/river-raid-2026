import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { DEFAULT_DISPLAY_FLAGS, parseFlag, resolveDisplayFlags } from '../dist/src/core/DisplayFlags.js';
import { CELEBRATION_SPECS, Celebration } from '../dist/src/rendering/Celebration.js';
import { CELEBRATION_BANNER_Y, CELEBRATION_TOP, GameRenderer, SCORES_HINT } from '../dist/src/rendering/GameRenderer.js';
import { ParticleSystem } from '../dist/src/rendering/Particles.js';
import { RiverGenerator } from '../dist/src/world/RiverGenerator.js';
import { headlessGame } from './helpers.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ============================================================ production display defaults

test('both developer overlays are off by default', () => {
    assert.deepEqual({ ...DEFAULT_DISPLAY_FLAGS }, { showHitboxes: false, showDebugOverlay: false });
    assert.deepEqual(resolveDisplayFlags(''), { showHitboxes: false, showDebugOverlay: false });
    assert.deepEqual(resolveDisplayFlags('?'), { showHitboxes: false, showDebugOverlay: false });
    assert.deepEqual(resolveDisplayFlags('?seed=2026'), { showHitboxes: false, showDebugOverlay: false });
});

test('only an explicit dev flag turns them on, one at a time or together', () => {
    assert.deepEqual(resolveDisplayFlags('?debug=1'), { showHitboxes: false, showDebugOverlay: true });
    assert.deepEqual(resolveDisplayFlags('?hitboxes=1'), { showHitboxes: true, showDebugOverlay: false });
    assert.deepEqual(resolveDisplayFlags('?dev=1'), { showHitboxes: true, showDebugOverlay: true });
    assert.deepEqual(resolveDisplayFlags('debug=true&hitboxes=yes'), { showHitboxes: true, showDebugOverlay: true });
    assert.deepEqual(resolveDisplayFlags('?seed=7&debug=on'), { showHitboxes: false, showDebugOverlay: true });
});

test('anything else, however hopeful, leaves them off: no value, 0, false, junk, or a flag that is merely present', () => {
    for (const query of ['?debug', '?debug=', '?debug=0', '?debug=false', '?debug=no', '?debug=off', '?debug=2', '?debug=%20', '?hitboxes=nope', '?DEBUG=1', '?dev=0', '?dev']) {
        assert.deepEqual(resolveDisplayFlags(query), { showHitboxes: false, showDebugOverlay: false }, query);
    }
    assert.equal(parseFlag(null), false);
    assert.equal(parseFlag(' TRUE '), true);
});

test('the flags are never remembered: nothing reads or writes storage', () => {
    const source = readFileSync(join(ROOT, 'src/core/DisplayFlags.ts'), 'utf8');
    assert.doesNotMatch(source, /localStorage|sessionStorage|getItem|setItem|STORAGE_KEYS/);
});

const saved = {};
let dom;
let calls;

function recorder(log) {
    const state = {};
    return new Proxy({}, {
        get(_t, prop) {
            if (prop in state) return state[prop];
            if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return (...args) => { log.push([String(prop), ...args]); return { addColorStop() {} }; };
            if (prop === 'createPattern') return () => ({ setTransform() {} });
            if (prop === 'measureText') return text => ({ width: String(text).length * 7 });
            return (...args) => { log.push([String(prop), ...args]); };
        },
        set(_t, prop, value) { state[prop] = value; log.push(['set:' + String(prop), value]); return true; },
    });
}

before(() => {
    dom = new JSDOM('<canvas id="c"></canvas><div id="host"></div>');
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

function scene({ ended = false } = {}) {
    const g = headlessGame({ seed: 2026, game: { depots: { chance: 0 } } });
    const renderer = new GameRenderer(document.getElementById('c'), new RiverGenerator(2026), g.session);
    renderer.setWorld(g.engine.world);
    if (ended) {
        g.session.gameOver = true;
        g.session.gameOverTime = 2;
    }
    const draw = () => {
        calls.length = 0;
        const stats = g.engine.getStats();
        renderer.render({ previousCameraY: stats.cameraY, cameraY: stats.cameraY, previousTime: 1, time: 1, paused: false }, 1);
        return calls.slice();
    };
    return { g, renderer, draw };
}
const texts = rec => rec.filter(c => c[0] === 'fillText').map(c => String(c[1]));
const strokes = rec => rec.filter(c => c[0] === 'strokeRect');

test('a new game renderer draws no hitboxes and no guides: showHitboxes is false and the toggle really switches it', () => {
    const s = scene();
    assert.equal(s.renderer.showHitboxes, false);
    assert.equal(s.renderer.river.options.showGuides, false);
    const off = s.draw();
    assert.equal(strokes(off).length, 0, 'no outline rectangles at all');
    s.renderer.showHitboxes = true;
    assert.equal(s.renderer.river.options.showGuides, true, 'the toggle drives the guides');
    assert.ok(strokes(s.draw()).length > 0, 'and now the hitboxes are drawn');
    s.renderer.showHitboxes = false;
    assert.equal(strokes(s.draw()).length, 0, 'and off again');
});

test('a renderer built with the guides on starts on, and one built with options left out starts off', () => {
    const g = headlessGame({ seed: 2026, game: {} });
    const on = new GameRenderer(document.getElementById('c'), new RiverGenerator(2026), g.session, { showGuides: true });
    const plain = new GameRenderer(document.getElementById('c'), new RiverGenerator(2026), g.session);
    assert.equal(on.showHitboxes, true);
    assert.equal(plain.showHitboxes, false);
    assert.equal(new GameRenderer(document.getElementById('c'), new RiverGenerator(2026), g.session, {}).showHitboxes, false);
});

test('the page ships with both toggles unticked and refusing to be restored', () => {
    const html = readFileSync(join(ROOT, 'demo.html'), 'utf8');
    const page = new JSDOM(html.replace(/<script[\s\S]*?<\/script>/g, '')).window.document;
    for (const id of ['guides-toggle', 'debug-toggle']) {
        const box = page.getElementById(id);
        assert.equal(box.checked, false, `${id} starts unticked`);
        assert.equal(box.defaultChecked, false);
        assert.equal(box.getAttribute('autocomplete'), 'off');
    }
});

test('the game script sets both from the flags on every load and hides the overlay until asked', () => {
    const main = readFileSync(join(ROOT, 'src/main.ts'), 'utf8');
    assert.match(main, /resolveDisplayFlags\(location\.search\)/);
    assert.match(main, /guidesToggle\.checked = displayFlags\.showHitboxes/);
    assert.match(main, /debugToggle\.checked = displayFlags\.showDebugOverlay/);
    assert.match(main, /debug\.hidden = !displayFlags\.showDebugOverlay/);
    assert.match(main, /showGuides: displayFlags\.showHitboxes/);
    assert.doesNotMatch(main, /showGuides: guidesToggle\.checked/, 'never initialised from whatever the checkbox happens to hold');
});

// ================================================================ the celebration schedule

const collect = (show, seconds, dt = 1 / 60) => {
    const bursts = [];
    for (let t = 0; t < seconds; t += dt) show.update(dt, b => bursts.push({ ...b, at: t }));
    return bursts;
};

test('nothing happens until a celebration is started, and stopping ends it', () => {
    const show = new Celebration();
    assert.deepEqual([show.active, show.kind, show.age, show.intensity], [false, null, 0, 0]);
    assert.deepEqual(collect(show, 2), []);
    show.start('record');
    assert.deepEqual([show.active, show.kind], [true, 'record']);
    show.stop();
    assert.deepEqual([show.active, show.kind, show.age], [false, null, 0]);
    assert.deepEqual(collect(show, 2), []);
});

test('a normal high score gets a modest show: bursts every half second or so for a few seconds', () => {
    const show = new Celebration();
    show.start('high-score');
    const bursts = collect(show, 10);
    const spec = CELEBRATION_SPECS['high-score'];
    assert.ok(bursts.length >= 5 && bursts.length <= Math.ceil(spec.duration / spec.interval) + 1, `${bursts.length} bursts`);
    assert.ok(bursts[0].at < 0.1, 'the first is almost immediate');
    assert.ok(bursts.at(-1).at <= spec.duration + 0.05, 'and they stop');
    assert.deepEqual(bursts.map(b => b.index), bursts.map((_, i) => i));
});

test('an all-time record gets a bigger, longer, faster show', () => {
    const normal = new Celebration();
    const record = new Celebration();
    normal.start('high-score');
    record.start('record');
    const a = collect(normal, 10);
    const b = collect(record, 10);
    assert.ok(b.length > a.length * 2, `${b.length} vs ${a.length}`);
    assert.ok(b.at(-1).at > a.at(-1).at, 'it lasts longer');
    const mean = list => list.reduce((s, x) => s + x.scale, 0) / list.length;
    assert.ok(mean(b) > mean(a), 'the bursts are bigger');
    assert.ok(CELEBRATION_SPECS.record.interval < CELEBRATION_SPECS['high-score'].interval);
});

test('fireworks go off inside the visible river, at sizes within the kind\'s range', () => {
    for (const kind of ['high-score', 'record']) {
        const show = new Celebration();
        show.start(kind);
        const spec = CELEBRATION_SPECS[kind];
        for (const b of collect(show, 8)) {
            assert.ok(b.x >= 0 && b.x <= 960 && b.y >= 0 && b.y <= 720, `${kind}: on screen (${b.x.toFixed(0)}, ${b.y.toFixed(0)})`);
            assert.ok(b.scale >= spec.minScale && b.scale <= spec.maxScale);
        }
    }
});

test('a celebration plays out identically every time, and a restart begins it again', () => {
    const run = kind => { const s = new Celebration(); s.start(kind); return collect(s, 5).map(b => [b.x, b.y, b.scale]); };
    assert.deepEqual(run('record'), run('record'));
    assert.notDeepEqual(run('record'), run('high-score'));
    const show = new Celebration();
    show.start('record');
    const first = collect(show, 3).length;
    show.start('record');
    assert.equal(collect(show, 3).length, first, 'starting again resets the schedule');
    assert.equal(show.burstCount, first);
});

test('the glow settles: intensity starts at 1, falls to 0, and bad time steps are ignored', () => {
    const show = new Celebration();
    show.start('record');
    assert.equal(show.intensity, 1);
    collect(show, 4);
    assert.ok(show.intensity > 0 && show.intensity < 1);
    collect(show, 20);
    assert.equal(show.intensity, 0);
    const before = show.age;
    for (const bad of [0, -1, NaN, Infinity]) show.update(bad, () => assert.fail('no burst for a bad step'));
    assert.equal(show.age, before);
});

test('an enormous time step cannot flood the screen with bursts', () => {
    const show = new Celebration();
    show.start('record');
    let n = 0;
    show.update(5, () => n++);
    assert.ok(n <= Math.ceil(5 / CELEBRATION_SPECS.record.interval) + 1, `${n}`);
});

// ========================================================================= drawing

test('the HUD reminds the player that H opens the high scores', () => {
    const s = scene();
    assert.ok(texts(s.draw()).includes(SCORES_HINT));
    assert.equal(SCORES_HINT, '[H] HIGH SCORES');
});

test('a high-score celebration paints a golden border and a NEW HIGH SCORE banner over the end screen', () => {
    const s = scene({ ended: true });
    const quiet = s.draw();
    assert.ok(!texts(quiet).some(t => /HIGH SCORE!|RECORD/.test(t)), 'no banner without a celebration');
    assert.equal(strokes(quiet).length, 0);
    s.renderer.celebration.start('high-score');
    s.renderer.celebration.update(1, () => {});
    const rec = s.draw();
    assert.ok(texts(rec).includes('NEW HIGH SCORE!'));
    assert.ok(!texts(rec).some(t => /ALL-TIME/.test(t)));
    assert.ok(strokes(rec).length >= 1, 'the border');
    assert.ok(rec.some(c => c[0] === 'set:strokeStyle' && /255, 214, 64/.test(String(c[1]))), 'in gold');
});

test('beating the record paints the ALL-TIME RECORD banner with stars and a double border', () => {
    const s = scene({ ended: true });
    s.renderer.celebration.start('record');
    s.renderer.celebration.update(1, () => {});
    const rec = s.draw();
    assert.ok(texts(rec).includes('\u2605 NEW ALL-TIME RECORD! \u2605'));
    assert.equal(strokes(rec).length, 2, 'an inner and an outer frame');
    const widths = rec.filter(c => c[0] === 'set:lineWidth').map(c => c[1]);
    assert.ok(widths.includes(10), 'the thick neon line');
});

test('the border flashes: its brightness changes from moment to moment', () => {
    const s = scene({ ended: true });
    s.renderer.celebration.start('record');
    const alphas = new Set();
    for (let i = 0; i < 30; i++) {
        s.renderer.celebration.update(0.05, () => {});
        const border = s.draw().filter(c => c[0] === 'set:strokeStyle' && /255, 214, 64/.test(String(c[1]))).map(c => String(c[1]));
        for (const b of border) alphas.add(b);
    }
    assert.ok(alphas.size > 5, `${alphas.size} distinct border colours`);
});

test('the banner has room: the verdict moves down and the banner sits between the score panel and GAME OVER', () => {
    const s = scene({ ended: true });
    const verdictY = rec => rec.find(c => c[0] === 'fillText' && c[1] === 'GAME OVER')[3];
    const plainY = verdictY(s.draw());
    assert.equal(plainY, 150, 'normally the verdict starts at 150');
    s.renderer.celebration.start('record');
    s.renderer.celebration.update(1, () => {});
    const rec = s.draw();
    assert.equal(verdictY(rec), CELEBRATION_TOP);
    const banner = rec.find(c => c[0] === 'fillText' && /RECORD/.test(c[1]));
    assert.ok(banner, 'the banner is drawn');
    const bannerY = rec.filter(c => c[0] === 'translate').map(c => c[2]).find(y => Math.abs(y - CELEBRATION_BANNER_Y) <= 3);
    assert.ok(bannerY !== undefined, 'at its own line');
    const half = 24; // half the height of the 46px banner text
    assert.ok(bannerY - half > 80, 'clear of the score panel (which ends at y=80)');
    assert.ok(bannerY + half < CELEBRATION_TOP - 46, 'and clear of the top of the GAME OVER letters (64px text, baseline at the top value)');
    s.renderer.celebration.stop();
    assert.equal(verdictY(s.draw()), 150, 'and it goes back');
});

test('fireworks are drawn again on top of the dimmed end screen, so they stay bright', () => {
    const s = scene({ ended: true });
    const original = s.g.session.particles.render.bind(s.g.session.particles);
    s.g.session.particles.render = (...args) => { calls.push(['PARTICLES']); original(...args); };
    const markers = rec => rec.flatMap((c, i) => (c[0] === 'PARTICLES' ? [i] : []));
    const verdictAt = rec => rec.findIndex(c => c[0] === 'fillText' && c[1] === 'GAME OVER');
    const quiet = s.draw();
    assert.equal(markers(quiet).length, 1, 'without a celebration the particles are drawn once, under the end screen');
    assert.ok(markers(quiet)[0] < verdictAt(quiet));
    s.renderer.celebration.start('high-score');
    s.renderer.celebration.update(1, () => {});
    const lit = s.draw();
    assert.equal(markers(lit).length, 2);
    assert.ok(markers(lit)[1] > verdictAt(lit), 'the second pass comes after the end screen');
    // Not during play: nothing to brighten.
    const playing = scene({ ended: false });
    playing.g.session.particles.render = (...args) => { calls.push(['PARTICLES']); void args; };
    playing.renderer.celebration.start('high-score');
    assert.equal(markers(playing.draw()).length, 1);
});

test('the celebration is drawn only on the end screen, and stopping it clears it', () => {
    const s = scene({ ended: false });
    s.renderer.celebration.start('record');
    assert.ok(!texts(s.draw()).some(t => /RECORD/.test(t)), 'not during play');
    const over = scene({ ended: true });
    over.renderer.celebration.start('record');
    over.renderer.celebration.update(1, () => {});
    assert.ok(texts(over.draw()).some(t => /RECORD/.test(t)));
    over.renderer.celebration.stop();
    assert.ok(!texts(over.draw()).some(t => /RECORD/.test(t)));
});

// ======================================================================= fireworks

test('a firework fills the air with golden sparks, flames and a ring, and everything dies away', () => {
    const particles = new ParticleSystem({ capacity: 4000 });
    particles.celebrate(480, 300, 1);
    const live = particles.snapshot();
    const kinds = new Set(live.map(p => p.kind));
    for (const kind of ['spark', 'fire', 'shockwave']) assert.ok(kinds.has(kind), kind);
    assert.ok(live.filter(p => p.kind === 'spark').length >= 40);
    for (let i = 0; i < 60 * 3; i++) particles.update(1 / 60);
    assert.equal(particles.count, 0, 'all gone within 3 seconds');
});

test('a bigger firework has more sparks, and it never overflows the pool', () => {
    const count = scale => { const p = new ParticleSystem({ capacity: 4000 }); p.celebrate(0, 0, scale); return p.count; };
    assert.ok(count(2) > count(1) && count(1) > count(0.5));
    const small = new ParticleSystem({ capacity: 20 });
    small.celebrate(0, 0, 3);
    assert.equal(small.count, 20, 'filled to capacity and no more');
    assert.ok(small.dropped > 0);
});
