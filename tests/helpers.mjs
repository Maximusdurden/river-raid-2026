import { Engine } from '../dist/src/core/Engine.js';
import { Enemy } from '../dist/src/entities/enemies/Enemy.js';
import { GameSession } from '../dist/src/game/GameSession.js';

export const DT = 1 / 60;

export function idle(overrides = {}) {
    return { moveX: 0, moveY: 0, fire: false, firePressed: false, pausePressed: false, activeDevice: 'keyboard', ...overrides };
}

export function bridgeSpan(number, centerY, half = 24) {
    return { number, centerY, bottomY: centerY - half, topY: centerY + half };
}

/** A scripted world for collision tests: arbitrary land shape, explicit bridges. */
export class FakeWorld {
    constructor({ land = () => false, bridges = [], sliceHeight = 8 } = {}) {
        this.config = { sliceHeight };
        this.landFn = land;
        this.bridgeList = bridges;
    }

    isLand(x, y) {
        return this.landFn(x, y);
    }

    findBridges(minY, maxY) {
        return this.bridgeList.filter(b => b.topY >= minY && b.bottomY <= maxY);
    }
}

const at = (value, y) => (typeof value === 'function' ? value(y) : value);

/**
 * A hand-built river for enemy and collision tests. `left` / `right` are bank positions
 * (numbers, or functions of Y for slanted banks); `island` is an optional [x0, x1] that
 * splits the river in two.
 */
export class FakeRiver {
    constructor({ left = 200, right = 760, island = null, worldWidth = 960, bridges = [], sliceHeight = 8 } = {}) {
        this.left = left;
        this.right = right;
        this.island = island;
        this.config = { worldWidth, sliceHeight };
        this.bridgeList = bridges;
    }

    getChannels(y) {
        const l = at(this.left, y);
        const r = at(this.right, y);
        return this.island
            ? [{ leftX: l, rightX: this.island[0] }, { leftX: this.island[1], rightX: r }]
            : [{ leftX: l, rightX: r }];
    }

    sample(y) {
        return { leftBankX: at(this.left, y), rightBankX: at(this.right, y) };
    }

    isLand(x, y) {
        if (x < at(this.left, y) || x > at(this.right, y)) return true;
        return this.island !== null && x >= this.island[0] && x <= this.island[1];
    }

    findBridges(minY, maxY) {
        return this.bridgeList.filter(b => b.topY >= minY && b.bottomY <= maxY);
    }
}

/** An enemy that never moves by itself, for aiming missiles and staging collisions. */
export class StaticEnemy extends Enemy {
    kind;
    flies;
    constructor(id, x, y, { kind = 'helicopter', width = 24, height = 18, points = 60, flies = false } = {}) {
        super(id, x, y, width, height, points);
        this.kind = kind;
        this.flies = flies;
    }

    step() {}
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const CORRIDOR_SAMPLES = [0, 25, 50, 80, 110, 145, 185, 230, 290, 360, 440];
// Jet half-width 14 + half-height 10 on a ~1.0 bank slope, plus clearance.
const PILOT_MARGIN = 32;

/**
 * A simple autopilot, used to prove the levels are actually flyable. It plans a
 * corridor ahead the way a player reads the screen: at each lookahead sample it keeps
 * following the channel that continues the previous one, preferring the side of an
 * island the jet is already on, then steers to that channel's middle a speed-dependent
 * distance ahead. Depots are only chased once they are close (a long diagonal dash
 * across a curving river is how a human would crash, too).
 */
export function pilot(session, world, { throttle = 0, fire = false, seekDepots = true, gain = 1 / 50 } = {}) {
    const jet = session.jet;
    const corridor = [];
    let current = null;
    for (const d of CORRIDOR_SAMPLES) {
        let best = null;
        let bestScore = -Infinity;
        for (const c of world.getChannels(jet.y + d)) {
            const mid = (c.leftX + c.rightX) / 2;
            const gapFromJet = Math.max(c.leftX - jet.x, jet.x - c.rightX, 0);
            let score = -3 * gapFromJet - 0.02 * Math.abs(mid - jet.x);
            if (current) {
                const overlap = Math.min(c.rightX, current.rightX) - Math.max(c.leftX, current.leftX);
                score += (overlap > 0 ? 1000 : 0) + 0.05 * overlap;
            }
            if (score > bestScore) {
                bestScore = score;
                best = c;
            }
        }
        if (!best) break;
        current = best;
        corridor.push({ d, channel: best });
    }
    const lookahead = 60 + jet.speed * 0.3;
    const aim = corridor.find(s => s.d >= lookahead) ?? corridor.at(-1);
    let targetX = aim ? (aim.channel.leftX + aim.channel.rightX) / 2 : jet.x;

    // Never cut across an island or bank that is still in the way: stay inside every
    // channel between here and the aim point, even if the river merges beyond it.
    let lo = -Infinity;
    let hi = Infinity;
    for (const s of corridor) {
        if (aim && s.d > aim.d) break;
        lo = Math.max(lo, s.channel.leftX + PILOT_MARGIN);
        hi = Math.min(hi, s.channel.rightX - PILOT_MARGIN);
    }
    if (lo <= hi) targetX = clamp(targetX, lo, hi);

    if (seekDepots) {
        let depot = null;
        for (const dep of session.depots.values()) {
            if (dep.destroyed || dep.y < jet.y - 25 || dep.y > jet.y + lookahead + 90) continue;
            const at = corridor.find(s => s.d >= dep.y - jet.y) ?? corridor.at(-1);
            if (!at || dep.x < at.channel.leftX || dep.x > at.channel.rightX) continue; // not on our side of an island
            if (!depot || dep.y < depot.y) depot = dep;
        }
        if (depot) targetX = lo <= hi ? clamp(depot.x, lo, hi) : depot.x;
    }
    // fire: true = always; false = never; 'bridges' = only when a bridge is ahead and no depot is in the line of fire.
    let shoot = fire === true;
    if (fire === 'bridges') {
        const bridge = world.findBridges(jet.y, jet.y + 600).find(b => session.bridges.isIntact(b.number));
        if (bridge) {
            shoot = ![...session.depots.values()].some(d => !d.destroyed && d.y > jet.y && d.y < bridge.bottomY && Math.abs(d.x - jet.x) < 26);
        }
    }
    return { moveX: clamp((targetX - jet.x) * gain, -1, 1), moveY: throttle, fire: shoot };
}

/**
 * Headless engine + session. `script(frame, game)` returns a partial InputState each
 * frame. One `engine.runFrame(DT)` is exactly one fixed tick.
 */
export function headlessGame({ seed = 2026, script = () => ({}), game = {}, engineConfig, simulation } = {}) {
    const renders = [];
    const events = [];
    let frame = 0;
    // Enemies are off unless a test opts in with `game: { enemies: { ... } }`, so the earlier
    // phases' scenarios (and their autopilot) stay about terrain, fuel and bridges.
    const session = simulation ?? new GameSession({ enemies: { enabled: false }, ...game });
    const handle = { engine: null, session, renders, events, frame: () => frame };
    const input = { update: () => idle(script(frame++, handle)) };
    const renderer = {
        setWorld() {},
        render: (state, alpha) => renders.push({ ...state, alpha }),
    };
    const engine = new Engine({ seed, input, renderer, simulation: session, ...(engineConfig ? { config: engineConfig } : {}) });
    handle.engine = engine;
    session.onEvent(event => events.push({ ...event, frame: frame - 1 }));
    handle.run = seconds => {
        for (let i = 0, n = Math.round(seconds * 60); i < n; i++) engine.runFrame(DT);
    };
    handle.runUntil = (predicate, maxSeconds = 120) => {
        for (let i = 0, n = Math.round(maxSeconds * 60); i < n; i++) {
            if (predicate(handle)) return true;
            engine.runFrame(DT);
        }
        return predicate(handle);
    };
    handle.of = type => events.filter(e => e.type === type);
    return handle;
}
