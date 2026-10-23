import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DepotSpawner } from '../dist/src/entities/FuelDepot.js';
import { FighterJet } from '../dist/src/entities/enemies/FighterJet.js';
import { Helicopter } from '../dist/src/entities/enemies/Helicopter.js';
import { PatrolBoat } from '../dist/src/entities/enemies/PatrolBoat.js';
import { patrolBounds } from '../dist/src/entities/enemies/Enemy.js';
import { boxTouchesLand } from '../dist/src/systems/CollisionSystem.js';
import { DEFAULT_ENEMY_SPAWN_CONFIG, EnemySpawner, createEnemy } from '../dist/src/systems/EnemySpawner.js';
import { RiverGenerator } from '../dist/src/world/RiverGenerator.js';

const SEEDS = Array.from({ length: 30 }, (_, i) => i * 104729 + 3);
const MAX_Y = 32000;
const C = DEFAULT_ENEMY_SPAWN_CONFIG;

function make(seed, config) {
    const world = new RiverGenerator(seed);
    const depots = new DepotSpawner(world);
    return { world, depots, spawner: new EnemySpawner(world, depots, config) };
}

const sweep = (seeds = SEEDS, maxY = MAX_Y) => seeds.map(seed => ({ seed, ...make(seed), }))
    .map(ctx => ({ ...ctx, placements: ctx.spawner.placementsIn(0, maxY) }));

// ------------------------------------------------------------------ determinism

test('the same seed always produces the same armada', () => {
    const a = make(2026).spawner.placementsIn(0, MAX_Y);
    const b = make(2026).spawner.placementsIn(0, MAX_Y);
    assert.ok(a.length > 50);
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, make(2027).spawner.placementsIn(0, MAX_Y));
});

test('layout is a pure function of (seed, slot): query order and caching never matter', () => {
    const { spawner } = make(77);
    const [first, last] = spawner.slotRange(0, MAX_Y);
    const forward = [];
    for (let slot = first; slot <= last; slot++) forward.push(spawner.place(slot));

    const shuffled = make(77).spawner;
    const order = Array.from({ length: last - first + 1 }, (_, i) => first + ((i * 37) % (last - first + 1)));
    assert.equal(new Set(order).size, order.length);
    for (const slot of order) assert.deepEqual(shuffled.place(slot), forward[slot - first]);

    // Cached answers equal recomputed ones, even after the cache is churned.
    const churn = make(77).spawner;
    for (let slot = 0; slot < 3000; slot++) churn.place(slot);
    for (let slot = first; slot <= last; slot += 7) assert.deepEqual(churn.place(slot), forward[slot - first]);
});

test('placementsIn returns exactly the placements whose Y lies in the window, ascending', () => {
    const { spawner } = make(11);
    const all = spawner.placementsIn(0, MAX_Y);
    const window = spawner.placementsIn(6000, 9000);
    assert.deepEqual(window, all.filter(p => p.y >= 6000 && p.y <= 9000));
    for (let i = 1; i < all.length; i++) assert.ok(all[i].y >= all[i - 1].y);
});

test('placement ids are unique within a seed', () => {
    for (const { placements } of sweep(SEEDS.slice(0, 10))) {
        assert.equal(new Set(placements.map(p => p.id)).size, placements.length);
    }
});

test('slotRange never misses a placement in a window', () => {
    const { spawner } = make(5);
    for (const [lo, hi] of [[1000, 1500], [4000, 4100], [12345, 13000]]) {
        const [first, last] = spawner.slotRange(lo, hi);
        const found = [];
        for (let slot = first; slot <= last; slot++) for (const p of spawner.place(slot)) if (p.y >= lo && p.y <= hi) found.push(p.id);
        const brute = [];
        for (let slot = 0; slot < 200; slot++) for (const p of spawner.place(slot)) if (p.y >= lo && p.y <= hi) brute.push(p.id);
        assert.deepEqual(found.sort((a, b) => a - b), brute.sort((a, b) => a - b));
    }
    assert.equal(spawner.slotRange(-5000, 100)[0], 0);
});

test('a disabled spawner places nothing; negative slots are empty', () => {
    const off = make(3, { enabled: false }).spawner;
    assert.deepEqual(off.placementsIn(0, MAX_Y), []);
    assert.deepEqual(make(3).spawner.place(-1), []);
});

// ------------------------------------------------------------- valid placement

test('patrollers are always in open water with their whole hull clear of banks and islands', () => {
    let patrollers = 0;
    for (const { world, spawner, placements } of sweep()) {
        for (const p of placements) {
            if (p.kind === 'fighter') continue;
            const enemy = spawner.create(p);
            patrollers++;
            assert.equal(boxTouchesLand(world, enemy.hitbox), false, `${p.kind} at ${p.x.toFixed(0)},${p.y.toFixed(0)}`);
            const bounds = patrolBounds(world, p.x, p.y, enemy.width / 2, enemy.height / 2);
            assert.notEqual(bounds, null);
            assert.ok(p.x >= bounds.min - 1e-9 && p.x <= bounds.max + 1e-9);
        }
    }
    assert.ok(patrollers > 1500, `only ${patrollers} patrollers checked`);
});

test('patrollers can actually patrol: their channel gives room to sweep', () => {
    for (const { world, placements } of sweep(SEEDS.slice(0, 12))) {
        for (const p of placements) {
            if (p.kind === 'fighter' || (p.kind === 'patrol-boat' && p.mode === 'drifter')) continue;
            const w = p.kind === 'patrol-boat' ? 36 : 24;
            const h = p.kind === 'patrol-boat' ? 14 : 18;
            const b = patrolBounds(world, p.x, p.y, w / 2, h / 2);
            assert.ok(b.max - b.min >= C.minPatrolSpan - 1e-9, `span ${b.max - b.min}`);
        }
    }
});

test('drifting boats have open water below them for their whole slide', () => {
    let drifters = 0;
    for (const { world, placements } of sweep(SEEDS.slice(0, 15))) {
        for (const p of placements) {
            if (p.kind !== 'patrol-boat' || p.mode !== 'drifter') continue;
            drifters++;
            for (let drop = 0; drop <= C.driftReach; drop += 8) {
                assert.notEqual(patrolBounds(world, p.x, p.y - drop, 18, 7), null, `blocked ${drop} below`);
            }
        }
    }
    assert.ok(drifters > 20, `only ${drifters} drifters`);
});

test('fighters wait just outside a bank, never over the water, and face across the river', () => {
    let fighters = 0;
    for (const { world, placements } of sweep()) {
        for (const p of placements) {
            if (p.kind !== 'fighter') continue;
            fighters++;
            const river = world.sample(p.y);
            if (p.direction === 1) assert.ok(p.x + 10 < river.leftBankX, 'parked on the left bank');
            else assert.ok(p.x - 10 > river.rightBankX, 'parked on the right bank');
            assert.ok(p.x > -30 && p.x < 990);
            assert.ok(p.speed >= 320 && p.speed <= 460);
            assert.ok(p.triggerDistance >= 540 && p.triggerDistance <= 660);
            assert.equal(world.getChannels(p.y).length, 1, 'fighters are not parked beside an island');
        }
    }
    assert.ok(fighters > 100, `only ${fighters} fighters`);
});

test('speeds are always inside each enemy type\u2019s allowed range', () => {
    for (const { placements } of sweep(SEEDS.slice(0, 15))) {
        for (const p of placements) {
            if (p.kind === 'helicopter') assert.ok(p.speed >= 80 && p.speed <= 140, `${p.speed}`);
            if (p.kind === 'patrol-boat' && p.mode === 'cruiser') assert.ok(p.speed >= 30 && p.speed <= 60);
            assert.ok(p.direction === 1 || p.direction === -1);
        }
    }
});

test('every placement builds an enemy of the right class with the right hitbox and score', () => {
    const { spawner, placements } = sweep([2026])[0];
    const seen = new Set();
    for (const p of placements) {
        const e = createEnemy(p);
        assert.equal(e.id, p.id);
        assert.equal(e.kind, p.kind);
        assert.deepEqual([e.x, e.y], [p.x, p.y]);
        assert.deepEqual([e.x, e.y], [spawner.create(p).x, spawner.create(p).y]);
        if (p.kind === 'helicopter') assert.ok(e instanceof Helicopter && e.points === 60);
        if (p.kind === 'patrol-boat') assert.ok(e instanceof PatrolBoat && e.points === 30);
        if (p.kind === 'fighter') assert.ok(e instanceof FighterJet && e.points === 100 && e.state === 'parked');
        seen.add(p.kind);
    }
    assert.deepEqual([...seen].sort(), ['fighter', 'helicopter', 'patrol-boat']);
});

// ------------------------------------------------------------ keep-out rules

test('nothing spawns in the opening stretch', () => {
    for (const { placements } of sweep()) for (const p of placements) assert.ok(p.y >= C.minY, `y ${p.y}`);
});

test('enemies keep clear of bridges (including the water a drifter will slide through)', () => {
    for (const { world, placements } of sweep()) {
        for (const p of placements) {
            const reach = p.kind === 'patrol-boat' && p.mode === 'drifter' ? C.driftReach : 0;
            assert.equal(world.findBridges(p.y - reach - C.bridgeClearance, p.y + C.bridgeClearance).length, 0, `${p.kind} y ${p.y}`);
        }
    }
});

test('enemies never overlap a fuel depot\u2019s Y band', () => {
    let checked = 0;
    for (const { depots, placements } of sweep(SEEDS.slice(0, 20))) {
        for (const p of placements) {
            const half = p.kind === 'patrol-boat' ? 7 : p.kind === 'helicopter' ? 9 : 11;
            const reach = p.kind === 'patrol-boat' && p.mode === 'drifter' ? C.driftReach : 0;
            const [first, last] = depots.slotRange(p.y - 400, p.y + 400);
            for (let slot = first; slot <= last; slot++) {
                const depot = depots.place(slot);
                if (!depot) continue;
                checked++;
                const apart = depot.y - p.y >= 22.5 + half + C.depotClearance - 1e-9
                    || p.y - reach - depot.y >= 22.5 + half + C.depotClearance - 1e-9;
                assert.ok(apart, `${p.kind} at ${p.y.toFixed(0)} vs depot at ${depot.y.toFixed(0)}`);
            }
        }
    }
    assert.ok(checked > 1000, `only ${checked} enemy/depot pairs checked`);
});

// ---------------------------------------------------------------------- pacing

test('stage and weights follow the spec', () => {
    const { spawner } = make(1);
    assert.deepEqual([0, 3199, 3200, 6400, 32000].map(y => spawner.stageAt(y)), [0, 0, 1, 2, 10]);
    assert.equal(spawner.stageAt(-100), 0);
    const chances = [0, 1, 2, 3, 10].map(s => spawner.chanceFor(s));
    assert.deepEqual(chances.slice(0, 3).map(c => +c.toFixed(2)), [0.5, 0.6, 0.7]);
    assert.ok(chances.every((c, i) => i === 0 || c >= chances[i - 1]));
    assert.equal(chances.at(-1), 0.9, 'capped');
    for (let s = 0; s <= 12; s++) {
        const w = spawner.weightsFor(s);
        assert.ok(Math.abs(w.boat + w.helicopter + w.fighter - 1) < 1e-12);
        assert.ok(w.boat > 0 && w.helicopter > 0 && w.fighter >= 0 && w.fighter <= 0.3);
        assert.equal(w.fighter > 0, s >= 2);
    }
    assert.ok(spawner.weightsFor(0).boat > spawner.weightsFor(5).boat);
});

function tally() {
    const stages = Array.from({ length: 10 }, () => ({ n: 0, boat: 0, heli: 0, fighter: 0, heliSpeedMax: 0, drifters: 0 }));
    for (const { spawner, placements } of sweep()) {
        for (const p of placements) {
            const s = stages[Math.min(9, spawner.stageAt(p.y))];
            s.n++;
            if (p.kind === 'patrol-boat') {
                s.boat++;
                if (p.mode === 'drifter') s.drifters++;
            } else if (p.kind === 'helicopter') {
                s.heli++;
                s.heliSpeedMax = Math.max(s.heliSpeedMax, p.speed);
            } else {
                s.fighter++;
            }
        }
    }
    return stages;
}

test('stage 1 is gentle: only boats and slow helicopters, no fighters', () => {
    const [s0, s1] = tally();
    assert.equal(s0.fighter, 0);
    assert.equal(s1.fighter, 0);
    assert.ok(s0.heliSpeedMax <= 98.01, `stage-0 helicopters reach ${s0.heliSpeedMax}`);
    assert.ok(s0.boat > s0.heli, `boats ${s0.boat} vs helicopters ${s0.heli}`);
    assert.ok(s0.drifters > 0, 'drifting boats appear from the start');
});

test('density climbs with the stage', () => {
    const t = tally();
    assert.ok(t[3].n > t[0].n * 2, `stage 0: ${t[0].n}, stage 3: ${t[3].n}`);
    for (let s = 1; s <= 4; s++) assert.ok(t[s].n >= t[s - 1].n, `stage ${s} thinner than ${s - 1}`);
    const perSeed = t.map(s => s.n / SEEDS.length);
    assert.ok(perSeed[0] > 1 && perSeed[0] < 5, `stage 0 average ${perSeed[0]}`);
    assert.ok(perSeed[5] > 5, `stage 5 average ${perSeed[5]}`);
});

test('fighters arrive from stage 3 on (bridge 2 cleared) and become a real share by stage 4', () => {
    const t = tally();
    assert.equal(t[2].fighter > 0, true, 'fighters appear in the third section');
    assert.ok(t[3].fighter > 0 && t[4].fighter > t[2].fighter);
    const share = t.slice(4).reduce((a, s) => a + s.fighter, 0) / t.slice(4).reduce((a, s) => a + s.n, 0);
    assert.ok(share > 0.12 && share < 0.32, `fighter share ${share}`);
});

test('helicopters speed up with the stage, reaching the full 140 by stage 3', () => {
    const t = tally();
    assert.ok(t[0].heliSpeedMax < t[1].heliSpeedMax && t[1].heliSpeedMax < t[2].heliSpeedMax);
    assert.ok(t[3].heliSpeedMax > 135);
    assert.ok(t.every(s => s.heliSpeedMax <= 140));
});

test('later stages favour helicopters over boats', () => {
    const t = tally();
    const share = s => s.heli / (s.heli + s.boat);
    assert.ok(share(t[5]) > share(t[0]) + 0.2, `${share(t[0])} -> ${share(t[5])}`);
});

test('chokepoint and canyon helicopters come in opposing pairs from stage 4 (bridge 3 cleared)', () => {
    let pairs = 0;
    let earlyPairs = 0;
    for (const { world, spawner, placements } of sweep()) {
        const bySlot = new Map();
        for (const p of placements) {
            const slot = Math.floor(p.id / 4);
            bySlot.set(slot, [...(bySlot.get(slot) ?? []), p]);
        }
        for (const group of bySlot.values()) {
            if (group.length !== 2 || !group.every(p => p.kind === 'helicopter')) continue;
            const kind = world.getSectionAt(group[0].y).kind;
            if (kind !== 'chokepoint' && kind !== 'canyon') continue;
            if (world.getChannels(group[0].y).length !== 1) continue;
            const gap = group[1].y - group[0].y;
            if (gap < 69 || gap > 111) continue;
            assert.notEqual(group[0].direction, group[1].direction, 'patrol in opposite directions');
            if (spawner.stageAt(group[0].y) < C.pairStage) earlyPairs++;
            pairs++;
        }
    }
    assert.ok(pairs > 15, `only ${pairs} pairs`);
    assert.equal(earlyPairs, 0, 'no pairs before the pair stage');
});

test('where an island splits the river both channels get their own enemy, and fighters stay away', () => {
    let both = 0;
    let oneSide = 0;
    for (const { world, placements } of sweep()) {
        const bySlot = new Map();
        for (const p of placements) bySlot.set(Math.floor(p.id / 4), [...(bySlot.get(Math.floor(p.id / 4)) ?? []), p]);
        for (const group of bySlot.values()) {
            const [first] = group;
            if (!first) continue;
            const channels = world.getChannels(first.y);
            if (channels.length !== 2) continue;
            assert.ok(group.every(p => p.kind !== 'fighter'));
            const sides = new Set(group.map(p => {
                const ch = world.getChannels(p.y);
                return ch.length === 2 ? (p.x < (ch[0].rightX + ch[1].leftX) / 2 ? 'L' : 'R') : 'x';
            }));
            if (sides.has('L') && sides.has('R')) both++;
            else oneSide++;
        }
    }
    assert.ok(both > 20, `only ${both} slots with enemies in both channels`);
    assert.ok(oneSide > 0);
});

// ------------------------------------------------------------------ config

test('invalid configuration is rejected', () => {
    const { world, depots } = make(1);
    for (const bad of [
        { spacing: 0 }, { jitter: -1 }, { jitter: 200 }, { baseChance: -0.1 }, { maxChance: 1.5 },
        { baseChance: 0.9, maxChance: 0.5 }, { chancePerStage: -1 }, { bridgeClearance: -1 },
        { fighterStage: 1.5 }, { pairStage: -1 }, { spacing: NaN },
    ]) {
        assert.throws(() => new EnemySpawner(world, depots, bad), RangeError, JSON.stringify(bad));
    }
});

test('a denser configuration spawns more, a sparser one fewer', () => {
    const count = config => make(9, config).spawner.placementsIn(0, MAX_Y).length;
    const normal = count({});
    assert.ok(count({ baseChance: 0.9, maxChance: 0.9 }) > normal);
    assert.ok(count({ baseChance: 0.1, chancePerStage: 0, maxChance: 0.1 }) < normal);
    assert.ok(count({ minY: 20000 }) < normal);
});
