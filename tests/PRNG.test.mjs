import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    Mulberry32, combineSeed, hashString, hashToSigned, hashToUnit, hashUint32, parseSeed, randomSeed, valueNoise1D,
} from '../dist/src/core/PRNG.js';

test('Mulberry32 is deterministic and seed-sensitive', () => {
    const a = new Mulberry32(12345);
    const b = new Mulberry32(12345);
    const c = new Mulberry32(12346);
    const seqA = Array.from({ length: 50 }, () => a.next());
    assert.deepEqual(seqA, Array.from({ length: 50 }, () => b.next()));
    assert.notDeepEqual(seqA, Array.from({ length: 50 }, () => c.next()));
});

test('Mulberry32 output is in [0, 1) with a sane distribution', () => {
    const rng = new Mulberry32(7);
    let sum = 0;
    const buckets = new Array(10).fill(0);
    const n = 20000;
    for (let i = 0; i < n; i++) {
        const v = rng.next();
        assert.ok(v >= 0 && v < 1);
        sum += v;
        buckets[Math.floor(v * 10)]++;
    }
    assert.ok(Math.abs(sum / n - 0.5) < 0.01);
    for (const count of buckets) assert.ok(Math.abs(count / n - 0.1) < 0.015);
});

test('Mulberry32 helpers respect their bounds and state can be restored', () => {
    const rng = new Mulberry32(99);
    for (let i = 0; i < 1000; i++) {
        const r = rng.range(-3, 5);
        assert.ok(r >= -3 && r < 5);
        const n = rng.int(2, 4);
        assert.ok(Number.isInteger(n) && n >= 2 && n <= 4);
    }
    const seen = new Set(Array.from({ length: 200 }, () => rng.int(2, 4)));
    assert.deepEqual([...seen].sort(), [2, 3, 4]);
    const state = rng.getState();
    const next = [rng.next(), rng.next()];
    rng.setState(state);
    assert.deepEqual([rng.next(), rng.next()], next);
});

test('shuffle is a deterministic permutation that does not mutate its input', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const a = new Mulberry32(5).shuffle(input);
    assert.deepEqual(a, new Mulberry32(5).shuffle(input));
    assert.deepEqual([...a].sort((x, y) => x - y), input);
    assert.deepEqual(input, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('hashing is stable, order-sensitive and well spread', () => {
    assert.equal(hashUint32(1), hashUint32(1));
    assert.notEqual(combineSeed(1, 2), combineSeed(2, 1));
    assert.equal(combineSeed(1, 2, 3), combineSeed(1, 2, 3));
    const outputs = new Set();
    for (let i = 0; i < 5000; i++) outputs.add(combineSeed(42, i));
    assert.equal(outputs.size, 5000);
    for (const v of [hashUint32(-1), combineSeed(-5, 2 ** 40), hashString('river')]) {
        assert.ok(Number.isInteger(v) && v >= 0 && v <= 0xffffffff);
    }
    for (let i = -50; i < 50; i++) {
        const u = hashToUnit(3, i, 9);
        const s = hashToSigned(3, i, 9);
        assert.ok(u >= 0 && u < 1 && s >= -1 && s < 1);
    }
});

test('valueNoise1D is bounded, continuous and deterministic', () => {
    let previous = valueNoise1D(8, 1, -20);
    let maxStep = 0;
    for (let x = -20; x < 400; x += 0.01) {
        const v = valueNoise1D(8, 1, x);
        assert.ok(v >= -1 && v < 1);
        maxStep = Math.max(maxStep, Math.abs(v - previous));
        previous = v;
    }
    assert.ok(maxStep < 0.04, `noise jumped by ${maxStep}`);
    assert.equal(valueNoise1D(8, 1, 3.3), valueNoise1D(8, 1, 3.3));
    assert.notEqual(valueNoise1D(8, 1, 3.3), valueNoise1D(8, 2, 3.3));
    assert.notEqual(valueNoise1D(8, 1, 3.3), valueNoise1D(9, 1, 3.3));
});

test('parseSeed round-trips numbers, hashes text and trims whitespace', () => {
    assert.equal(parseSeed('2026'), 2026);
    assert.equal(parseSeed('  42  '), 42);
    assert.equal(parseSeed('4294967295'), 4294967295);
    assert.equal(parseSeed('hello'), hashString('hello'));
    assert.equal(parseSeed('4294967296'), hashString('4294967296'));
    assert.equal(parseSeed('-5'), hashString('-5'));
    assert.equal(parseSeed(''), hashString(''));
});

test('randomSeed returns unsigned 32-bit integers that vary', () => {
    const seeds = new Set(Array.from({ length: 20 }, () => randomSeed()));
    for (const s of seeds) assert.ok(Number.isInteger(s) && s >= 0 && s <= 0xffffffff);
    assert.ok(seeds.size > 15);
});
