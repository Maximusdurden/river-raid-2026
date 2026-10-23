import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BridgeRegistry } from '../dist/src/entities/Bridge.js';
import { FuelDepot } from '../dist/src/entities/FuelDepot.js';
import {
    CollisionSystem, boxOverlapsBridge, boxTouchesLand, boxesOverlap,
} from '../dist/src/systems/CollisionSystem.js';
import { RiverGenerator } from '../dist/src/world/RiverGenerator.js';
import { FakeWorld, bridgeSpan } from './helpers.mjs';

const jetBox = (x, y) => ({ x, y, width: 28, height: 20 });
const depotAt = (id, x, y) => new FuelDepot({ id, x, y });
const missile = (x, previousY, y) => ({ x, y, previousY, width: 4, height: 14 });

// ---------------------------------------------------------------- box overlap

test('boxesOverlap: overlap, containment and symmetry', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    assert.equal(boxesOverlap(a, { x: 5, y: 5, width: 10, height: 10 }), true);
    assert.equal(boxesOverlap(a, { x: 1, y: 1, width: 2, height: 2 }), true); // contained
    assert.equal(boxesOverlap({ x: 1, y: 1, width: 2, height: 2 }, a), true);
    assert.equal(boxesOverlap(a, a), true);
});

test('boxesOverlap: separated on one axis only is not a collision', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    assert.equal(boxesOverlap(a, { x: 20, y: 0, width: 10, height: 10 }), false);
    assert.equal(boxesOverlap(a, { x: 0, y: 20, width: 10, height: 10 }), false);
    assert.equal(boxesOverlap(a, { x: 9, y: 20, width: 10, height: 10 }), false);
    assert.equal(boxesOverlap(a, { x: 20, y: 9, width: 10, height: 10 }), false);
});

test('boxesOverlap: touching edges and corners do not collide; a sliver does', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    assert.equal(boxesOverlap(a, { x: 10, y: 0, width: 10, height: 10 }), false);
    assert.equal(boxesOverlap(a, { x: 0, y: 10, width: 10, height: 10 }), false);
    assert.equal(boxesOverlap(a, { x: 10, y: 10, width: 10, height: 10 }), false);
    assert.equal(boxesOverlap(a, { x: 9.999, y: 0, width: 10, height: 10 }), true);
    assert.equal(boxesOverlap(a, { x: 9.999, y: 9.999, width: 10, height: 10 }), true);
});

test('the jet and depot hitboxes have the specified sizes', () => {
    const depot = depotAt(1, 100, 100);
    assert.deepEqual(depot.hitbox, { x: 100, y: 100, width: 20, height: 45 });
});

// ---------------------------------------------------------------- land probes

test('boxTouchesLand: vertical banks, edge-exact on both sides', () => {
    const world = new FakeWorld({ land: x => x < 100 || x > 860 });
    assert.equal(boxTouchesLand(world, jetBox(480, 500)), false);
    assert.equal(boxTouchesLand(world, jetBox(114, 500)), false); // left edge exactly on the bank
    assert.equal(boxTouchesLand(world, jetBox(113.9, 500)), true);
    assert.equal(boxTouchesLand(world, jetBox(846, 500)), false);
    assert.equal(boxTouchesLand(world, jetBox(846.1, 500)), true);
    assert.equal(boxTouchesLand(world, jetBox(50, 500)), true);
});

test('boxTouchesLand: slanted banks are caught at the box corner nearest the bank', () => {
    // Left bank leans into the river as y grows: land when x < 100 + 1.5 * y.
    const world = new FakeWorld({ land: (x, y) => x < 100 + 1.5 * y });
    // Box y in [-10, 10] => bank reaches x = 115 at the top. Left edge at 115 just clears it.
    assert.equal(boxTouchesLand(world, jetBox(129, 0)), false);
    assert.equal(boxTouchesLand(world, jetBox(128.9, 0)), true);
});

test('boxTouchesLand: a bank bulge that peaks between the box top and bottom is not missed', () => {
    // A bump exactly on a slice boundary (y = 16) while the box spans y 8..28.
    const bump = (y) => 100 + Math.max(0, 40 - Math.abs(y - 16) * 10);
    const world = new FakeWorld({ land: (x, y) => x < bump(y) });
    // Box left edge at 120: the bank reaches 140 at y = 16, strictly between the rows y=8 and y=28.
    assert.equal(boxTouchesLand(world, { x: 134, y: 18, width: 28, height: 20 }), true);
    assert.equal(boxTouchesLand(world, { x: 160, y: 18, width: 28, height: 20 }), false); // left edge 146 > 140
});

test('boxTouchesLand: islands are detected in the interior of the box', () => {
    const world = new FakeWorld({ land: x => x >= 200 && x <= 300 });
    assert.equal(boxTouchesLand(world, jetBox(250, 500)), true); // box fully over the island
    assert.equal(boxTouchesLand(world, jetBox(190, 500)), true); // right side overlaps
    assert.equal(boxTouchesLand(world, jetBox(150, 500)), false);
    assert.equal(boxTouchesLand(world, jetBox(330, 500)), false);
});

test('boxTouchesLand: on the real river, the channel centre is clear and the banks are land', () => {
    for (const seed of [1, 2026, 77, 123456]) {
        const world = new RiverGenerator(seed);
        for (let y = 200; y < 9000; y += 37) {
            const mid = world.sample(y).centerX;
            if (world.sample(y).isBranching) continue; // the centre may be an island
            const clear = boxTouchesLand(world, jetBox(mid, y));
            const wide = world.sample(y).width;
            if (wide > 220) assert.equal(clear, false, `seed ${seed} y ${y}`);
            const s = world.sample(y);
            assert.equal(boxTouchesLand(world, jetBox(s.leftBankX - 5, y)), true);
            assert.equal(boxTouchesLand(world, jetBox(s.rightBankX + 5, y)), true);
        }
    }
});

test('boxTouchesLand: outside the world counts as land', () => {
    const world = new RiverGenerator(5);
    assert.equal(boxTouchesLand(world, jetBox(-5, 500)), true);
    assert.equal(boxTouchesLand(world, jetBox(970, 500)), true);
});

// ---------------------------------------------------------------- jet vs bridges

test('boxOverlapsBridge uses the deck thickness and ignores x (decks span the world)', () => {
    const b = bridgeSpan(1, 1000);
    assert.equal(boxOverlapsBridge(jetBox(10, 1000), b), true);
    assert.equal(boxOverlapsBridge(jetBox(950, 1000), b), true);
    assert.equal(boxOverlapsBridge(jetBox(480, 976 - 10), b), false); // box top touches the deck bottom
    assert.equal(boxOverlapsBridge(jetBox(480, 976 - 9.99), b), true);
    assert.equal(boxOverlapsBridge(jetBox(480, 1024 + 10), b), false); // box bottom touches the deck top
    assert.equal(boxOverlapsBridge(jetBox(480, 1024 + 9.99), b), true);
});

test('checkJet: intact bridge kills, destroyed bridge is passable, bridge outranks land', () => {
    const span = bridgeSpan(1, 1000);
    const registry = new BridgeRegistry();
    const world = new FakeWorld({ land: x => x < 100 || x > 860, bridges: [span] });
    const collision = new CollisionSystem(world, registry);

    assert.deepEqual(collision.checkJet(jetBox(480, 1000)), { cause: 'bridge', bridge: span });
    assert.equal(collision.checkJet(jetBox(480, 900)), null);
    assert.equal(collision.checkJet(jetBox(480, 1100)), null);
    assert.equal(collision.checkJet(jetBox(50, 900))?.cause, 'land');
    assert.equal(collision.checkJet(jetBox(50, 1000))?.cause, 'bridge'); // both: the deck wins

    assert.equal(registry.destroy(span), true);
    assert.equal(collision.checkJet(jetBox(480, 1000)), null);
    assert.equal(collision.checkJet(jetBox(50, 1000))?.cause, 'land'); // land still kills
});

test('checkJet on a real river: the spawn is safe and the first bridge is lethal until destroyed', () => {
    const world = new RiverGenerator(2026);
    const registry = new BridgeRegistry();
    const collision = new CollisionSystem(world, registry);
    assert.equal(collision.checkJet(jetBox(world.sample(180).centerX, 180)), null);
    const bridge = world.findBridges(0, 4000)[0];
    const x = world.sample(bridge.centerY).centerX;
    assert.equal(collision.checkJet(jetBox(x, bridge.centerY))?.cause, 'bridge');
    registry.destroy(bridge);
    assert.equal(collision.checkJet(jetBox(x, bridge.centerY)), null);
});

// ---------------------------------------------------------------- depots

test('jet vs depot overlap: detects contact, skips destroyed depots, never damages', () => {
    const collision = new CollisionSystem(new FakeWorld(), new BridgeRegistry());
    const depot = depotAt(1, 500, 600);
    assert.equal(collision.findDepotOverlap(jetBox(500, 600), [depot]), depot);
    assert.equal(collision.findDepotOverlap(jetBox(520, 625), [depot]), depot);
    assert.equal(collision.findDepotOverlap(jetBox(500, 600 + 22.5 + 10), [depot]), null); // touching only
    assert.equal(collision.findDepotOverlap(jetBox(500 + 10 + 14, 600), [depot]), null);
    depot.destroyed = true;
    assert.equal(collision.findDepotOverlap(jetBox(500, 600), [depot]), null);
    assert.equal(collision.checkJet(jetBox(500, 600)), null); // overlap is not a crash
});

test('jet vs depot overlap returns the first intact depot among several', () => {
    const collision = new CollisionSystem(new FakeWorld(), new BridgeRegistry());
    const gone = depotAt(1, 500, 600);
    gone.destroyed = true;
    const live = depotAt(2, 500, 610);
    assert.equal(collision.findDepotOverlap(jetBox(500, 605), [gone, live]), live);
});

// ---------------------------------------------------------------- missile sweeps

test('missile vs bridge: hits at the deck, even when it would tunnel through in one step', () => {
    const span = bridgeSpan(1, 1000);
    const collision = new CollisionSystem(new FakeWorld({ bridges: [span] }), new BridgeRegistry());
    const hit = collision.sweepProjectile(missile(480, 900, 1100), []);
    assert.equal(hit?.kind, 'bridge');
    assert.equal(hit.bridge, span);
    assert.equal(hit.y, span.bottomY); // the nose meets the underside of the deck
    assert.equal(collision.sweepProjectile(missile(480, 800, 900), []), null);
    assert.equal(collision.sweepProjectile(missile(480, 1100, 1200), []), null); // already past it
});

test('missile vs bridge: hits anywhere across the deck, and a missile already inside it hits at once', () => {
    const span = bridgeSpan(1, 1000);
    const collision = new CollisionSystem(new FakeWorld({ bridges: [span] }), new BridgeRegistry());
    for (const x of [1, 480, 959]) assert.equal(collision.sweepProjectile(missile(x, 960, 975), [])?.kind, 'bridge');
    const inside = collision.sweepProjectile(missile(480, 1000, 1000), []);
    assert.equal(inside?.kind, 'bridge');
    assert.equal(inside.y, 1000 + 7);
});

test('missile passes a destroyed bridge', () => {
    const span = bridgeSpan(1, 1000);
    const registry = new BridgeRegistry();
    const collision = new CollisionSystem(new FakeWorld({ bridges: [span] }), registry);
    registry.destroy(span);
    assert.equal(collision.sweepProjectile(missile(480, 900, 1100), []), null);
});

test('missile vs depot: width-checked, swept and ignores destroyed depots', () => {
    const collision = new CollisionSystem(new FakeWorld(), new BridgeRegistry());
    const depot = depotAt(7, 500, 600);
    const maxDx = (4 + 20) / 2;
    assert.equal(collision.sweepProjectile(missile(500, 500, 700), [depot])?.depot, depot);
    assert.equal(collision.sweepProjectile(missile(500 + maxDx - 0.01, 500, 700), [depot])?.kind, 'depot');
    assert.equal(collision.sweepProjectile(missile(500 + maxDx, 500, 700), [depot]), null);
    assert.equal(collision.sweepProjectile(missile(500 - maxDx, 500, 700), [depot]), null);
    assert.equal(collision.sweepProjectile(missile(500, 700, 800), [depot]), null);
    depot.destroyed = true;
    assert.equal(collision.sweepProjectile(missile(500, 500, 700), [depot]), null);
});

test('missile hits the earliest target in its path', () => {
    const span = bridgeSpan(1, 1000);
    const depot = depotAt(1, 480, 900);
    const collision = new CollisionSystem(new FakeWorld({ bridges: [span] }), new BridgeRegistry());
    assert.equal(collision.sweepProjectile(missile(480, 800, 1100), [depot])?.kind, 'depot');
    const farDepot = depotAt(2, 480, 1100);
    assert.equal(collision.sweepProjectile(missile(480, 800, 1200), [farDepot])?.kind, 'bridge');
    assert.equal(collision.sweepProjectile(missile(300, 800, 1200), [depot])?.kind, 'bridge'); // depot missed laterally
});

test('missile vs land: stops where the shore is, and land in front of a bridge wins', () => {
    const span = bridgeSpan(1, 1000);
    const shore = new FakeWorld({ land: (_x, y) => y > 950, bridges: [span] });
    const collision = new CollisionSystem(shore, new BridgeRegistry());
    const hit = collision.sweepProjectile(missile(480, 900, 1100), []);
    assert.equal(hit?.kind, 'land');
    assert.ok(hit.y > 950 && hit.y <= 950 + 6 + 7, `impact at ${hit.y}`);
    const farShore = new CollisionSystem(new FakeWorld({ land: (_x, y) => y > 1500, bridges: [span] }), new BridgeRegistry());
    assert.equal(farShore.sweepProjectile(missile(480, 900, 1100), [])?.kind, 'bridge');
    const open = new CollisionSystem(new FakeWorld(), new BridgeRegistry());
    assert.equal(open.sweepProjectile(missile(480, 0, 5000), []), null);
});

test('a stationary missile (just spawned) is still tested', () => {
    const span = bridgeSpan(1, 1000);
    const collision = new CollisionSystem(new FakeWorld({ bridges: [span] }), new BridgeRegistry());
    assert.equal(collision.sweepProjectile(missile(480, 1010, 1010), [])?.kind, 'bridge');
    assert.equal(collision.sweepProjectile(missile(480, 500, 500), []), null);
});

// ---------------------------------------------------------------- bridge registry

test('BridgeRegistry: destruction is one-shot, the furthest bridge is the checkpoint', () => {
    const registry = new BridgeRegistry();
    const b1 = bridgeSpan(1, 3200);
    const b2 = bridgeSpan(2, 6400);
    assert.equal(registry.isIntact(1), true);
    assert.equal(registry.checkpoint, null);
    assert.equal(registry.stage, 0);
    assert.equal(registry.respawnY(180, 80), 180);

    assert.equal(registry.destroy(b1), true);
    assert.equal(registry.destroy(b1), false);
    assert.equal(registry.isIntact(1), false);
    assert.equal(registry.isDestroyed(1), true);
    assert.equal(registry.isIntact(2), true);
    assert.equal(registry.destroyedCount, 1);
    assert.equal(registry.stage, 1);
    assert.equal(registry.respawnY(180, 80), b1.topY + 80);

    registry.destroy(b2);
    assert.equal(registry.checkpoint, b2);
    assert.equal(registry.respawnY(180, 80), b2.topY + 80);

    registry.reset();
    assert.equal(registry.isIntact(1), true);
    assert.equal(registry.destroyedCount, 0);
    assert.equal(registry.checkpoint, null);
});

test('BridgeRegistry: destroying an earlier bridge never moves the checkpoint backwards', () => {
    const registry = new BridgeRegistry();
    registry.destroy(bridgeSpan(3, 9600));
    registry.destroy(bridgeSpan(1, 3200));
    assert.equal(registry.checkpoint.number, 3);
    assert.equal(registry.stage, 3);
});
