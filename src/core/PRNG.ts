/**
 * Deterministic seeded randomness.
 *
 * Two complementary tools:
 *  - `Mulberry32`: a tiny sequential PRNG (order-dependent stream).
 *  - Stateless hashing / value noise: pure functions of (seed, coordinates), which
 *    allow random access (query any world position in any order and always get the
 *    same answer). The river generator relies on both.
 *
 * Everything here uses 32-bit integer math only, so results are identical across
 * browsers and Node, and across runs.
 */

const UINT32_RANGE = 4294967296;

/** Murmur3 finalizer: a bijective 32-bit avalanche mix. Returns an unsigned 32-bit integer. */
export function hashUint32(value: number): number {
    let h = value | 0;
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
}

/** Combines integers into a single well-mixed unsigned 32-bit hash (order-sensitive). */
export function combineSeed(...parts: readonly number[]): number {
    let h = 0x9e3779b9;
    for (const part of parts) {
        h = hashUint32((h ^ Math.imul(part | 0, 0x85ebca77)) + 0x165667b1);
    }
    return h >>> 0;
}

/** FNV-1a hash of a string, as an unsigned 32-bit integer. */
export function hashString(text: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

/**
 * Converts user-entered seed text to a seed. Plain unsigned integers up to 2^32-1
 * are used as-is (so a displayed seed can be typed back in); anything else is hashed.
 */
export function parseSeed(text: string): number {
    const trimmed = text.trim();
    if (/^\d{1,10}$/.test(trimmed)) {
        const value = Number(trimmed);
        if (value < UINT32_RANGE) return value >>> 0;
    }
    return hashString(trimmed);
}

/** A fresh non-deterministic seed (uses Web Crypto when available). */
export function randomSeed(): number {
    const cryptoSource = (globalThis as { crypto?: Crypto }).crypto;
    if (cryptoSource && typeof cryptoSource.getRandomValues === 'function') {
        return cryptoSource.getRandomValues(new Uint32Array(1))[0] ?? 0;
    }
    return Math.floor(Math.random() * UINT32_RANGE) >>> 0;
}

/** Stateless uniform value in [0, 1) derived from (seed, a, b). */
export function hashToUnit(seed: number, a: number, b: number = 0): number {
    return combineSeed(seed, a, b) / UINT32_RANGE;
}

/** Stateless uniform value in [-1, 1) derived from (seed, a, b). */
export function hashToSigned(seed: number, a: number, b: number = 0): number {
    return hashToUnit(seed, a, b) * 2 - 1;
}

/**
 * Smooth 1D value noise in [-1, 1). C2-continuous (quintic fade) so derived curves
 * never have kinks. `channel` selects an independent noise stream.
 */
export function valueNoise1D(seed: number, channel: number, x: number): number {
    const cell = Math.floor(x);
    const t = x - cell;
    const fade = t * t * t * (t * (t * 6 - 15) + 10);
    const a = hashToSigned(seed, channel, cell);
    const b = hashToSigned(seed, channel, cell + 1);
    return a + (b - a) * fade;
}

/** Mulberry32 sequential PRNG. Same seed => same stream, always. */
export class Mulberry32 {
    private state: number;

    constructor(seed: number) {
        this.state = seed | 0;
    }

    /** Uniform float in [0, 1). */
    next(): number {
        this.state = (this.state + 0x6d2b79f5) | 0;
        let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE;
    }

    /** Uniform float in [min, max). */
    range(min: number, max: number): number {
        return min + (max - min) * this.next();
    }

    /** Uniform integer in [min, max] (both inclusive). */
    int(min: number, max: number): number {
        return min + Math.floor(this.next() * (max - min + 1));
    }

    /** True with the given probability. */
    chance(probability: number): boolean {
        return this.next() < probability;
    }

    /** Fisher-Yates shuffle; returns a new array and leaves the input untouched. */
    shuffle<T>(items: readonly T[]): T[] {
        const result = items.slice();
        for (let i = result.length - 1; i > 0; i--) {
            const j = this.int(0, i);
            const a = result[i] as T;
            result[i] = result[j] as T;
            result[j] = a;
        }
        return result;
    }

    /** Snapshot of the internal state (for save/restore or replays). */
    getState(): number {
        return this.state;
    }

    setState(state: number): void {
        this.state = state | 0;
    }
}
