import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_RIVER_CONFIG, RiverGenerator } from '../dist/src/world/RiverGenerator.js';

const C = DEFAULT_RIVER_CONFIG;
const SEEDS = Array.from({ length: 25 }, (_, i) => i * 7919 + 1);
const SLICES = 6000; // 48,000 world units: ~75 sections, ~15 bridges
const EPS = 1e-9;

function* eachSlice(seed, count = SLICES) {
    const g = new RiverGenerator(seed);
    for (let i = 0; i < count; i++) yield g.getSlice(i);
}

test('same seed => identical river; different seed => different river', () => {
    const a = new RiverGenerator(2026);
    const b = new RiverGenerator(2026);
    const c = new RiverGenerator(2027);
    let differs = 0;
    for (let i = 0; i < 2000; i++) {
        assert.deepEqual(a.getSlice(i), b.getSlice(i));
        if (a.getSlice(i).leftBankX !== c.getSlice(i).leftBankX) differs++;
    }
    assert.ok(differs > 1900);
});

test('generation is order independent and survives pruning', () => {
    const sequential = new RiverGenerator(77);
    const expected = Array.from({ length: 800 }, (_, i) => sequential.getSlice(i));
    const shuffled = new RiverGenerator(77);
    const order = Array.from({ length: 800 }, (_, i) => (i * 389) % 800);
    for (const i of order) assert.deepEqual(shuffled.getSlice(i), expected[i]);
    shuffled.prune(400 * C.sliceHeight);
    assert.ok(shuffled.cachedSliceCount <= 400);
    for (let i = 0; i < 800; i++) assert.deepEqual(shuffled.getSlice(i), expected[i]);
});

test('negative and zero-region queries are valid and continuous', () => {
    const g = new RiverGenerator(5);
    assert.deepEqual(
        [g.getSlice(-3).leftBankX, g.getSlice(-1).leftBankX],
        [g.getSlice(0).leftBankX, g.getSlice(0).leftBankX],
    );
    assert.equal(g.getSlice(-2).isBridgeSection, false);
    assert.equal(g.isLand(-1, 0), true);
});

test('banks keep a navigable width and stay inside the world', () => {
    for (const seed of SEEDS) {
        for (const s of eachSlice(seed)) {
            assert.ok(s.rightBankX - s.leftBankX >= C.minRiverWidth - EPS, `seed ${seed} y ${s.worldY}`);
            assert.ok(s.leftBankX >= C.sideMargin - C.bankWobble - EPS);
            assert.ok(s.rightBankX <= C.worldWidth - C.sideMargin + C.bankWobble + EPS);
            assert.ok(Number.isFinite(s.leftBankX) && Number.isFinite(s.rightBankX));
        }
    }
});

test('banks are smooth: no sharp zig-zags between slices', () => {
    let worst = 0;
    for (const seed of SEEDS) {
        let previous = null;
        for (const s of eachSlice(seed)) {
            if (previous) {
                worst = Math.max(
                    worst,
                    Math.abs(s.leftBankX - previous.leftBankX) / C.sliceHeight,
                    Math.abs(s.rightBankX - previous.rightBankX) / C.sliceHeight,
                );
            }
            previous = s;
        }
    }
    assert.ok(worst < 2.1, `steepest bank slope ${worst.toFixed(2)} (dx per dy)`);
});

test('islands split the river into two navigable channels', () => {
    let branching = 0;
    for (const seed of SEEDS) {
        for (const s of eachSlice(seed)) {
            if (!s.isBranching) {
                assert.equal(s.islandLeftX, s.islandRightX);
                continue;
            }
            branching++;
            assert.ok(s.islandRightX > s.islandLeftX);
            assert.ok(s.islandLeftX - s.leftBankX >= C.minChannelWidth - EPS, `left channel, seed ${seed}`);
            assert.ok(s.rightBankX - s.islandRightX >= C.minChannelWidth - EPS, `right channel, seed ${seed}`);
            assert.equal(s.sectionKind, 'channel');
        }
    }
    assert.ok(branching > 5000, `only ${branching} branching slices across all seeds`);
});

test('bridges: regular spacing, correct thickness, never beside islands', () => {
    const g = new RiverGenerator(31337);
    const spacing = C.bridgeEverySections * C.sectionLength;
    const flaggedYs = [];
    for (let i = 0; i < SLICES + 10; i++) { // +10 so the 15th bridge is complete
        const s = g.getSlice(i);
        if (s.isBridgeSection) flaggedYs.push(s.worldY);
        assert.equal(s.isBridgeSection, g.isBridge(s.worldY));
        if (s.isBridgeSection) assert.equal(s.isBranching, false);
    }
    const centers = [...new Set(flaggedYs.map(y => Math.round(y / spacing) * spacing))];
    assert.ok(centers.length >= 10);
    centers.forEach((c, i) => assert.equal(c, (i + 1) * spacing));
    for (const c of centers) {
        const inside = flaggedYs.filter(y => Math.abs(y - c) <= C.bridgeHalfThickness);
        assert.equal(inside.length, (2 * C.bridgeHalfThickness) / C.sliceHeight + 1);
        for (let d = -200; d <= 200; d += C.sliceHeight) assert.equal(g.getSlice((c + d) / C.sliceHeight).isBranching, false);
    }
    assert.equal(g.isBridge(0), false);
    assert.equal(g.isBridge(C.bridgeHalfThickness + 1), false);
    assert.equal(g.isBridge(spacing + C.bridgeHalfThickness), true);
    assert.equal(g.isBridge(spacing + C.bridgeHalfThickness + 0.5), false);
});

test('bridge lookups: findBridges and nextBridgeY', () => {
    const g = new RiverGenerator(1);
    const spacing = C.bridgeEverySections * C.sectionLength;
    assert.deepEqual(g.findBridges(0, spacing - 100), []);
    const found = g.findBridges(0, 3 * spacing + 1);
    assert.deepEqual(found.map(b => b.number), [1, 2, 3]);
    assert.equal(found[0].centerY, spacing);
    assert.equal(found[0].topY - found[0].bottomY, 2 * C.bridgeHalfThickness);
    assert.equal(g.findBridges(spacing + C.bridgeHalfThickness - 1, spacing + 500).length, 1);
    assert.equal(g.findBridges(spacing + C.bridgeHalfThickness + 1, spacing + 500).length, 0);
    assert.equal(g.nextBridgeY(0), spacing);
    assert.equal(g.nextBridgeY(spacing), 2 * spacing);
    assert.equal(g.nextBridgeY(spacing - 1), spacing);
});

test('pacing: wide training straits first, then varied sections between calm bridge approaches', () => {
    const kindsSeen = new Set();
    for (const seed of SEEDS) {
        const g = new RiverGenerator(seed);
        for (let k = 0; k < C.trainingSections; k++) {
            const s = g.getSection(k);
            assert.equal(s.kind, 'strait');
            assert.ok(s.width >= 700, `training width ${s.width}`);
        }
        // The first stretch of river (up to where it starts easing into the next section)
        // must be wide and island-free: sample every slice of it.
        const calmLength = C.trainingSections * C.sectionLength - C.transitionLength / 2;
        for (let i = 0; i < calmLength / C.sliceHeight; i++) {
            const s = g.getSlice(i);
            assert.ok(s.rightBankX - s.leftBankX >= 600, `seed ${seed}, slice ${i}`);
            assert.equal(s.isBranching, false);
        }
        for (let k = 0; k < 60; k++) {
            const s = g.getSection(k);
            kindsSeen.add(s.kind);
            if (s.position === 0 || s.position === C.bridgeEverySections - 1) assert.equal(s.kind, 'strait');
            assert.equal(s.startY, k * C.sectionLength);
            assert.equal(s.stage, Math.floor(k / C.bridgeEverySections));
            if (k >= C.trainingSections && s.kind !== 'strait' && k > 0) {
                assert.notEqual(g.getSection(k - 1).kind, s.kind, `repeated ${s.kind} at ${k}, seed ${seed}`);
            }
        }
    }
    assert.deepEqual([...kindsSeen].sort(), ['canyon', 'channel', 'chokepoint', 'strait']);
});

test('difficulty ramps up: late canyons are narrower than early ones', () => {
    const g = new RiverGenerator(11);
    const widths = (from, to, kind) => {
        const out = [];
        for (let k = from; k < to; k++) if (g.getSection(k).kind === kind) out.push(g.getSection(k).width);
        return out;
    };
    const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
    assert.ok(avg(widths(2, 40, 'canyon')) > avg(widths(80, 400, 'canyon')));
    assert.ok(g.getSection(1000).difficulty === 1 && g.getSection(0).difficulty === 0);
});

test('spatial query: sample() matches slices and interpolates linearly', () => {
    const g = new RiverGenerator(404);
    for (const i of [0, 5, 100, 733]) {
        const s = g.getSlice(i);
        const sample = g.sample(s.worldY);
        assert.equal(sample.leftBankX, s.leftBankX);
        assert.equal(sample.rightBankX, s.rightBankX);
        assert.equal(sample.width, s.rightBankX - s.leftBankX);
    }
    const a = g.getSlice(50);
    const b = g.getSlice(51);
    const mid = g.sample(50.5 * C.sliceHeight);
    assert.ok(Math.abs(mid.leftBankX - (a.leftBankX + b.leftBankX) / 2) < 1e-9);
    assert.ok(Math.abs(mid.centerX - (mid.leftBankX + mid.rightBankX) / 2) < 1e-9);
});

test('spatial query: isLand agrees with banks, islands and the world edge', () => {
    let checkedIsland = 0;
    for (const seed of SEEDS.slice(0, 10)) {
        const g = new RiverGenerator(seed);
        for (let i = 0; i < 3000; i += 3) {
            const s = g.getSlice(i);
            const y = s.worldY;
            assert.equal(g.isLand(s.leftBankX - 0.5, y), true);
            assert.equal(g.isLand(s.rightBankX + 0.5, y), true);
            assert.equal(g.isLand(0, y), true);
            assert.equal(g.isLand(C.worldWidth, y), true);
            if (s.isBranching) {
                checkedIsland++;
                assert.equal(g.isLand((s.islandLeftX + s.islandRightX) / 2, y), true);
                assert.equal(g.isLand((s.leftBankX + s.islandLeftX) / 2, y), false);
                assert.equal(g.isLand((s.rightBankX + s.islandRightX) / 2, y), false);
            } else {
                assert.equal(g.isLand((s.leftBankX + s.rightBankX) / 2, y), false);
            }
        }
    }
    assert.ok(checkedIsland > 100);
    const g = new RiverGenerator(1);
    for (const x of [-1, -1e9, C.worldWidth + 1, NaN]) assert.equal(g.isLand(x, 100), true);
});

test('spatial query: bridges are not land; getBounds exposes isLand for any position', () => {
    const g = new RiverGenerator(9);
    const bridgeY = C.bridgeEverySections * C.sectionLength;
    const s = g.sample(bridgeY);
    assert.equal(s.isBridgeSection, true);
    assert.equal(g.isLand(s.centerX, bridgeY), false);
    const bounds = g.getBounds(500);
    const sample = g.sample(500);
    assert.equal(bounds.leftBankX, sample.leftBankX);
    assert.equal(bounds.rightBankX, sample.rightBankX);
    assert.equal(bounds.isLand(sample.leftBankX - 1, 500), true);
    assert.equal(bounds.isLand(sample.centerX, 500), false);
    assert.equal(bounds.isLand(g.sample(900).leftBankX - 1, 900), true); // other Y than the bounds' own
});

test('getChannels returns one channel normally and two around islands', () => {
    const g = new RiverGenerator(2026);
    let single = 0;
    let split = 0;
    for (let i = 0; i < 2500; i++) {
        const y = i * C.sliceHeight;
        const channels = g.getChannels(y);
        const s = g.sample(y);
        if (s.isBranching) {
            split++;
            assert.equal(channels.length, 2);
            assert.ok(channels[0].rightX < channels[1].leftX);
            for (const ch of channels) assert.ok(ch.rightX - ch.leftX >= C.minChannelWidth - EPS);
        } else {
            single++;
            assert.deepEqual(channels, [{ leftX: s.leftBankX, rightX: s.rightBankX }]);
        }
    }
    assert.ok(single > 0 && split > 0);
});

test('slice flags are internally consistent', () => {
    for (const s of eachSlice(123, 2000)) {
        assert.equal(s.index * C.sliceHeight, s.worldY);
        assert.equal(s.isBranching, s.islandRightX > s.islandLeftX);
        assert.equal(s.sectionIndex, Math.floor(Math.max(0, s.worldY) / C.sectionLength));
    }
});

test('custom configs work and invalid ones are rejected', () => {
    const g = new RiverGenerator(1, { bridgeEverySections: 3, sectionLength: 480, transitionLength: 240 });
    assert.equal(g.findBridges(0, 5000)[0].centerY, 1440);
    for (const bad of [
        { sliceHeight: 7 },
        { transitionLength: 9999 },
        { bridgeEverySections: 1 },
        { bridgeEverySections: 2.5 },
        { trainingSections: -1 },
        { minRiverWidth: 900 },
        { sideMargin: 1, bankWobble: 5 },
        { worldWidth: 0 },
        { bridgeHalfThickness: 1000 },
    ]) {
        assert.throws(() => new RiverGenerator(1, bad), RangeError, JSON.stringify(bad));
    }
    assert.throws(() => new RiverGenerator(Infinity), RangeError);
    assert.equal(new RiverGenerator(-1).seed, 0xffffffff);
});

test('slice cache stays bounded', () => {
    const g = new RiverGenerator(3);
    for (let i = 0; i < 20000; i++) g.getSlice(i);
    assert.ok(g.cachedSliceCount <= 8192);
    assert.deepEqual(g.getSlice(19999), new RiverGenerator(3).getSlice(19999));
});
