import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Enemy, patrolBounds } from '../dist/src/entities/enemies/Enemy.js';
import { FighterJet } from '../dist/src/entities/enemies/FighterJet.js';
import { Helicopter } from '../dist/src/entities/enemies/Helicopter.js';
import { PatrolBoat } from '../dist/src/entities/enemies/PatrolBoat.js';
import { DT, FakeRiver, StaticEnemy } from './helpers.mjs';

const context = (world, overrides = {}) => ({ world, playerX: 480, playerY: 0, playerFlying: true, time: 0, ...overrides });

function simulate(enemy, world, seconds, step = () => {}, ctx = {}) {
    const trace = [];
    for (let i = 0, n = Math.round(seconds * 60); i < n; i++) {
        enemy.update(DT, context(world, ctx));
        step(enemy, i);
        trace.push({ x: enemy.x, y: enemy.y, vx: enemy.vx, alive: enemy.alive });
    }
    return trace;
}

// --------------------------------------------------------------------- shared

test('hitboxes, points and kinds match the specification', () => {
    const h = new Helicopter(1, 400, 1000, { speed: 100, direction: 1 });
    const b = new PatrolBoat(2, 400, 1000, { mode: 'cruiser', speed: 45, direction: 1 });
    const f = new FighterJet(3, 10, 1000, { speed: 400, direction: 1 });
    assert.deepEqual([h.kind, h.width, h.height, h.points, h.flies], ['helicopter', 24, 18, 60, false]);
    assert.deepEqual([b.kind, b.width, b.height, b.points, b.flies], ['patrol-boat', 36, 14, 30, false]);
    assert.deepEqual([f.kind, f.width, f.height, f.points, f.flies], ['fighter', 20, 22, 100, true]);
    assert.deepEqual(h.hitbox, { x: 400, y: 1000, width: 24, height: 18 });
    for (const e of [h, b, f]) assert.ok(e instanceof Enemy);
});

test('sweptHitbox covers both the previous and the current position', () => {
    const e = new StaticEnemy(1, 100, 500, { width: 20, height: 10 });
    e.previousX = 60;
    e.x = 100;
    e.previousY = 490;
    e.y = 500;
    const box = e.sweptHitbox;
    assert.equal(box.x - box.width / 2, 50);
    assert.equal(box.x + box.width / 2, 110);
    assert.equal(box.y - box.height / 2, 485);
    assert.equal(box.y + box.height / 2, 505);
});

test('destroy and despawn are one-shot and distinguish a kill from leaving play', () => {
    const killed = new StaticEnemy(1, 0, 0);
    killed.vx = 50;
    killed.destroy();
    assert.deepEqual([killed.alive, killed.destroyed, killed.despawned, killed.vx], [false, true, false, 0]);
    killed.despawn();
    assert.equal(killed.despawned, false, 'a dead enemy cannot also despawn');

    const gone = new StaticEnemy(2, 0, 0);
    gone.despawn();
    gone.destroy();
    assert.deepEqual([gone.alive, gone.destroyed, gone.despawned], [false, false, true]);
});

test('update ignores dead enemies and non-positive or non-finite steps', () => {
    const world = new FakeRiver();
    const e = new Helicopter(1, 480, 1000, { speed: 100, direction: 1 });
    for (const dt of [0, -1, NaN, Infinity]) e.update(dt, context(world));
    assert.equal(e.age, 0);
    assert.equal(e.x, 480);
    e.destroy();
    e.update(DT, context(world));
    assert.equal(e.age, 0);
});

test('previous position is recorded each step for interpolation', () => {
    const world = new FakeRiver();
    const e = new Helicopter(1, 480, 1000, { speed: 100, direction: 1 });
    e.update(DT, context(world));
    e.update(DT, context(world));
    const x = e.x;
    e.update(DT, context(world));
    assert.equal(e.previousX, x);
});

// ----------------------------------------------------------------- patrolBounds

test('patrolBounds: a straight channel gives bank + half-width + margin', () => {
    const world = new FakeRiver({ left: 200, right: 760 });
    assert.deepEqual(patrolBounds(world, 480, 1000, 12, 9), { min: 214, max: 746 });
    assert.deepEqual(patrolBounds(world, 480, 1000, 18, 7), { min: 220, max: 740 });
});

test('patrolBounds: slanted banks use the tightest row anywhere inside the hull', () => {
    // Left bank leans into the river as Y rises (x = 200 + 0.5 y), right bank is straight.
    const world = new FakeRiver({ left: y => 200 + 0.5 * (y - 1000), right: 760 });
    const b = patrolBounds(world, 480, 1000, 12, 9);
    // The hull's top edge is at y = 1009: the bank is at 204.5 there.
    assert.equal(b.min, 200 + 0.5 * 9 + 12 + 2);
    // A narrowing right bank is caught on the bottom edge instead.
    const other = new FakeRiver({ left: 200, right: y => 760 - 0.5 * (y - 1000) });
    assert.equal(patrolBounds(other, 480, 1000, 12, 9).max, 760 - 0.5 * 9 - 12 - 2);
});

test('patrolBounds: an island limits the channel on its side; either channel is found from x', () => {
    const world = new FakeRiver({ left: 200, right: 760, island: [400, 520] });
    assert.deepEqual(patrolBounds(world, 300, 1000, 12, 9), { min: 214, max: 386 });
    assert.deepEqual(patrolBounds(world, 650, 1000, 12, 9), { min: 534, max: 746 });
});

test('patrolBounds: returns null when the channel is too narrow for the hull', () => {
    const world = new FakeRiver({ left: 200, right: 230 });
    assert.equal(patrolBounds(world, 215, 1000, 18, 7), null);
    assert.notEqual(patrolBounds(world, 215, 1000, 6, 7), null);
});

// ------------------------------------------------------------------ helicopter

test('helicopter speed must be within 80..245 (140 is normal; endless mode goes up to 1.75x)', () => {
    for (const speed of [79.9, 245.1, NaN, Infinity]) {
        assert.throws(() => new Helicopter(1, 400, 1000, { speed, direction: 1 }), RangeError);
    }
    for (const speed of [80, 110, 140, 200, 245]) assert.doesNotThrow(() => new Helicopter(1, 400, 1000, { speed, direction: -1 }));
});

test('a sped-up helicopter turns around harder in proportion; a normal one is unchanged', () => {
    assert.equal(new Helicopter(1, 400, 1000, { speed: 100, direction: 1 }).acceleration, 240);
    assert.equal(new Helicopter(1, 400, 1000, { speed: 140, direction: 1 }).acceleration, 240);
    assert.equal(new Helicopter(1, 400, 1000, { speed: 245, direction: 1 }).acceleration, 240 * 1.75);
});

test('helicopter patrols the whole channel: always within bounds, reaching both ends', () => {
    const world = new FakeRiver({ left: 200, right: 760 });
    const heli = new Helicopter(1, 480, 1000, { speed: 140, direction: 1 });
    const trace = simulate(heli, world, 40);
    const xs = trace.map(t => t.x);
    assert.ok(Math.min(...xs) >= 214 - 1e-9, `left ${Math.min(...xs)}`);
    assert.ok(Math.max(...xs) <= 746 + 1e-9, `right ${Math.max(...xs)}`);
    assert.ok(Math.min(...xs) < 240 && Math.max(...xs) > 720, 'sweeps nearly the full channel');
    assert.ok(trace.every(t => t.y === 1000), 'holds its place along the river');
    assert.equal(heli.alive, true);
});

test('helicopter lateral speed reaches its cruise speed and never exceeds it', () => {
    for (const speed of [80, 110, 140]) {
        const world = new FakeRiver({ left: 100, right: 860 });
        const heli = new Helicopter(1, 480, 1000, { speed, direction: 1 });
        const peak = Math.max(...simulate(heli, world, 20).map(t => Math.abs(t.vx)));
        assert.ok(peak <= speed + 1e-9, `${peak} > ${speed}`);
        assert.ok(peak > speed - 1e-6, `${peak} < ${speed}`);
    }
});

test('helicopter reversals are smooth: it brakes to a stop, then accelerates the other way', () => {
    const world = new FakeRiver({ left: 200, right: 760 });
    const heli = new Helicopter(1, 700, 1000, { speed: 140, direction: 1 });
    const trace = simulate(heli, world, 12);
    const maxStep = heli.acceleration * DT + 1e-9;
    let reversals = 0;
    for (let i = 1; i < trace.length; i++) {
        assert.ok(Math.abs(trace[i].vx - trace[i - 1].vx) <= maxStep, `jerk at tick ${i}`);
        if (Math.sign(trace[i].vx) !== Math.sign(trace[i - 1].vx) && trace[i - 1].vx !== 0) {
            reversals++;
            assert.ok(Math.abs(trace[i - 1].vx) < maxStep, 'velocity passes through zero, it does not flip');
        }
    }
    assert.ok(reversals >= 3, `only ${reversals} reversals`);
});

test('helicopter does not slam into the bank: it stops before the bound without clamping', () => {
    const world = new FakeRiver({ left: 200, right: 760 });
    const heli = new Helicopter(1, 700, 1000, { speed: 140, direction: 1 });
    let clamped = 0;
    const original = heli.clampX.bind(heli);
    heli.clampX = b => {
        const hit = original(b);
        if (hit) clamped++;
        return hit;
    };
    simulate(heli, world, 30);
    assert.equal(clamped, 0);
});

test('helicopter between a bank and an island turns before the island', () => {
    const world = new FakeRiver({ left: 200, right: 760, island: [400, 560] });
    const left = new Helicopter(1, 300, 1000, { speed: 120, direction: 1 });
    const xs = simulate(left, world, 30).map(t => t.x);
    assert.ok(Math.max(...xs) <= 400 - 12 - 2 + 1e-9, `reached the island at ${Math.max(...xs)}`);
    assert.ok(Math.min(...xs) >= 214 - 1e-9);
    const right = new Helicopter(2, 650, 1000, { speed: 120, direction: -1 });
    const rx = simulate(right, world, 30).map(t => t.x);
    assert.ok(Math.min(...rx) >= 560 + 12 + 2 - 1e-9);
    assert.ok(Math.max(...rx) <= 746 + 1e-9);
});

test('helicopter in a tight channel slows its patrol so it can still stop in time', () => {
    // Bounds are 414..466 (52 wide): stopping from 140 u/s would need 41 units each way, so
    // the cruise speed is capped at sqrt(2 * 240 * 25) = 109.5 units/s.
    const world = new FakeRiver({ left: 400, right: 480 });
    const heli = new Helicopter(1, 440, 1000, { speed: 140, direction: 1 });
    const trace = simulate(heli, world, 20);
    assert.ok(trace.every(t => t.x >= 414 - 1e-9 && t.x <= 466 + 1e-9));
    assert.ok(Math.max(...trace.map(t => Math.abs(t.vx))) < 110, 'cruise speed is capped by the room');
    assert.ok(trace.some(t => t.vx > 10) && trace.some(t => t.vx < -10), 'still patrols both ways');
});

test('helicopter in a channel with no room despawns', () => {
    const world = new FakeRiver({ left: 400, right: 420 });
    const heli = new Helicopter(1, 410, 1000, { speed: 100, direction: 1 });
    heli.update(DT, context(world));
    assert.equal(heli.alive, false);
    assert.equal(heli.despawned, true);
    assert.equal(heli.destroyed, false);
});

test('helicopter follows banks that move with Y (it is held in place, the river is not)', () => {
    // Same helicopter, but the world's banks are re-evaluated every step; narrowing squeezes it inward.
    let right = 760;
    const world = new FakeRiver({ left: 200, right: () => right });
    const heli = new Helicopter(1, 700, 1000, { speed: 100, direction: 1 });
    for (let i = 0; i < 600; i++) {
        if (i === 120) right = 600;
        heli.update(DT, context(world));
        assert.ok(heli.x <= right - 14 + 1e-9, `tick ${i}: ${heli.x}`);
    }
});

test('rotor angle spins fast, is per-helicopter, and lean follows velocity', () => {
    const a = new Helicopter(1, 480, 1000, { speed: 100, direction: 1 });
    const b = new Helicopter(2, 480, 1000, { speed: 100, direction: 1 });
    assert.notEqual(a.rotorAngle(0), b.rotorAngle(0));
    assert.ok(a.rotorAngle(1) >= 0 && a.rotorAngle(1) < Math.PI * 2);
    assert.notEqual(a.rotorAngle(0.01), a.rotorAngle(0));
    a.vx = 140;
    assert.ok(Math.abs(a.lean - 0.2) < 1e-12);
    a.vx = -70;
    assert.ok(Math.abs(a.lean + 0.1) < 1e-12);
});

// ------------------------------------------------------------------ patrol boat

test('patrol boat validates cruiser speed (30..60); drifters ignore speed', () => {
    for (const speed of [29.9, 60.1, NaN]) {
        assert.throws(() => new PatrolBoat(1, 400, 1000, { mode: 'cruiser', speed, direction: 1 }), RangeError);
    }
    assert.doesNotThrow(() => new PatrolBoat(1, 400, 1000, { mode: 'cruiser', speed: 30, direction: 1 }));
    assert.doesNotThrow(() => new PatrolBoat(1, 400, 1000, { mode: 'drifter', speed: 0, direction: 1 }));
});

test('cruiser patrols slowly, within bounds, never faster than 60', () => {
    const world = new FakeRiver({ left: 200, right: 760 });
    for (const speed of [30, 45, 60]) {
        const boat = new PatrolBoat(1, 480, 1000, { mode: 'cruiser', speed, direction: -1 });
        const trace = simulate(boat, world, 60);
        const xs = trace.map(t => t.x);
        assert.ok(Math.min(...xs) >= 200 + 18 + 2 - 1e-9 && Math.max(...xs) <= 760 - 18 - 2 + 1e-9);
        assert.ok(Math.max(...trace.map(t => Math.abs(t.vx))) <= speed + 1e-9);
        assert.ok(Math.max(...trace.map(t => Math.abs(t.vx))) > speed - 1e-6);
        assert.ok(trace.every(t => t.y === 1000), 'a cruiser holds its Y');
    }
});

test('cruiser turns smoothly at the banks and at an island', () => {
    const world = new FakeRiver({ left: 200, right: 760, island: [420, 540] });
    const boat = new PatrolBoat(1, 300, 1000, { mode: 'cruiser', speed: 60, direction: 1 });
    const trace = simulate(boat, world, 60);
    const maxStep = boat.acceleration * DT + 1e-9;
    for (let i = 1; i < trace.length; i++) assert.ok(Math.abs(trace[i].vx - trace[i - 1].vx) <= maxStep);
    assert.ok(Math.max(...trace.map(t => t.x)) <= 420 - 18 - 2 + 1e-9, 'stops short of the island');
    assert.ok(trace.some(t => t.vx < 0) && trace.some(t => t.vx > 0));
});

test('drifter floats downriver at 20 units/s with no lateral motion', () => {
    const world = new FakeRiver({ left: 200, right: 760 });
    const boat = new PatrolBoat(1, 480, 1000, { mode: 'drifter', speed: 0, direction: 1 });
    assert.equal(boat.isDrifting, true);
    assert.equal(boat.vy, -20);
    const trace = simulate(boat, world, 5);
    assert.ok(Math.abs(boat.y - (1000 - 20 * 5)) < 1e-6);
    assert.ok(trace.every(t => t.x === 480 && t.vx === 0));
    // Strictly monotonic downriver.
    for (let i = 1; i < trace.length; i++) assert.ok(trace[i].y < trace[i - 1].y);
});

test('drifter is pushed along as the banks close in under it', () => {
    // The left bank sweeps to the right as the boat drifts to lower Y.
    const world = new FakeRiver({ left: y => 200 + Math.max(0, (1000 - y)) * 2, right: 760 });
    const boat = new PatrolBoat(1, 230, 1000, { mode: 'drifter', speed: 0, direction: 1 });
    const trace = simulate(boat, world, 8);
    for (const t of trace) {
        const left = 200 + Math.max(0, 1000 - t.y) * 2;
        assert.ok(t.x >= left + 18 + 2 - 1e-9 || !t.alive, `boat ${t.x} inside bank ${left}`);
    }
    assert.ok(trace.at(-1).x > 230, 'it was shoved across');
});

// ---------------------------------------------------------------------- fighter

test('fighter speed must be within 320..580 (460 is normal; endless mode goes up to 580) and the trigger distance positive', () => {
    for (const speed of [319, 581, NaN]) assert.throws(() => new FighterJet(1, 0, 1000, { speed, direction: 1 }), RangeError);
    for (const speed of [320, 460, 520, 580]) assert.doesNotThrow(() => new FighterJet(1, 0, 1000, { speed, direction: 1 }));
    assert.throws(() => new FighterJet(1, 0, 1000, { speed: 400, direction: 1, triggerDistance: 0 }), RangeError);
    assert.equal(new FighterJet(1, 0, 1000, { speed: 400, direction: 1 }).triggerDistance, 600);
});

test('fighter waits parked until the player is within the trigger distance', () => {
    const world = new FakeRiver({ left: 200, right: 760 });
    const f = new FighterJet(1, 170, 2000, { speed: 400, direction: 1 });
    // The player is 700 below: nothing happens.
    for (let i = 0; i < 120; i++) f.update(DT, context(world, { playerY: 1300 }));
    assert.equal(f.state, 'parked');
    assert.equal(f.x, 170);
    assert.equal(f.vx, 0);
    assert.equal(f.isStreaking, false);
    // Exactly at the trigger distance (2000 - 600 = 1400).
    f.update(DT, context(world, { playerY: 1399.9 }));
    assert.equal(f.state, 'parked');
    f.update(DT, context(world, { playerY: 1400 }));
    assert.equal(f.state, 'streaking');
    assert.equal(f.launchedThisStep, true);
    f.update(DT, context(world, { playerY: 1400 }));
    assert.equal(f.launchedThisStep, false, 'the launch flag lasts a single step');
});

test('fighter streaks across at 320-460 units/s along a constant Y, in both directions', () => {
    const world = new FakeRiver({ left: 200, right: 760 });
    for (const [speed, direction, start] of [[320, 1, 170], [460, 1, 170], [400, -1, 790]]) {
        const f = new FighterJet(1, start, 2000, { speed, direction });
        const trace = simulate(f, world, 4, () => {}, { playerY: 1500 });
        const peak = Math.max(...trace.map(t => Math.abs(t.vx)));
        assert.ok(Math.abs(peak - speed) < 1e-6, `peak ${peak} vs ${speed}`);
        assert.ok(trace.every(t => t.y === 2000));
        assert.equal(Math.sign(trace[10].vx), direction);
        assert.equal(f.alive, false, 'gone after crossing');
    }
});

test('fighter accelerates quickly but not instantaneously', () => {
    const world = new FakeRiver({ left: 200, right: 760 });
    const f = new FighterJet(1, 170, 2000, { speed: 440, direction: 1 });
    f.update(DT, context(world, { playerY: 1500 }));
    assert.ok(f.vx > 0 && f.vx < 440);
    assert.ok(Math.abs(f.vx - 1500 * DT) < 1e-9);
    const ticks = simulate(f, world, 1, () => {}, { playerY: 1500 }).findIndex(t => Math.abs(t.vx - 440) < 1e-9);
    assert.ok(ticks >= 0 && ticks < 20, `took ${ticks} ticks to reach full speed`);
});

test('fighter despawns after crossing the river and leaving through the far bank (not before)', () => {
    const world = new FakeRiver({ left: 200, right: 760 });
    const f = new FighterJet(1, 170, 2000, { speed: 400, direction: 1 });
    let overRiver = false;
    for (let i = 0; i < 400 && f.alive; i++) {
        f.update(DT, context(world, { playerY: 1500 }));
        if (f.x >= 200 && f.x <= 760) overRiver = true;
        if (f.alive) assert.ok(f.x <= 760 + 10 + 8 + 1e-6, 'must not linger past the far bank');
    }
    assert.equal(overRiver, true);
    assert.equal(f.enteredRiver, true);
    assert.equal(f.alive, false);
    assert.equal(f.despawned, true);
    assert.equal(f.destroyed, false);
});

test('fighter flies over an island without leaving play (the island is inside the river span)', () => {
    const world = new FakeRiver({ left: 200, right: 760, island: [400, 560] });
    const f = new FighterJet(1, 170, 2000, { speed: 320, direction: 1 });
    const xsInside = [];
    for (let i = 0; i < 600 && f.alive; i++) {
        f.update(DT, context(world, { playerY: 1500 }));
        if (f.alive && f.x > 400 && f.x < 560) xsInside.push(f.x);
    }
    assert.ok(xsInside.length > 10, 'it crossed the island alive');
    assert.equal(f.hasLeftPlay(world), true);
});

test('a parked fighter never counts as having left play, even off the edge of the map', () => {
    const world = new FakeRiver({ left: 200, right: 760 });
    const f = new FighterJet(1, -20, 2000, { speed: 400, direction: 1 });
    assert.equal(f.hasLeftPlay(world), false);
    for (let i = 0; i < 300; i++) f.update(DT, context(world, { playerY: 0 }));
    assert.equal(f.alive, true);
});

test('fighter that somehow strays far outside the world is discarded', () => {
    const world = new FakeRiver({ left: 200, right: 760 });
    const f = new FighterJet(1, 960 + 100, 2000, { speed: 400, direction: 1 });
    f.update(DT, context(world, { playerY: 1500 }));
    assert.equal(f.alive, false);
});
