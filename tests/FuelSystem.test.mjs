import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_FUEL_CONFIG, FuelSystem } from '../dist/src/systems/FuelSystem.js';
import { DT } from './helpers.mjs';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('starts full with the specified capacity', () => {
    const fuel = new FuelSystem();
    assert.equal(fuel.level, 100);
    assert.equal(fuel.capacity, 100);
    assert.equal(fuel.fraction, 1);
    assert.equal(fuel.percent, 100);
    assert.equal(fuel.isFull, true);
    assert.equal(fuel.isCritical, false);
    assert.equal(fuel.isEmpty, false);
    assert.equal(fuel.isRefueling, false);
});

test('burn curve hits the specified anchors: brake 1.4, cruise 2.2, boost 4.5', () => {
    const fuel = new FuelSystem();
    near(fuel.burnRate(-1), 1.4);
    near(fuel.burnRate(0), 2.2);
    near(fuel.burnRate(1), 4.5);
});

test('burn curve is clamped, tolerant of NaN, monotonic and continuous', () => {
    const fuel = new FuelSystem();
    near(fuel.burnRate(7), 4.5);
    near(fuel.burnRate(-7), 1.4);
    near(fuel.burnRate(NaN), 2.2);
    near(fuel.burnRate(0.5), 3.35);
    near(fuel.burnRate(-0.5), 1.8);
    let previous = fuel.burnRate(-1);
    for (let t = -0.99; t <= 1.0001; t += 0.01) {
        const rate = fuel.burnRate(t);
        assert.ok(rate >= previous - 1e-12, `non-monotonic at ${t}`);
        assert.ok(rate - previous < 0.03, `jump at ${t}`);
        previous = rate;
    }
});

test('burn integrates exactly over time at each throttle setting', () => {
    for (const [throttle, perSecond] of [[0, 2.2], [1, 4.5], [-1, 1.4]]) {
        const fuel = new FuelSystem();
        for (let i = 0; i < 600; i++) fuel.update(DT, { throttle, refueling: false });
        near(fuel.level, 100 - perSecond * 10, 1e-6);
    }
});

test('burn is independent of step size', () => {
    const coarse = new FuelSystem();
    const fine = new FuelSystem();
    coarse.update(1, { throttle: 1, refueling: false });
    for (let i = 0; i < 240; i++) fine.update(1 / 240, { throttle: 1, refueling: false });
    near(coarse.level, fine.level, 1e-9);
});

test('low-fuel warning triggers strictly below 20 and reports transitions', () => {
    const fuel = new FuelSystem();
    fuel.setLevel(20);
    assert.equal(fuel.isCritical, false);
    fuel.setLevel(19.999);
    assert.equal(fuel.isCritical, true);

    fuel.setLevel(20.01);
    const crossing = fuel.update(DT, { throttle: 0, refueling: false });
    assert.equal(crossing.enteredCritical, true);
    assert.equal(fuel.isCritical, true);
    assert.equal(fuel.update(DT, { throttle: 0, refueling: false }).enteredCritical, false);

    fuel.setLevel(19.99);
    const refuelStep = fuel.update(DT, { throttle: 0, refueling: true });
    assert.equal(refuelStep.leftCritical, true);
    assert.equal(fuel.isCritical, false);
});

test('depletion clamps at zero and is reported exactly once', () => {
    const fuel = new FuelSystem();
    fuel.setLevel(0.05);
    const first = fuel.update(1, { throttle: 0, refueling: false });
    assert.equal(first.depleted, true);
    assert.equal(fuel.level, 0);
    assert.equal(fuel.isEmpty, true);
    assert.equal(fuel.isCritical, true);
    assert.equal(fuel.update(1, { throttle: 0, refueling: false }).depleted, false);
    assert.equal(fuel.level, 0);
});

test('refuelling adds 28 units/s on top of the burn and clamps at capacity', () => {
    const fuel = new FuelSystem();
    fuel.setLevel(50);
    for (let i = 0; i < 60; i++) fuel.update(DT, { throttle: 0, refueling: true });
    near(fuel.level, 50 + 28 - 2.2, 1e-9);
    for (let i = 0; i < 600; i++) fuel.update(DT, { throttle: 0, refueling: true });
    assert.equal(fuel.level, 100);
});

test('refuelling flag: starts once, stops when the tank is full or the depot is left', () => {
    const fuel = new FuelSystem();
    fuel.setLevel(90);
    const starts = [];
    const stops = [];
    for (let i = 0; i < 90; i++) {
        const u = fuel.update(DT, { throttle: 0, refueling: true });
        if (u.refuelStarted) starts.push(i);
        if (u.refuelStopped) stops.push(i);
    }
    assert.equal(starts.length, 1);
    assert.equal(starts[0], 0);
    assert.equal(stops.length, 1);
    assert.equal(fuel.isRefueling, false);
    assert.equal(fuel.level, 100);

    fuel.setLevel(60);
    assert.equal(fuel.update(DT, { throttle: 0, refueling: true }).refuelStarted, true);
    assert.equal(fuel.isRefueling, true);
    assert.equal(fuel.update(DT, { throttle: 0, refueling: false }).refuelStopped, true);
    assert.equal(fuel.isRefueling, false);
});

test('a full tank on a depot holds steady at 100 and never reports refuelling', () => {
    const fuel = new FuelSystem();
    for (let i = 0; i < 120; i++) {
        const u = fuel.update(DT, { throttle: 1, refueling: true });
        assert.equal(u.refuelStarted, false);
        assert.equal(fuel.isRefueling, false);
        assert.equal(fuel.level, 100);
    }
    // Off the depot, it burns again.
    fuel.update(DT, { throttle: 0, refueling: false });
    assert.ok(fuel.level < 100);
});

test('an empty tank can be saved by a depot', () => {
    const fuel = new FuelSystem();
    fuel.setLevel(0);
    fuel.update(DT, { throttle: 0, refueling: true });
    assert.ok(fuel.level > 0);
    assert.equal(fuel.isEmpty, false);
});

test('cancelRefuel, reset and setLevel', () => {
    const fuel = new FuelSystem();
    fuel.setLevel(40);
    fuel.update(DT, { throttle: 0, refueling: true });
    assert.equal(fuel.cancelRefuel(), true);
    assert.equal(fuel.cancelRefuel(), false);
    assert.equal(fuel.isRefueling, false);
    fuel.setLevel(1e9);
    assert.equal(fuel.level, 100);
    fuel.setLevel(-5);
    assert.equal(fuel.level, 0);
    assert.throws(() => fuel.setLevel(NaN), RangeError);
    fuel.reset();
    assert.equal(fuel.level, 100);
});

test('invalid or zero steps change nothing', () => {
    const fuel = new FuelSystem();
    for (const dt of [0, -1, NaN, Infinity]) {
        const u = fuel.update(dt, { throttle: 1, refueling: true });
        assert.equal(u.burned, 0);
        assert.equal(fuel.level, 100);
    }
});

test('custom config is honoured and invalid config rejected', () => {
    const fuel = new FuelSystem({ capacity: 50, startLevel: 30, cruiseBurnRate: 1, criticalThreshold: 10 });
    assert.equal(fuel.level, 30);
    assert.equal(fuel.fraction, 0.6);
    near(fuel.burnRate(0), 1);
    assert.deepEqual({ ...DEFAULT_FUEL_CONFIG }.capacity, 100);
    for (const bad of [
        { capacity: 0 }, { startLevel: 101 }, { startLevel: -1 }, { cruiseBurnRate: -1 },
        { criticalThreshold: 101 }, { refuelRate: -1 }, { capacity: NaN },
    ]) {
        assert.throws(() => new FuelSystem(bad), RangeError, JSON.stringify(bad));
    }
});
