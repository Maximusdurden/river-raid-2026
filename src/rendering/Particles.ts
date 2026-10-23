import { Mulberry32 } from '../core/PRNG.js';

/**
 * Lightweight particle system for explosions, sparks and afterburner trails.
 *
 * - Fixed-capacity pool: particles are preallocated and recycled (swap-remove), so
 *   steady-state play allocates no particle objects. When the pool is full new
 *   particles are dropped (and counted) rather than growing.
 * - Particles live in WORLD space, so explosions stay put on the ground while the
 *   camera scrolls past, and exhaust is naturally left behind as a trail.
 * - `update` runs in the fixed simulation step; `render` interpolates between each
 *   particle's previous and current position with the loop's alpha.
 * - Visual randomness comes from a seeded PRNG, so runs stay reproducible.
 */

export type ParticleKind =
    | 'fire' | 'smoke' | 'spark' | 'debris' | 'shockwave' | 'exhaust'
    /** Soft white contrail that expands and fades (fighters). */
    | 'vapor'
    /** A spinning rotor blade fragment. */
    | 'blade'
    /** Water droplets thrown up by a sinking hull. */
    | 'splash';

/** Which wreck an enemy explosion should look like. */
export type WreckStyle = 'helicopter' | 'patrol-boat' | 'fighter';

export interface Particle {
    kind: ParticleKind;
    x: number;
    y: number;
    previousX: number;
    previousY: number;
    vx: number;
    vy: number;
    /** Exponential velocity damping, 1/s. */
    drag: number;
    age: number;
    life: number;
    size: number;
    sizeEnd: number;
    rotation: number;
    spin: number;
    /** Random 0..1 value used to vary colour. */
    tint: number;
}

export interface ParticleInit {
    kind: ParticleKind;
    x: number;
    y: number;
    vx?: number;
    vy?: number;
    life: number;
    size: number;
    sizeEnd?: number;
    drag?: number;
    spin?: number;
    tint?: number;
}

export interface ParticleSystemOptions {
    capacity?: number;
    seed?: number;
}

const TAU = Math.PI * 2;
const DEFAULT_CAPACITY = 1400;

type Rgb = readonly [number, number, number];

function buildRamp(stops: readonly Rgb[], steps: number): string[] {
    const ramp: string[] = [];
    for (let i = 0; i < steps; i++) {
        const t = (i / (steps - 1)) * (stops.length - 1);
        const k = Math.min(stops.length - 2, Math.floor(t));
        const a = stops[k];
        const b = stops[k + 1];
        if (!a || !b) continue;
        const f = t - k;
        ramp.push(`rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`);
    }
    return ramp;
}

const FIRE_RAMP = buildRamp([[255, 250, 214], [255, 198, 84], [255, 112, 26], [170, 46, 14], [64, 22, 12]], 16);
const EXHAUST_RAMP = buildRamp([[225, 242, 255], [255, 214, 128], [255, 120, 40]], 12);
const SMOKE_COLORS: readonly string[] = ['#2a2d35', '#383c45', '#4a4e57'];
const SPARK_COLORS: readonly string[] = ['#fff3c4', '#ffd27a', '#ffffff'];
const DEBRIS_COLORS: readonly string[] = ['#20242c', '#3b3128', '#58606e'];
const BLADE_COLORS: readonly string[] = ['#3a3f48', '#262a31', '#6b7280'];

function pick(colors: readonly string[], tint: number): string {
    return colors[Math.min(colors.length - 1, Math.floor(tint * colors.length))] ?? '#888888';
}

function rampColor(ramp: readonly string[], t: number): string {
    return ramp[Math.min(ramp.length - 1, Math.max(0, Math.floor(t * ramp.length)))] ?? '#ffffff';
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

export class ParticleSystem {
    readonly capacity: number;
    /** Particles rejected because the pool was full. */
    dropped = 0;

    private readonly pool: Particle[];
    private active = 0;
    private rng: Mulberry32;

    constructor(options: ParticleSystemOptions = {}) {
        this.capacity = options.capacity ?? DEFAULT_CAPACITY;
        if (!Number.isInteger(this.capacity) || this.capacity < 1) {
            throw new RangeError('ParticleSystem capacity must be an integer >= 1.');
        }
        this.rng = new Mulberry32(options.seed ?? 0x9a17c1e5);
        this.pool = Array.from({ length: this.capacity }, (): Particle => ({
            kind: 'spark', x: 0, y: 0, previousX: 0, previousY: 0, vx: 0, vy: 0, drag: 0,
            age: 0, life: 1, size: 1, sizeEnd: 0, rotation: 0, spin: 0, tint: 0,
        }));
    }

    /** Number of live particles. */
    get count(): number {
        return this.active;
    }

    /** Copy of the live particles (for tests and tools; not for the hot path). */
    snapshot(): Particle[] {
        return this.pool.slice(0, this.active).map(p => ({ ...p }));
    }

    reseed(seed: number): void {
        this.rng = new Mulberry32(seed);
    }

    clear(): void {
        this.active = 0;
        this.dropped = 0;
    }

    /** Spawns one particle. Returns false (and counts a drop) if the pool is full. */
    emit(init: ParticleInit): boolean {
        if (this.active >= this.capacity) {
            this.dropped++;
            return false;
        }
        const p = this.pool[this.active++] as Particle;
        p.kind = init.kind;
        p.x = init.x;
        p.y = init.y;
        p.previousX = init.x;
        p.previousY = init.y;
        p.vx = init.vx ?? 0;
        p.vy = init.vy ?? 0;
        p.drag = init.drag ?? 0;
        p.age = 0;
        p.life = Math.max(1e-3, init.life);
        p.size = init.size;
        p.sizeEnd = init.sizeEnd ?? init.size;
        p.rotation = 0;
        p.spin = init.spin ?? 0;
        p.tint = init.tint ?? 0;
        return true;
    }

    /** Advances all particles one fixed step and recycles the expired ones. */
    update(dt: number): void {
        if (!(dt > 0) || !Number.isFinite(dt)) return;
        for (let i = this.active - 1; i >= 0; i--) {
            const p = this.pool[i] as Particle;
            p.age += dt;
            if (p.age >= p.life) {
                const last = this.active - 1;
                this.pool[i] = this.pool[last] as Particle;
                this.pool[last] = p;
                this.active = last;
                continue;
            }
            p.previousX = p.x;
            p.previousY = p.y;
            if (p.drag > 0) {
                const damp = Math.exp(-p.drag * dt);
                p.vx *= damp;
                p.vy *= damp;
            }
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.rotation += p.spin * dt;
        }
    }

    // ------------------------------------------------------------- emitters

    /** A fireball: shockwave ring, flash, flames, smoke, sparks and tumbling debris. */
    explosion(x: number, y: number, scale = 1): void {
        const s = Math.max(0.2, scale);
        const r = this.rng;
        this.emit({ kind: 'shockwave', x, y, life: 0.5, size: 6 * s, sizeEnd: 78 * s });
        this.emit({ kind: 'fire', x, y, life: 0.2, size: 26 * s, sizeEnd: 6 * s });
        for (let i = 0, n = Math.round(10 * s); i < n; i++) {
            const angle = r.range(0, TAU);
            const speed = r.range(25, 150) * s;
            this.emit({
                kind: 'fire', x: x + Math.cos(angle) * 3, y: y + Math.sin(angle) * 3,
                vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
                life: r.range(0.45, 0.9), size: r.range(7, 15) * s, sizeEnd: 2, drag: 2.2, tint: r.next(),
            });
        }
        for (let i = 0, n = Math.round(7 * s); i < n; i++) {
            const angle = r.range(0, TAU);
            const speed = r.range(8, 50) * s;
            this.emit({
                kind: 'smoke', x, y,
                vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed + 12,
                life: r.range(1, 1.8), size: r.range(9, 16) * s, sizeEnd: r.range(26, 40) * s, drag: 1.2, tint: r.next(),
            });
        }
        for (let i = 0, n = Math.round(18 * s); i < n; i++) {
            const angle = r.range(0, TAU);
            const speed = r.range(120, 380) * s;
            this.emit({
                kind: 'spark', x, y,
                vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
                life: r.range(0.35, 0.8), size: 1.6, sizeEnd: 0.4, drag: 1.8, tint: r.next(),
            });
        }
        for (let i = 0, n = Math.round(6 * s); i < n; i++) {
            const angle = r.range(0, TAU);
            const speed = r.range(60, 220) * s;
            this.emit({
                kind: 'debris', x, y,
                vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
                life: r.range(0.8, 1.5), size: r.range(2.5, 4), sizeEnd: 1.5, drag: 1.5,
                spin: r.range(-12, 12), tint: r.next(),
            });
        }
    }

    /** A small spray of sparks, e.g. a missile hitting a bank. */
    impactSparks(x: number, y: number, count = 8): void {
        const r = this.rng;
        for (let i = 0; i < count; i++) {
            const angle = r.range(0, TAU);
            const speed = r.range(60, 200);
            this.emit({
                kind: 'spark', x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
                life: r.range(0.15, 0.4), size: 1.4, sizeEnd: 0.3, drag: 3, tint: r.next(),
            });
        }
        this.emit({ kind: 'fire', x, y, life: 0.12, size: 7, sizeEnd: 1 });
    }

    /**
     * An enemy going down. Helicopters shed spinning rotor blades, boats throw up water and
     * foam, fighters leave a long streak of sparks; all of them blow up in a (smaller)
     * fireball.
     */
    enemyExplosion(x: number, y: number, style: WreckStyle, scale = 1): void {
        const s = Math.max(0.2, scale);
        const r = this.rng;
        this.explosion(x, y, (style === 'patrol-boat' ? 0.8 : 0.7) * s);
        if (style === 'helicopter') {
            for (let i = 0, n = Math.round(4 * s); i < n; i++) {
                const angle = r.range(0, TAU);
                const speed = r.range(70, 190);
                this.emit({
                    kind: 'blade', x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
                    life: r.range(0.6, 1.1), size: r.range(5, 9), sizeEnd: r.range(4, 7), drag: 1.4,
                    spin: r.range(-26, 26), tint: r.next(),
                });
            }
        } else if (style === 'patrol-boat') {
            for (let i = 0, n = Math.round(16 * s); i < n; i++) {
                const angle = r.range(0, TAU);
                const speed = r.range(30, 130);
                this.emit({
                    kind: 'splash', x: x + r.range(-12, 12), y: y + r.range(-4, 4),
                    vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed + 35,
                    life: r.range(0.35, 0.8), size: r.range(1.4, 2.6), sizeEnd: 0.4, drag: 2.2, tint: r.next(),
                });
            }
        } else {
            for (let i = 0, n = Math.round(10 * s); i < n; i++) {
                const angle = r.range(-0.5, 0.5) + (r.chance(0.5) ? 0 : Math.PI);
                const speed = r.range(220, 460);
                this.emit({
                    kind: 'spark', x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed * 0.6,
                    life: r.range(0.3, 0.7), size: 1.8, sizeEnd: 0.4, drag: 2.4, tint: r.next(),
                });
            }
        }
    }

    /**
     * Contrail for a streaking fighter, emitted at its tail every fixed step. `dirX` is the
     * direction of travel (+1 or -1), so the trail is left behind it.
     */
    vaporTrail(x: number, y: number, dirX: number): void {
        const r = this.rng;
        const dir = dirX < 0 ? -1 : 1;
        for (let i = 0; i < 2; i++) {
            this.emit({
                kind: 'vapor', x: x - dir * r.range(0, 6), y: y + r.range(-5, 5),
                vx: -dir * r.range(8, 30), vy: r.range(-8, 8),
                life: r.range(0.55, 0.95), size: r.range(1.8, 3), sizeEnd: r.range(7, 12), drag: 1.1, tint: r.next(),
            });
        }
    }

    /**
     * Exhaust trail emitted at the jet's tail each fixed step. `throttle` in [-1, 1]
     * scales the density and lifetime; `speed` is the jet's forward speed.
     */
    afterburner(x: number, y: number, speed: number, throttle: number): void {
        const r = this.rng;
        const t = Math.max(-1, Math.min(1, throttle));
        const density = 0.45 + 0.55 * ((t + 1) / 2) + (t > 0.5 ? 0.6 : 0);
        for (let budget = density; budget > 0; budget -= 1) {
            if (budget < 1 && r.next() > budget) break;
            this.emit({
                kind: 'exhaust',
                x: x + r.range(-2.2, 2.2), y,
                vx: r.range(-14, 14), vy: speed * 0.45 - r.range(10, 50),
                life: r.range(0.22, 0.4) * (0.8 + 0.5 * ((t + 1) / 2)),
                size: r.range(2.4, 3.6), sizeEnd: 0.4, drag: 1.5, tint: r.next(),
            });
        }
    }

    // --------------------------------------------------------------- render

    /**
     * Draws all particles. `cameraY` is the (already interpolated) bottom of the view in
     * world units; `alpha` blends each particle between its previous and current position.
     * The caller sets up the logical-space transform.
     */
    render(ctx: CanvasRenderingContext2D, cameraY: number, alpha: number, viewHeight: number): void {
        if (this.active === 0) return;
        const a = Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 1));
        const margin = 90;
        ctx.save();
        ctx.lineCap = 'round';

        // Pass 1: opaque-ish things (smoke, vapor, debris, rotor blades).
        for (let i = 0; i < this.active; i++) {
            const p = this.pool[i] as Particle;
            if (p.kind !== 'smoke' && p.kind !== 'debris' && p.kind !== 'vapor' && p.kind !== 'blade') continue;
            const sx = lerp(p.previousX, p.x, a);
            const sy = viewHeight - (lerp(p.previousY, p.y, a) - cameraY);
            if (sy < -margin || sy > viewHeight + margin) continue;
            const t = p.age / p.life;
            const size = lerp(p.size, p.sizeEnd, t);
            if (p.kind === 'smoke') {
                ctx.globalAlpha = 0.5 * (1 - t) * Math.min(1, t * 8);
                ctx.fillStyle = pick(SMOKE_COLORS, p.tint);
                ctx.beginPath();
                ctx.arc(sx, sy, size, 0, TAU);
                ctx.fill();
            } else if (p.kind === 'vapor') {
                ctx.globalAlpha = 0.34 * (1 - t) * Math.min(1, t * 10);
                ctx.fillStyle = '#eaf4fb';
                ctx.beginPath();
                ctx.arc(sx, sy, size, 0, TAU);
                ctx.fill();
            } else if (p.kind === 'blade') {
                ctx.globalAlpha = Math.min(1, (1 - t) * 1.8);
                ctx.strokeStyle = pick(BLADE_COLORS, p.tint);
                ctx.lineWidth = 1.6;
                ctx.beginPath();
                ctx.moveTo(sx - Math.cos(p.rotation) * size, sy - Math.sin(p.rotation) * size);
                ctx.lineTo(sx + Math.cos(p.rotation) * size, sy + Math.sin(p.rotation) * size);
                ctx.stroke();
            } else {
                ctx.globalAlpha = Math.min(1, (1 - t) * 1.6);
                ctx.fillStyle = pick(DEBRIS_COLORS, p.tint);
                ctx.save();
                ctx.translate(sx, sy);
                ctx.rotate(p.rotation);
                ctx.fillRect(-size / 2, -size / 2, size, size * 0.7);
                ctx.restore();
            }
        }

        // Pass 2: glowing things, additively blended.
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < this.active; i++) {
            const p = this.pool[i] as Particle;
            if (p.kind === 'smoke' || p.kind === 'debris' || p.kind === 'vapor' || p.kind === 'blade') continue;
            const px = lerp(p.previousX, p.x, a);
            const py = viewHeight - (lerp(p.previousY, p.y, a) - cameraY);
            if (py < -margin - 80 || py > viewHeight + margin + 80) continue;
            const t = p.age / p.life;
            const size = lerp(p.size, p.sizeEnd, t);
            switch (p.kind) {
                case 'fire':
                    ctx.globalAlpha = Math.min(1, 1.15 * (1 - t));
                    ctx.fillStyle = rampColor(FIRE_RAMP, t);
                    ctx.beginPath();
                    ctx.arc(px, py, size, 0, TAU);
                    ctx.fill();
                    break;
                case 'exhaust':
                    ctx.globalAlpha = 0.85 * (1 - t);
                    ctx.fillStyle = rampColor(EXHAUST_RAMP, t);
                    ctx.beginPath();
                    ctx.arc(px, py, size, 0, TAU);
                    ctx.fill();
                    break;
                case 'spark': {
                    const tailX = lerp(p.previousX, p.x, a) - p.vx * 0.016;
                    const tailY = viewHeight - (lerp(p.previousY, p.y, a) - p.vy * 0.016 - cameraY);
                    ctx.globalAlpha = 1 - t;
                    ctx.strokeStyle = pick(SPARK_COLORS, p.tint);
                    ctx.lineWidth = Math.max(0.6, size);
                    ctx.beginPath();
                    ctx.moveTo(tailX, tailY);
                    ctx.lineTo(px, py);
                    ctx.stroke();
                    break;
                }
                case 'splash':
                    ctx.globalAlpha = 0.9 * (1 - t);
                    ctx.fillStyle = t < 0.5 ? '#dff6ff' : '#8fd0ee';
                    ctx.beginPath();
                    ctx.arc(px, py, size, 0, TAU);
                    ctx.fill();
                    break;
                case 'shockwave':
                    ctx.globalAlpha = (1 - t) * (1 - t);
                    ctx.strokeStyle = 'rgb(255, 214, 160)';
                    ctx.lineWidth = 1 + 3.5 * (1 - t);
                    ctx.beginPath();
                    ctx.arc(px, py, size, 0, TAU);
                    ctx.stroke();
                    break;
                default:
                    break;
            }
        }
        ctx.restore();
    }
}
