import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ParticleSystem } from '../dist/src/rendering/Particles.js';
import { DT } from './helpers.mjs';

function recordingContext() {
    const calls = [];
    const state = {};
    const ctx = new Proxy({}, {
        get(_t, prop) {
            if (prop in state) return state[prop];
            return (...args) => {
                calls.push([String(prop), ...args]);
            };
        },
        set(_t, prop, value) {
            state[prop] = value;
            return true;
        },
    });
    return { ctx, calls };
}

test('emit, update and expiry recycle particles', () => {
    const system = new ParticleSystem({ capacity: 10, seed: 1 });
    for (let i = 0; i < 5; i++) system.emit({ kind: 'spark', x: i, y: 0, life: 0.1, size: 1 });
    assert.equal(system.count, 5);
    for (let i = 0; i < 5; i++) system.update(DT);
    assert.equal(system.count, 5);
    system.update(0.2);
    assert.equal(system.count, 0);
});

test('a full pool drops new particles and counts them, then recovers', () => {
    const system = new ParticleSystem({ capacity: 5, seed: 1 });
    let accepted = 0;
    for (let i = 0; i < 8; i++) if (system.emit({ kind: 'fire', x: 0, y: 0, life: 1, size: 1 })) accepted++;
    assert.equal(accepted, 5);
    assert.equal(system.count, 5);
    assert.equal(system.dropped, 3);
    system.update(2);
    assert.equal(system.count, 0);
    assert.equal(system.emit({ kind: 'fire', x: 0, y: 0, life: 1, size: 1 }), true);
});

test('swap-removal keeps the survivors intact', () => {
    const system = new ParticleSystem({ capacity: 10 });
    const lives = [0.05, 5, 0.05, 5, 0.05, 5];
    lives.forEach((life, i) => system.emit({ kind: 'spark', x: i, y: 0, life, size: 1 }));
    system.update(0.1);
    const left = system.snapshot().map(p => p.x).sort((a, b) => a - b);
    assert.deepEqual(left, [1, 3, 5]);
    for (const p of system.snapshot()) assert.ok(Math.abs(p.age - 0.1) < 1e-9);
});

test('motion integrates velocity with exponential drag', () => {
    const system = new ParticleSystem({ capacity: 4 });
    system.emit({ kind: 'debris', x: 0, y: 0, vx: 100, vy: 50, life: 10, size: 2, drag: 2 });
    system.emit({ kind: 'debris', x: 0, y: 0, vx: 100, vy: 50, life: 10, size: 2, drag: 0 });
    system.update(0.5);
    const [dragged, free] = system.snapshot();
    assert.ok(free.x === 50 && free.y === 25);
    assert.ok(dragged.x < free.x && dragged.x > 0);
    assert.ok(Math.abs(dragged.vx - 100 * Math.exp(-1)) < 1e-9);
    assert.equal(dragged.previousX, 0);
});

test('explosions emit every effect kind and finish within a few seconds', () => {
    const system = new ParticleSystem({ seed: 3 });
    system.explosion(100, 200, 1);
    const kinds = new Set(system.snapshot().map(p => p.kind));
    for (const kind of ['shockwave', 'fire', 'smoke', 'spark', 'debris']) assert.ok(kinds.has(kind), kind);
    assert.ok(system.count > 25);
    for (const p of system.snapshot()) assert.ok(p.x !== undefined && Number.isFinite(p.vy));
    for (let i = 0; i < 60 * 3; i++) system.update(DT);
    assert.equal(system.count, 0);
});

test('bigger explosions use more particles', () => {
    const small = new ParticleSystem({ seed: 3 });
    const large = new ParticleSystem({ seed: 3 });
    small.explosion(0, 0, 0.5);
    large.explosion(0, 0, 2);
    assert.ok(large.count > small.count * 2);
});

test('several large explosions fit the default pool without dropping', () => {
    const system = new ParticleSystem({ seed: 3 });
    for (let i = 0; i < 6; i++) system.explosion(i * 100, 0, 1.5);
    system.explosion(0, 0, 1.4);
    assert.equal(system.dropped, 0);
});

test('impact sparks and afterburner trails', () => {
    const system = new ParticleSystem({ seed: 4 });
    system.impactSparks(10, 10, 6);
    assert.ok(system.count >= 6);
    system.clear();
    assert.equal(system.count, 0);

    const fast = new ParticleSystem({ seed: 9 });
    const slow = new ParticleSystem({ seed: 9 });
    for (let i = 0; i < 300; i++) {
        fast.afterburner(480, 170, 420, 1);
        slow.afterburner(480, 170, 90, -1);
    }
    assert.ok(fast.count > slow.count * 1.5, `boost ${fast.count} vs brake ${slow.count}`);
    for (const p of fast.snapshot()) assert.equal(p.kind, 'exhaust');
    const trail = fast.snapshot()[0];
    assert.ok(trail.vy < 420 && trail.vy > 0, 'exhaust trails the jet (slower than it)');
});

test('visual randomness is reproducible from the seed', () => {
    const run = seed => {
        const system = new ParticleSystem({ seed });
        system.explosion(50, 50, 1);
        system.update(0.1);
        return system.snapshot();
    };
    assert.deepEqual(run(11), run(11));
    assert.notDeepEqual(run(11), run(12));
    const reseeded = new ParticleSystem({ seed: 1 });
    reseeded.reseed(11);
    reseeded.explosion(50, 50, 1);
    reseeded.update(0.1);
    assert.deepEqual(reseeded.snapshot(), run(11));
});

test('render draws on-screen particles and skips off-screen ones', () => {
    const system = new ParticleSystem({ seed: 1 });
    system.explosion(480, 360, 1);
    const onScreen = recordingContext();
    system.render(onScreen.ctx, 0, 1, 720);
    assert.ok(onScreen.calls.length > 20);
    assert.ok(onScreen.calls.some(c => c[0] === 'arc'));
    assert.ok(onScreen.calls.some(c => c[0] === 'stroke'));
    assert.deepEqual(onScreen.calls.at(0)?.[0], 'save');
    assert.equal(onScreen.calls.at(-1)?.[0], 'restore');

    const offScreen = recordingContext();
    system.render(offScreen.ctx, 5000, 1, 720); // camera far above the explosion
    assert.equal(offScreen.calls.filter(c => c[0] === 'arc' || c[0] === 'stroke' || c[0] === 'fillRect').length, 0);

    const empty = recordingContext();
    new ParticleSystem().render(empty.ctx, 0, 1, 720);
    assert.equal(empty.calls.length, 0);
});

test('render interpolates between previous and current positions', () => {
    const system = new ParticleSystem({ seed: 1 });
    system.emit({ kind: 'fire', x: 100, y: 100, vx: 100, life: 5, size: 3 });
    system.update(1);
    const arcX = alpha => {
        const { ctx, calls } = recordingContext();
        system.render(ctx, 0, alpha, 720);
        return calls.find(c => c[0] === 'arc')?.[1];
    };
    assert.ok(Math.abs(arcX(0) - 100) < 1e-9);
    assert.ok(Math.abs(arcX(1) - 200) < 1e-9);
    assert.ok(Math.abs(arcX(0.5) - 150) < 1e-9);
});

test('invalid capacity and steps', () => {
    assert.throws(() => new ParticleSystem({ capacity: 0 }), RangeError);
    assert.throws(() => new ParticleSystem({ capacity: 2.5 }), RangeError);
    const system = new ParticleSystem({ capacity: 2 });
    system.emit({ kind: 'spark', x: 0, y: 0, life: 1, size: 1 });
    system.update(NaN);
    system.update(-1);
    assert.equal(system.snapshot()[0].age, 0);
});
