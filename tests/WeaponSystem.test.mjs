import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Projectile } from '../dist/src/entities/Projectile.js';
import { WeaponSystem } from '../dist/src/systems/WeaponSystem.js';
import { DT } from './helpers.mjs';

function input(overrides = {}) {
    return {
        firePressed: false, fire: false, canFire: true, originX: 480, originY: 190,
        forwardSpeed: 220, cameraY: 0, viewHeight: 720, ...overrides,
    };
}
const press = (overrides = {}) => input({ firePressed: true, fire: true, ...overrides });
const hold = (overrides = {}) => input({ fire: true, ...overrides });

test('a press fires one missile along the jet centreline from the nose', () => {
    const weapon = new WeaponSystem();
    const missile = weapon.update(DT, press({ originX: 321, originY: 190 }));
    assert.ok(missile instanceof Projectile);
    assert.equal(missile.x, 321);
    assert.equal(missile.y, 190 + 7); // tail starts at the nose
    assert.equal(missile.previousY, missile.y);
    assert.equal(weapon.activeCount, 1);
    assert.equal(missile.width, 4);
    assert.equal(missile.height, 14);
});

test('launch velocity is the jet forward speed plus 650', () => {
    for (const speed of [90, 220, 420]) {
        const weapon = new WeaponSystem();
        const missile = weapon.update(DT, press({ forwardSpeed: speed }));
        assert.equal(missile.vy, speed + 650);
    }
});

test('missile travels at its launch velocity each fixed step', () => {
    const weapon = new WeaponSystem();
    const missile = weapon.update(DT, press({ forwardSpeed: 420 }));
    const start = missile.y;
    for (let i = 0; i < 10; i++) weapon.update(DT, input({ forwardSpeed: 90 })); // later jet speed is irrelevant
    assert.ok(Math.abs(missile.y - (start + 1070 * DT * 10)) < 1e-9);
    assert.ok(Math.abs(missile.previousY - (start + 1070 * DT * 9)) < 1e-9);
});

test('single-shot discipline: never more than the cap in flight (default 2)', () => {
    const weapon = new WeaponSystem();
    assert.notEqual(weapon.update(DT, press()), null);
    assert.notEqual(weapon.update(DT, press()), null);
    assert.equal(weapon.update(DT, press()), null);
    assert.equal(weapon.update(DT, press()), null);
    assert.equal(weapon.activeCount, 2);
});

test('a freed slot allows the next shot, whether killed by a hit or by leaving the view', () => {
    const weapon = new WeaponSystem();
    const first = weapon.update(DT, press());
    weapon.update(DT, press());
    assert.equal(weapon.update(DT, press()), null);
    first.kill(); // e.g. it hit something
    assert.equal(weapon.activeCount, 1);
    assert.notEqual(weapon.update(DT, press()), null);
    assert.equal(weapon.activeCount, 2);
});

test('hold-to-fire repeats at 4 shots per second', () => {
    const weapon = new WeaponSystem({ maxActiveProjectiles: 99 });
    let shots = 0;
    const fireTicks = [];
    for (let tick = 0; tick < 60; tick++) {
        if (weapon.update(DT, hold())) {
            shots++;
            fireTicks.push(tick);
        }
    }
    assert.equal(shots, 4);
    assert.deepEqual(fireTicks, [0, 15, 30, 45]);
});

test('hold-to-fire is still limited by the active cap', () => {
    const weapon = new WeaponSystem();
    let shots = 0;
    let peak = 0;
    for (let tick = 0; tick < 240; tick++) {
        if (weapon.update(DT, hold())) shots++;
        peak = Math.max(peak, weapon.activeCount);
    }
    assert.equal(peak, 2);
    assert.ok(shots >= 4 && shots < 16, `shots ${shots}`);
});

test('a fresh press fires immediately even during the repeat cooldown', () => {
    const weapon = new WeaponSystem({ maxActiveProjectiles: 5 });
    assert.notEqual(weapon.update(DT, press()), null);
    assert.equal(weapon.update(DT, hold()), null); // cooldown, no new press
    assert.notEqual(weapon.update(DT, press()), null);
});

test('autoRepeat can be disabled: holding does nothing, pressing still fires', () => {
    const weapon = new WeaponSystem({ autoRepeat: false, maxActiveProjectiles: 9 });
    for (let tick = 0; tick < 120; tick++) assert.equal(weapon.update(DT, hold()), null);
    assert.notEqual(weapon.update(DT, press()), null);
});

test('no shots when the jet cannot fire', () => {
    const weapon = new WeaponSystem();
    assert.equal(weapon.update(DT, press({ canFire: false })), null);
    assert.equal(weapon.activeCount, 0);
    assert.equal(weapon.update(DT, hold({ canFire: false })), null);
});

test('missiles are retired once fully beyond the top of the viewport', () => {
    const weapon = new WeaponSystem();
    const missile = weapon.update(DT, press({ originY: 700 }));
    assert.equal(missile.alive, true);
    let ticks = 0;
    while (missile.alive && ticks < 600) {
        weapon.update(DT, input());
        ticks++;
    }
    assert.equal(missile.alive, false);
    assert.ok(missile.y - missile.height / 2 > 720, 'retired only when completely off the top');
    assert.ok(missile.previousY - missile.height / 2 <= 720, 'and not a step later than necessary');
    assert.equal(weapon.activeCount, 0);
    weapon.update(DT, input());
    assert.equal(weapon.projectiles.length, 0);
});

test('range follows the moving camera', () => {
    const weapon = new WeaponSystem();
    const missile = weapon.update(DT, press({ originY: 200, cameraY: 0 }));
    for (let i = 0; i < 30; i++) weapon.update(DT, input({ cameraY: 400 })); // view top is 1120 now
    assert.equal(missile.alive, true);
    assert.ok(missile.y < 1120);
});

test('the safety lifetime retires missiles even with an unbounded view', () => {
    const weapon = new WeaponSystem({ projectile: { maxAge: 0.5 } });
    const missile = weapon.update(DT, press({ viewHeight: 1e9 }));
    for (let i = 0; i < 40; i++) weapon.update(DT, input({ viewHeight: 1e9 }));
    assert.equal(missile.alive, false);
});

test('clear and reset empty the weapon; invalid steps are ignored', () => {
    const weapon = new WeaponSystem();
    weapon.update(DT, press());
    weapon.clear();
    assert.equal(weapon.projectiles.length, 0);
    assert.equal(weapon.cooldownRemaining, 0);
    assert.equal(weapon.update(0, press()), null);
    assert.equal(weapon.update(NaN, press()), null);
    assert.equal(weapon.update(-1, press()), null);
    const ids = new WeaponSystem();
    const a = ids.update(DT, press());
    const b = ids.update(DT, press());
    assert.deepEqual([a.id, b.id], [1, 2]);
    ids.reset();
    assert.equal(ids.update(DT, press()).id, 1);
});

test('invalid weapon config is rejected', () => {
    for (const bad of [
        { maxActiveProjectiles: 0 }, { maxActiveProjectiles: 1.5 }, { fireInterval: 0 },
        { fireInterval: NaN }, { projectileSpeed: 0 }, { projectileSpeed: -5 },
    ]) {
        assert.throws(() => new WeaponSystem(bad), RangeError, JSON.stringify(bad));
    }
    assert.equal(new WeaponSystem({ maxActiveProjectiles: 1 }).config.maxActiveProjectiles, 1);
});

test('projectile ignores updates once dead and keeps previous position for sweeps', () => {
    const p = new Projectile(1, 10, 100, 600);
    p.update(0.5);
    assert.equal(p.previousY, 100);
    assert.equal(p.y, 400);
    p.kill();
    p.update(0.5);
    assert.equal(p.y, 400);
    assert.deepEqual(p.hitbox, { x: 10, y: 400, width: 4, height: 14 });
});
