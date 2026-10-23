import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JetState, PlayerJet } from '../dist/src/entities/PlayerJet.js';
import { DT } from './helpers.mjs';

const fly = (moveX = 0, moveY = 0, enginePowered = true) => ({ moveX, moveY, enginePowered });

function spawned(config, x = 480, y = 180) {
    const jet = new PlayerJet(config);
    jet.spawn(x, y);
    return jet;
}

function run(jet, ticks, input) {
    for (let i = 0; i < ticks; i++) jet.update(DT, input);
}

test('spawns ALIVE at the requested position with a 28x20 hitbox', () => {
    const jet = spawned({}, 480, 180);
    assert.equal(jet.state, JetState.Alive);
    assert.equal(jet.isFlying, true);
    assert.deepEqual(jet.hitbox, { x: 480, y: 180, width: 28, height: 20 });
    assert.equal(jet.speed, 220);
    assert.equal(jet.deathCause, null);
    assert.equal(jet.isInvulnerable, false);
});

test('spawn keeps the jet inside the world', () => {
    assert.equal(spawned({}, -50).x, 14);
    assert.equal(spawned({}, 5000).x, 946);
});

test('forward speed follows the throttle: brake 90, cruise 220, boost 420', () => {
    const boost = spawned();
    run(boost, 120, fly(0, 1));
    assert.equal(boost.speed, 420);
    assert.equal(boost.throttleLevel, 1);

    const brake = spawned();
    run(brake, 120, fly(0, -1));
    assert.equal(brake.speed, 90);
    assert.equal(brake.throttleLevel, -1);

    const cruise = spawned();
    run(cruise, 30, fly(0, 0));
    assert.equal(cruise.speed, 220);
    assert.equal(cruise.throttleLevel, 0);
});

test('throttle transitions are smooth and rate-limited, never a jump', () => {
    const jet = spawned();
    jet.update(DT, fly(0, 1));
    assert.ok(Math.abs(jet.speed - (220 + 360 * DT)) < 1e-9);
    let previous = jet.speed;
    let maxStep = 0;
    for (let i = 0; i < 90; i++) {
        jet.update(DT, fly(0, 1));
        assert.ok(jet.speed >= previous);
        maxStep = Math.max(maxStep, jet.speed - previous);
        previous = jet.speed;
    }
    assert.ok(maxStep <= 360 * DT + 1e-9);
    // Releasing decelerates faster than it accelerated.
    const before = jet.speed;
    jet.update(DT, fly(0, 0));
    assert.ok(Math.abs(before - jet.speed - 480 * DT) < 1e-9);
});

test('analog throttle gives proportional speed', () => {
    const jet = spawned();
    run(jet, 120, fly(0, 0.5));
    assert.equal(jet.speed, 320);
    const slow = spawned();
    run(slow, 120, fly(0, -0.5));
    assert.equal(slow.speed, 155);
});

test('the jet advances in world Y at its forward speed', () => {
    const jet = spawned({}, 480, 180);
    run(jet, 60, fly(0, 0));
    assert.ok(Math.abs(jet.y - (180 + 220)) < 1e-6);
    assert.ok(Math.abs(jet.previousY - (180 + 220 - 220 * DT)) < 1e-6);
});

test('lateral speed reaches 380 units/s quickly and never exceeds it', () => {
    const jet = spawned();
    let ticks = 0;
    let peak = 0;
    while (jet.vx < 380 && ticks < 60) {
        jet.update(DT, fly(1, 0));
        peak = Math.max(peak, jet.vx);
        ticks++;
    }
    assert.equal(jet.vx, 380);
    assert.ok(ticks <= 9, `took ${ticks} ticks`);
    run(jet, 30, fly(1, 0));
    assert.equal(jet.vx, 380);
    assert.ok(peak <= 380);
});

test('lateral response is symmetric and analog', () => {
    const left = spawned();
    run(left, 30, fly(-1, 0));
    assert.equal(left.vx, -380);
    const half = spawned();
    run(half, 30, fly(0.5, 0));
    assert.equal(half.vx, 190);
    assert.ok(half.x > 480);
});

test('releasing stops the jet within ~0.12 s; reversing takes about a quarter second', () => {
    const jet = spawned();
    run(jet, 30, fly(1, 0));
    let ticks = 0;
    while (jet.vx !== 0 && ticks < 60) {
        jet.update(DT, fly(0, 0));
        ticks++;
    }
    assert.ok(ticks <= 8, `stopped in ${ticks} ticks`);

    const reverser = spawned();
    run(reverser, 30, fly(1, 0));
    ticks = 0;
    while (reverser.vx > -380 && ticks < 60) {
        reverser.update(DT, fly(-1, 0));
        ticks++;
    }
    assert.ok(ticks <= 16, `reversed in ${ticks} ticks`);
});

test('lateral speed beats boost-speed travel along the river centre-line (slope <= 0.9)', () => {
    // At full boost (420) the jet can still sidestep at 380: a centre-line slope up to 0.9 is trackable.
    const jet = spawned();
    run(jet, 40, fly(1, 1)); // short enough not to reach the world edge
    assert.equal(jet.speed, 420);
    assert.equal(jet.vx, 380);
    assert.ok(jet.vx / jet.speed > 0.9);
});

test('the jet cannot leave the world sideways', () => {
    const jet = spawned();
    run(jet, 180, fly(-1, 0));
    assert.equal(jet.x, 14);
    assert.equal(jet.vx, 0);
    run(jet, 360, fly(1, 0));
    assert.equal(jet.x, 946);
});

test('roll banks with lateral motion, capped at 20 degrees, and levels out', () => {
    const jet = spawned();
    assert.equal(jet.rollDegrees, 0);
    jet.update(DT, fly(1, 0));
    assert.ok(jet.rollDegrees > 0 && jet.rollDegrees < 20);
    let peak = 0;
    for (let i = 0; i < 90; i++) {
        jet.update(DT, fly(1, 0));
        peak = Math.max(peak, jet.rollDegrees);
        assert.ok(jet.rollDegrees <= 20 + 1e-9);
    }
    assert.ok(peak > 19.5, `peak roll ${peak}`);
    assert.ok(Math.abs(jet.maxRoll - (20 * Math.PI) / 180) < 1e-12);
    run(jet, 90, fly(0, 0));
    assert.ok(Math.abs(jet.rollDegrees) < 0.05);

    const left = spawned();
    run(left, 60, fly(-1, 0));
    assert.ok(left.rollDegrees < -19.5 && left.rollDegrees >= -20 - 1e-9);
});

test('roll lags the input slightly (bank inertia) and records the previous value for interpolation', () => {
    const jet = spawned();
    const before = jet.roll;
    jet.update(DT, fly(1, 0));
    assert.equal(jet.previousRoll, before);
    const targetAfterOneTick = (jet.vx / 380) * jet.maxRoll;
    assert.ok(jet.roll < targetAfterOneTick);
    assert.ok(jet.roll > 0);
});

test('state machine: ALIVE <-> REFUELING', () => {
    const jet = spawned();
    jet.setRefueling(true);
    assert.equal(jet.state, JetState.Refueling);
    assert.equal(jet.isFlying, true);
    jet.update(DT, fly(0, 0)); // still controllable
    assert.ok(jet.y > 180);
    jet.setRefueling(false);
    assert.equal(jet.state, JetState.Alive);
    jet.setRefueling(false);
    assert.equal(jet.state, JetState.Alive);
});

test('state machine: destroy -> EXPLODING -> DEAD, then a fresh spawn is ALIVE again', () => {
    const jet = spawned();
    run(jet, 20, fly(1, 1));
    assert.equal(jet.destroy('land'), true);
    assert.equal(jet.state, JetState.Exploding);
    assert.equal(jet.deathCause, 'land');
    assert.equal(jet.speed, 0);
    assert.equal(jet.vx, 0);
    assert.equal(jet.isFlying, false);

    const frozen = { x: jet.x, y: jet.y };
    run(jet, 30, fly(1, 1)); // 0.5 s of "input" changes nothing
    assert.deepEqual({ x: jet.x, y: jet.y }, frozen);
    assert.equal(jet.state, JetState.Exploding);
    run(jet, 30, fly(1, 1));
    assert.equal(jet.state, JetState.Dead);
    assert.equal(jet.stateTime, 0);
    run(jet, 12, fly(1, 1));
    assert.ok(Math.abs(jet.stateTime - 0.2) < 1e-9);

    jet.spawn(480, 3000);
    assert.equal(jet.state, JetState.Alive);
    assert.equal(jet.deathCause, null);
    assert.equal(jet.y, 3000);
});

test('a destroyed jet cannot be destroyed again, refuel, or change state by refuelling', () => {
    const jet = spawned();
    assert.equal(jet.destroy('bridge'), true);
    assert.equal(jet.destroy('land'), false);
    assert.equal(jet.deathCause, 'bridge');
    jet.setRefueling(true);
    assert.equal(jet.state, JetState.Exploding);
});

test('respawn protection lasts 3 seconds and blocks crashes but not fuel deaths', () => {
    const jet = new PlayerJet();
    jet.spawn(480, 180, { invulnerable: true });
    assert.equal(jet.isInvulnerable, true);
    assert.equal(jet.invulnerableRemaining, 3);
    assert.equal(jet.canBeDestroyedBy('land'), false);
    assert.equal(jet.canBeDestroyedBy('bridge'), false);
    assert.equal(jet.canBeDestroyedBy('fuel'), true);
    assert.equal(jet.destroy('land'), false);
    assert.equal(jet.destroy('bridge'), false);
    assert.equal(jet.state, JetState.Alive);

    run(jet, 179, fly(0, 0));
    assert.equal(jet.isInvulnerable, true);
    run(jet, 1, fly(0, 0));
    assert.equal(jet.isInvulnerable, false);
    assert.equal(jet.destroy('land'), true);
});

test('a fuel death ignores respawn protection', () => {
    const jet = new PlayerJet();
    jet.spawn(480, 180, { invulnerable: true });
    assert.equal(jet.destroy('fuel'), true);
    assert.equal(jet.deathCause, 'fuel');
});

test('engine out: controls are ignored, speed bleeds off, and the jet detonates after 0.5 s', () => {
    const jet = spawned();
    run(jet, 29, fly(1, 1, false));
    assert.equal(jet.isFlying, true);
    assert.equal(jet.isStalled, true);
    assert.equal(jet.vx, 0);
    assert.equal(jet.x, 480);
    assert.ok(Math.abs(jet.speed - (220 - 260 * DT * 29)) < 1e-6);
    jet.update(DT, fly(1, 1, false));
    assert.equal(jet.state, JetState.Exploding);
    assert.equal(jet.deathCause, 'fuel');
});

test('engine out: relighting before the glide ends rescues the jet', () => {
    const jet = spawned();
    run(jet, 24, fly(0, 0, false));
    assert.equal(jet.isStalled, true);
    jet.update(DT, fly(0, 0, true));
    assert.equal(jet.isStalled, false);
    assert.equal(jet.stallTime, 0);
    run(jet, 100, fly(0, 0, true));
    assert.equal(jet.isFlying, true);
    run(jet, 29, fly(0, 0, false)); // a new stall needs a full 0.5 s again
    assert.equal(jet.isFlying, true);
});

test('invalid steps and non-finite input are tolerated', () => {
    const jet = spawned();
    const snapshot = { x: jet.x, y: jet.y, speed: jet.speed };
    for (const dt of [0, -1, NaN, Infinity]) jet.update(dt, fly(1, 1));
    assert.deepEqual({ x: jet.x, y: jet.y, speed: jet.speed }, snapshot);
    run(jet, 30, fly(NaN, Infinity));
    assert.equal(jet.vx, 0);
    assert.equal(jet.speed, 220); // non-finite input counts as neutral, not as full throttle
    assert.ok(Number.isFinite(jet.x) && Number.isFinite(jet.y));
});

test('previous position is recorded every step for interpolation', () => {
    const jet = spawned({}, 480, 180);
    jet.update(DT, fly(1, 0));
    assert.equal(jet.previousX, 480);
    assert.equal(jet.previousY, 180);
    const x = jet.x;
    jet.update(DT, fly(1, 0));
    assert.equal(jet.previousX, x);
});

test('invalid jet config is rejected', () => {
    for (const bad of [
        { minSpeed: 300 }, { maxSpeed: 100 }, { acceleration: 0 }, { width: 0 }, { worldWidth: 10 },
        { maxLateralSpeed: 0 }, { maxRollDegrees: 90 }, { rollResponse: 0 }, { stallDuration: -1 }, { width: NaN },
    ]) {
        assert.throws(() => new PlayerJet(bad), RangeError, JSON.stringify(bad));
    }
});
