import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_DEPOT_CONFIG, DepotSpawner, FuelDepot } from '../dist/src/entities/FuelDepot.js';
import { boxTouchesLand } from '../dist/src/systems/CollisionSystem.js';
import { RiverGenerator } from '../dist/src/world/RiverGenerator.js';

const SEEDS = Array.from({ length: 40 }, (_, i) => i * 104729 + 3);
const C = DEFAULT_DEPOT_CONFIG;

function allPlacements(seed, maxY = 40000) {
    const world = new RiverGenerator(seed);
    const spawner = new DepotSpawner(world);
    const [first, last] = spawner.slotRange(0, maxY);
    const out = [];
    for (let slot = first; slot <= last; slot++) {
        const p = spawner.place(slot);
        if (p) out.push(p);
    }
    return { world, spawner, placements: out };
}

test('depot layout is deterministic and order-independent', () => {
    const a = allPlacements(2026).placements;
    const b = allPlacements(2026).placements;
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, allPlacements(2027).placements);

    const world = new RiverGenerator(2026);
    const reversed = new DepotSpawner(world);
    const [first, last] = reversed.slotRange(0, 40000);
    const collected = [];
    for (let slot = last; slot >= first; slot--) {
        const p = reversed.place(slot);
        if (p) collected.unshift(p);
    }
    assert.deepEqual(collected, a);
});

test('every depot sits in open water: its whole 20x45 hitbox is clear of banks and islands', () => {
    let checked = 0;
    for (const seed of SEEDS) {
        const { world, placements } = allPlacements(seed);
        for (const p of placements) {
            const depot = new FuelDepot(p);
            assert.equal(boxTouchesLand(world, depot.hitbox), false, `seed ${seed} slot ${p.id}`);
            assert.ok(world.sample(p.y).width > 0);
            checked++;
        }
    }
    assert.ok(checked > 2000, `only ${checked} depots checked`);
});

test('depots stay inside a navigable channel (never on an island)', () => {
    for (const seed of SEEDS.slice(0, 15)) {
        const { world, placements } = allPlacements(seed);
        for (const p of placements) {
            const inside = world.getChannels(p.y).some(ch => p.x - C.width / 2 >= ch.leftX && p.x + C.width / 2 <= ch.rightX);
            assert.ok(inside, `seed ${seed} slot ${p.id}`);
        }
    }
});

test('placement rules: spacing, minimum height, bridge clearance, ids', () => {
    for (const seed of SEEDS.slice(0, 20)) {
        const { world, placements } = allPlacements(seed);
        let previous = null;
        for (const p of placements) {
            assert.ok(p.y >= C.minY, `too early: ${p.y}`);
            assert.equal(world.findBridges(p.y - C.bridgeClearance, p.y + C.bridgeClearance).length, 0, `near a bridge: ${p.y}`);
            assert.equal(Math.abs(p.y - (p.id * C.spacing)) <= C.jitter, true);
            if (previous) assert.ok(p.y - previous.y > 200, 'depots too close together');
            previous = p;
        }
    }
});

test('depot density supports play: about one per 600-700 units, none dense or starved', () => {
    let total = 0;
    let longestGap = 0;
    for (const seed of SEEDS) {
        const { placements } = allPlacements(seed, 30000);
        total += placements.length;
        let last = 0;
        for (const p of placements) {
            longestGap = Math.max(longestGap, p.y - last);
            last = p.y;
        }
    }
    const perThousand = (total / SEEDS.length) / 30;
    assert.ok(perThousand > 1.2 && perThousand < 2, `${perThousand.toFixed(2)} depots per 1000 units`);
    // Fuel lasts ~10,000 units at cruise, so even the worst gap must be far below that.
    assert.ok(longestGap < 3200, `longest gap ${longestGap}`);
});

test('split channels host depots on both sides of an island', () => {
    let left = 0;
    let right = 0;
    for (const seed of SEEDS) {
        const { world, placements } = allPlacements(seed);
        for (const p of placements) {
            const s = world.sample(p.y);
            if (!s.isBranching) continue;
            if (p.x < s.islandLeftX) left++;
            else if (p.x > s.islandRightX) right++;
        }
    }
    assert.ok(left > 10 && right > 10, `left ${left}, right ${right}`);
});

test('slotRange covers every depot in a window, and clamps at zero', () => {
    const { spawner, placements } = allPlacements(11);
    const window = placements.filter(p => p.y >= 5000 && p.y <= 8000);
    const [first, last] = spawner.slotRange(5000, 8000);
    const inRange = new Set();
    for (let s = first; s <= last; s++) if (spawner.place(s)) inRange.add(s);
    for (const p of window) assert.ok(inRange.has(p.id));
    assert.equal(spawner.slotRange(-9999, 100)[0], 0);
});

test('create builds a FuelDepot with the configured size; empty slots give null', () => {
    const { spawner, placements } = allPlacements(11);
    const p = placements[0];
    const depot = spawner.create(p.id);
    assert.ok(depot instanceof FuelDepot);
    assert.equal(depot.id, p.id);
    assert.equal(depot.destroyed, false);
    assert.deepEqual(depot.hitbox, { x: p.x, y: p.y, width: 20, height: 45 });
    let empty = null;
    for (let s = 0; s < 200 && empty === null; s++) if (!spawner.place(s)) empty = s;
    assert.notEqual(empty, null);
    assert.equal(spawner.create(empty), null);
    assert.equal(spawner.place(-1), null);
});

test('chance 0 disables depots; chance 1 fills (almost) every valid slot; bad config rejected', () => {
    const world = new RiverGenerator(5);
    const none = new DepotSpawner(world, { chance: 0 });
    for (let s = 0; s < 100; s++) assert.equal(none.place(s), null);
    const dense = new DepotSpawner(world, { chance: 1 });
    let count = 0;
    for (let s = 1; s < 100; s++) if (dense.place(s)) count++;
    assert.ok(count > 70);
    for (const bad of [
        { width: 0 }, { spacing: 0 }, { jitter: 300 }, { jitter: -1 }, { chance: 2 }, { chance: -0.1 }, { height: NaN },
    ]) {
        assert.throws(() => new DepotSpawner(world, bad), RangeError, JSON.stringify(bad));
    }
});
