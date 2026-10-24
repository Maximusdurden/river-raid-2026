import { Mulberry32 } from '../core/PRNG.js';

/**
 * The high-score celebration on the canvas: what to show and when to set off fireworks.
 *
 * `start` begins it, `update` advances it by simulation steps and says when a burst is due, and the
 * renderer reads `kind`, `age` and `intensity` to draw the golden border and banner. A normal Top 10
 * run gets a short, modest show; beating the all-time record gets a longer, louder one.
 * The burst positions come from a fixed seed, so a given celebration always looks the same.
 */
export type CelebrationKind = 'high-score' | 'record';

export interface CelebrationBurst {
    /** Screen position in the 960x720 view. */
    readonly x: number;
    readonly y: number;
    /** Relative size, around 1. */
    readonly scale: number;
    /** 0, 1, 2 ...: lets the host mix in a bigger blast now and then. */
    readonly index: number;
}

export interface CelebrationSpec {
    /** Seconds between bursts. */
    readonly interval: number;
    /** How long bursts keep going. */
    readonly duration: number;
    readonly minScale: number;
    readonly maxScale: number;
}

export const CELEBRATION_SPECS: Readonly<Record<CelebrationKind, CelebrationSpec>> = {
    'high-score': { interval: 0.55, duration: 3.5, minScale: 0.7, maxScale: 1.0 },
    record: { interval: 0.26, duration: 7, minScale: 0.9, maxScale: 1.6 },
};

const VIEW = { left: 110, right: 850, top: 120, bottom: 470 } as const;

export class Celebration {
    private current: CelebrationKind | null = null;
    private elapsed = 0;
    private untilBurst = 0;
    private bursts = 0;
    private rng = new Mulberry32(0x601d);

    /** What is being celebrated, or null when nothing is. */
    get kind(): CelebrationKind | null {
        return this.current;
    }

    get active(): boolean {
        return this.current !== null;
    }

    /** Seconds since it started. */
    get age(): number {
        return this.elapsed;
    }

    /** How many bursts have gone off. */
    get burstCount(): number {
        return this.bursts;
    }

    /** 1 at the start, easing to 0 once the bursts have finished: a cue for the border to settle. */
    get intensity(): number {
        if (!this.current) return 0;
        const spec = CELEBRATION_SPECS[this.current];
        return Math.max(0, 1 - this.elapsed / (spec.duration * 1.5));
    }

    start(kind: CelebrationKind): void {
        this.current = kind;
        this.elapsed = 0;
        this.untilBurst = 0.05; // the first burst is almost immediate
        this.bursts = 0;
        this.rng = new Mulberry32(kind === 'record' ? 0xc0ffee : 0x5eed);
    }

    stop(): void {
        this.current = null;
        this.elapsed = 0;
        this.untilBurst = 0;
        this.bursts = 0;
    }

    /** Advances by `dt` seconds, calling `burst` for each firework that is due (usually 0 or 1). */
    update(dt: number, burst: (burst: CelebrationBurst) => void): void {
        if (!this.current || !(dt > 0) || !Number.isFinite(dt)) return;
        const spec = CELEBRATION_SPECS[this.current];
        this.elapsed += dt;
        if (this.elapsed > spec.duration) return;
        this.untilBurst -= dt;
        while (this.untilBurst <= 0) {
            this.untilBurst += spec.interval;
            const r = this.rng;
            burst({
                x: r.range(VIEW.left, VIEW.right),
                y: r.range(VIEW.top, VIEW.bottom),
                scale: r.range(spec.minScale, spec.maxScale),
                index: this.bursts++,
            });
        }
    }
}
