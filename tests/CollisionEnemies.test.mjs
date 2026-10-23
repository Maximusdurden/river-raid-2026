import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BridgeRegistry } from '../dist/src/entities/Bridge.js';
import { FuelDepot } from '../dist/src/entities/FuelDepot.js';
import { FighterJet } from '../dist/src/entities/enemies/FighterJet.js';
import { CollisionSystem } from '../dist/src/systems/CollisionSystem.js';
import { FakeRiver, StaticEnemy, bridgeSpan } from './helpers.mjs';

const missile = (x, previousY, y) => ({ x, y, previousY, width: 4, height: 14 });
const jetBox = (x, y) => ({ x, y, width: 28, height: 20 });
const system = (world = new FakeRiver(), registry = new BridgeRegistry()) => new CollisionSystem(world, registry);

// ------------------------------------------------------------- jet vs enemy

test('jet vs enemy: overlap is detected from any side; touching edges is not a collision', () => {
    const c = system();
    const enemy = new StaticEnemy(1, 480, 1000, { width: 24, height: 18 });
    assert.equal(c.findEnemyOverlap(jetBox(480, 1000), [enemy]), enemy);
    assert.equal(c.findEnemyOverlap(jetBox(500, 1010), [enemy]), enemy);
    assert.equal(c.findEnemyOverlap(jetBox(480 - 26 + 0.1, 1000), [enemy]), enemy);
    assert.equal(c.findEnemyOverlap(jetBox(480 + 26, 1000), [enemy]), null, 'side by side, touching');
    assert.equal(c.findEnemyOverlap(jetBox(480, 1000 + 19), [enemy]), null, 'nose to tail, touching');
    assert.equal(c.findEnemyOverlap(jetBox(480, 1100), [enemy]), null);
});

test('jet vs enemy: dead enemies are ignored and the first living overlap is returned', () => {
    const c = system();
    const dead = new StaticEnemy(1, 480, 1000);
    dead.destroy();
    const live = new StaticEnemy(2, 480, 1005);
    assert.equal(c.findEnemyOverlap(jetBox(480, 1000), [dead]), null);
    assert.equal(c.findEnemyOverlap(jetBox(480, 1000), [dead, live]), live);
    assert.equal(c.findEnemyOverlap(jetBox(480, 1000), []), null);
});

test('jet vs enemy uses the enemy\u2019s own hitbox size', () => {
    const c = system();
    const boat = new StaticEnemy(1, 480, 1000, { kind: 'patrol-boat', width: 36, height: 14 });
    assert.ok(c.findEnemyOverlap(jetBox(480 + 31, 1000), [boat]));
    assert.equal(c.findEnemyOverlap(jetBox(480 + 32, 1000), [boat]), null);
});

// ---------------------------------------------------------- missile vs enemy

test('missile vs enemy: a direct hit stops at the enemy\u2019s underside', () => {
    const c = system();
    const enemy = new StaticEnemy(1, 480, 1000, { width: 24, height: 18 });
    const hit = c.sweepProjectile(missile(480, 900, 1100), [], [enemy]);
    assert.equal(hit?.kind, 'enemy');
    assert.equal(hit.enemy, enemy);
    assert.equal(hit.y, 1000 - 9, 'the nose meets the hull\u2019s bottom edge');
    assert.equal(hit.x, 480);
});

test('missile vs enemy: it cannot tunnel through, whatever the step length', () => {
    const c = system();
    const enemy = new StaticEnemy(1, 480, 1000, { width: 24, height: 18 });
    for (const [from, to] of [[0, 5000], [990, 1010], [1000, 1000], [1020, 1030]]) {
        const hit = c.sweepProjectile(missile(480, from, to), [], [enemy]);
        assert.equal(hit?.kind === 'enemy', to + 7 > 991 && from - 7 < 1009, `${from} -> ${to}`);
    }
});

test('missile vs enemy: width is checked (missile 4 + enemy 24 => hit when |dx| < 14)', () => {
    const c = system();
    const enemy = new StaticEnemy(1, 480, 1000, { width: 24, height: 18 });
    assert.equal(c.sweepProjectile(missile(480 + 13.9, 900, 1100), [], [enemy])?.kind, 'enemy');
    assert.equal(c.sweepProjectile(missile(480 - 13.9, 900, 1100), [], [enemy])?.kind, 'enemy');
    assert.equal(c.sweepProjectile(missile(480 + 14, 900, 1100), [], [enemy]), null);
    assert.equal(c.sweepProjectile(missile(480 - 14, 900, 1100), [], [enemy]), null);
});

test('missile vs enemy: a fast enemy is tested over the ground it covered this tick', () => {
    const c = system();
    const fighter = new StaticEnemy(1, 480, 1000, { kind: 'fighter', width: 20, height: 22, flies: true });
    // It streaked from x=380 to x=480 this tick; a missile aimed at where it just was must still hit.
    fighter.previousX = 380;
    fighter.previousY = 1000;
    assert.equal(c.sweepProjectile(missile(400, 900, 1100), [], [fighter])?.kind, 'enemy');
    assert.equal(c.sweepProjectile(missile(300, 900, 1100), [], [fighter]), null, 'but not beyond its path');
    assert.equal(c.sweepProjectile(missile(520, 900, 1100), [], [fighter]), null);
});

test('missile vs enemy: dead enemies are transparent, and omitting the list is fine', () => {
    const c = system();
    const enemy = new StaticEnemy(1, 480, 1000);
    enemy.destroy();
    assert.equal(c.sweepProjectile(missile(480, 900, 1100), [], [enemy]), null);
    assert.equal(c.sweepProjectile(missile(480, 900, 1100), []), null);
});

test('missile hits whichever target is first in its path: enemy, depot, bridge or land', () => {
    const bridge = bridgeSpan(1, 1200);
    const depot = new FuelDepot({ id: 1, x: 480, y: 1100 });
    const world = new FakeRiver({ bridges: [bridge] });
    const c = system(world);
    const enemy = new StaticEnemy(1, 480, 1000);
    assert.equal(c.sweepProjectile(missile(480, 800, 1300), [depot], [enemy])?.kind, 'enemy');
    const farEnemy = new StaticEnemy(2, 480, 1150);
    assert.equal(c.sweepProjectile(missile(480, 800, 1300), [depot], [farEnemy])?.kind, 'depot');
    const beyond = new StaticEnemy(3, 480, 1250);
    assert.equal(c.sweepProjectile(missile(480, 800, 1300), [], [beyond])?.kind, 'bridge');
    assert.equal(c.sweepProjectile(missile(300, 800, 1300), [depot], [enemy])?.kind, 'bridge', 'both missed sideways');

    const shore = system(new FakeRiver({ left: 200, right: 760 }));
    // A missile that is already over the bank dies on the bank before it reaches anything above it.
    const overBank = new StaticEnemy(4, 150, 1000);
    assert.equal(shore.sweepProjectile(missile(150, 900, 1100), [], [overBank])?.kind, 'land');
    const swimmerClose = new StaticEnemy(5, 480, 1050);
    assert.equal(shore.sweepProjectile(missile(480, 900, 1100), [], [swimmerClose])?.kind, 'enemy');
});

test('missile reports the enemy that is nearest when several line up', () => {
    const c = system();
    const near = new StaticEnemy(1, 480, 1000);
    const far = new StaticEnemy(2, 480, 1060);
    assert.equal(c.sweepProjectile(missile(480, 900, 1200), [], [far, near])?.enemy, near);
});

// ----------------------------------------------------------- enemy vs terrain

test('enemy vs terrain: a hull in open water is left alone', () => {
    const c = system();
    const world = new FakeRiver({ left: 200, right: 760 });
    const enemy = new StaticEnemy(1, 480, 1000);
    assert.equal(c.resolveEnemyTerrain(enemy, world), 'ok');
    assert.equal(enemy.x, 480);
    assert.equal(enemy.heading, 1);
});

test('enemy vs terrain: touching a bank pushes it back inside and reverses it', () => {
    const c = system();
    const world = new FakeRiver({ left: 200, right: 760 });
    const left = new StaticEnemy(1, 205, 1000, { width: 24 });
    assert.equal(c.resolveEnemyTerrain(left, world), 'reversed');
    assert.equal(left.x, 200 + 12 + 2);
    assert.equal(left.heading, 1, 'now heading away from the left bank');
    assert.equal(left.alive, true);

    const right = new StaticEnemy(2, 755, 1000, { width: 24 });
    assert.equal(c.resolveEnemyTerrain(right, world), 'reversed');
    assert.equal(right.x, 760 - 12 - 2);
    assert.equal(right.heading, -1);

    // The resolved hull really is clear of land afterwards.
    for (const e of [left, right]) assert.equal(c.resolveEnemyTerrain(e, world), 'ok');
});

test('enemy vs terrain: an island reverses the patrol too, from either side', () => {
    const c = system();
    const world = new FakeRiver({ left: 200, right: 760, island: [400, 520] });
    const fromLeft = new StaticEnemy(1, 395, 1000, { width: 24 });
    assert.equal(c.resolveEnemyTerrain(fromLeft, world), 'reversed');
    assert.equal(fromLeft.x, 400 - 12 - 2);
    assert.equal(fromLeft.heading, -1);
    const fromRight = new StaticEnemy(2, 526, 1000, { width: 24 });
    assert.equal(c.resolveEnemyTerrain(fromRight, world), 'reversed');
    assert.equal(fromRight.x, 520 + 12 + 2);
    assert.equal(fromRight.heading, 1);
});

test('enemy vs terrain: a hull wedged where there is no room despawns without scoring', () => {
    const c = system();
    const world = new FakeRiver({ left: 400, right: 415 });
    const enemy = new StaticEnemy(1, 407, 1000, { width: 24 });
    assert.equal(c.resolveEnemyTerrain(enemy, world), 'despawned');
    assert.deepEqual([enemy.alive, enemy.despawned, enemy.destroyed], [false, true, false]);
});

test('enemy vs terrain: banks that slant into the hull are caught on its far corner', () => {
    const c = system();
    const world = new FakeRiver({ left: y => 200 + 2 * (y - 1000), right: 760 });
    // At the hull's top edge (y = 1009) the bank is at x = 218: a hull whose left edge is at 213 is in it.
    const enemy = new StaticEnemy(1, 225, 1000, { width: 24, height: 18 });
    assert.equal(c.resolveEnemyTerrain(enemy, world), 'reversed');
    assert.equal(enemy.x, 218 + 12 + 2);
});

test('enemy vs terrain: fliers cross banks and islands freely', () => {
    const c = system();
    const world = new FakeRiver({ left: 200, right: 760, island: [400, 520] });
    const flier = new StaticEnemy(1, 460, 1000, { kind: 'fighter', width: 20, height: 22, flies: true });
    assert.equal(c.resolveEnemyTerrain(flier, world), 'ok', 'over the island');
    flier.x = 100;
    assert.equal(c.resolveEnemyTerrain(flier, world), 'ok', 'over the bank');
    assert.equal(flier.alive, true);
});

test('enemy vs terrain: a fighter that has crossed the river and cleared the far bank is despawned', () => {
    const c = system();
    const world = new FakeRiver({ left: 200, right: 760 });
    const fighter = new FighterJet(1, 100, 1000, { speed: 400, direction: 1 });
    assert.equal(c.resolveEnemyTerrain(fighter, world), 'ok', 'parked');
    fighter.state = 'streaking';
    fighter.x = 700;
    fighter.enteredRiver = true;
    assert.equal(c.resolveEnemyTerrain(fighter, world), 'ok', 'still over the river');
    fighter.x = 790;
    assert.equal(c.resolveEnemyTerrain(fighter, world), 'despawned');
    assert.deepEqual([fighter.alive, fighter.despawned, fighter.destroyed], [false, true, false]);

    const back = new FighterJet(2, 860, 1000, { speed: 400, direction: -1 });
    back.state = 'streaking';
    back.enteredRiver = true;
    back.x = 170;
    assert.equal(c.resolveEnemyTerrain(back, world), 'despawned');
});

test('enemy vs terrain: a fighter that has not yet reached the river is not discarded', () => {
    const c = system();
    const world = new FakeRiver({ left: 200, right: 760 });
    const fighter = new FighterJet(1, 100, 1000, { speed: 400, direction: 1 });
    fighter.state = 'streaking';
    fighter.x = 150;
    assert.equal(c.resolveEnemyTerrain(fighter, world), 'ok');
    assert.equal(fighter.alive, true);
});

test('enemy vs terrain ignores enemies that are already gone', () => {
    const c = system();
    const world = new FakeRiver({ left: 200, right: 760 });
    const dead = new StaticEnemy(1, 100, 1000);
    dead.destroy();
    assert.equal(c.resolveEnemyTerrain(dead, world), 'ok');
    assert.equal(dead.despawned, false);
});
