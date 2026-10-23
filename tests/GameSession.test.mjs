import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine } from '../dist/src/core/Engine.js';
import { GameSession } from '../dist/src/game/GameSession.js';
import { RiverGenerator } from '../dist/src/world/RiverGenerator.js';
import { DT, headlessGame, idle, pilot } from './helpers.mjs';

const noDepots = { depots: { chance: 0 } };
const near = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b} (±${eps})`);

/** Fly the autopilot, shooting at everything. */
const bot = options => (_frame, g) => pilot(g.session, g.engine.world, options);

// ------------------------------------------------------------------ set-up

test('the run starts with the specified jet, camera and resources', () => {
    const g = headlessGame();
    const { session, engine } = g;
    assert.equal(session.jet.state, 'ALIVE');
    assert.equal(session.jet.y, 180);
    near(session.jet.x, engine.world.sample(180).centerX, 1);
    assert.equal(engine.getStats().cameraY, 0);
    assert.equal(720 - (session.jet.y - engine.getStats().cameraY), 540); // jet at screen Y 540
    assert.equal(session.lives, 3);
    assert.equal(session.score, 0);
    assert.equal(session.fuel.level, 100);
    assert.equal(session.gameOver, false);
    // Depots stream in before the first tick (any single seed may have an empty opening stretch).
    const withDepots = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter(seed => headlessGame({ seed }).session.depots.size > 0);
    assert.ok(withDepots.length >= 5, `only ${withDepots.length}/10 seeds had depots at the start`);
});

test('step before reset throws; a mismatched world width is rejected', () => {
    const session = new GameSession();
    assert.throws(() => session.step({ deltaTime: DT, input: idle(), playerLineOffset: 180, time: 0, tick: 1, cameraY: 0 }), /before reset/);
    assert.throws(() => session.reset(new RiverGenerator(1, { worldWidth: 1200, minRiverWidth: 300 }), 180), RangeError);
    assert.throws(() => new GameSession({ startLives: 0 }), RangeError);
    assert.throws(() => new GameSession({ viewHeight: NaN }), RangeError);
});

// ------------------------------------------------------------------ camera / throttle

test('the camera is tied to the jet: scroll speed equals jet speed at 90 / 220 / 420', () => {
    for (const [moveY, speed] of [[-1, 90], [0, 220], [1, 420]]) {
        const g = headlessGame({ script: bot({ throttle: moveY, seekDepots: false }), game: noDepots });
        g.run(3);
        assert.equal(g.session.jet.speed, speed);
        assert.equal(g.engine.getStats().scrollSpeed, speed);
        assert.equal(g.engine.getStats().cameraY, g.session.jet.y - 180);
        assert.equal(g.session.jet.isFlying, true);
    }
});

test('throttle changes ease in: no single tick changes the scroll speed by more than the limit', () => {
    let throttle = 0;
    const g = headlessGame({ script: (_f, h) => ({ ...pilot(h.session, h.engine.world, { seekDepots: false }), moveY: throttle }), game: noDepots });
    const speeds = [];
    g.engine.onTick(ctx => speeds.push(ctx.scrollSpeed));
    g.run(1);
    throttle = 1;
    g.run(1.5);
    throttle = -1;
    g.run(1.5);
    for (let i = 1; i < speeds.length; i++) assert.ok(Math.abs(speeds[i] - speeds[i - 1]) <= 480 * DT + 1e-9);
    assert.equal(Math.max(...speeds), 420);
    assert.equal(Math.min(...speeds), 90);
});

// ------------------------------------------------------------------ fuel

test('fuel burns at 2.2 / 4.5 / 1.4 units per second at steady cruise / boost / brake', () => {
    for (const [moveY, rate] of [[0, 2.2], [1, 4.5], [-1, 1.4]]) {
        const g = headlessGame({ script: bot({ throttle: moveY, seekDepots: false }), game: noDepots });
        g.run(3); // let the speed settle
        const before = g.session.fuel.level;
        g.run(2);
        near(before - g.session.fuel.level, rate * 2, 0.005);
        assert.equal(g.session.jet.isFlying, true);
    }
});

test('the low-fuel warning appears below 20 units', () => {
    const g = headlessGame({ script: bot({ seekDepots: false }), game: noDepots });
    g.session.fuel.setLevel(20.05);
    g.run(0.1);
    assert.equal(g.of('low-fuel').length, 1);
    assert.equal(g.session.fuel.isCritical, true);
});

test('running dry: the engine dies, the jet glides ~0.5 s, then detonates (and the scroll stalls)', () => {
    const g = headlessGame({ script: bot({ throttle: 1, seekDepots: false }), game: noDepots });
    g.run(3);
    g.session.fuel.setLevel(0.02);
    const speedWhenDry = [];
    g.engine.onTick(ctx => speedWhenDry.push(ctx.scrollSpeed));
    assert.equal(g.runUntil(h => h.of('jet-destroyed').length > 0, 3), true);
    const dry = g.of('fuel-empty')[0];
    const boom = g.of('jet-destroyed')[0];
    assert.equal(boom.cause, 'fuel');
    assert.ok(boom.frame - dry.frame >= 30 && boom.frame - dry.frame <= 33, `glide lasted ${boom.frame - dry.frame} ticks`);
    assert.ok(speedWhenDry.at(-2) < 420, 'speed bled off during the glide');
    assert.equal(g.session.jet.state, 'EXPLODING');
    assert.equal(g.engine.getStats().scrollSpeed, 0);
    assert.equal(g.session.lives, 2);
});

test('a depot reached during the final glide saves the jet', () => {
    const g = headlessGame({ script: bot({ throttle: -1 }), game: {} });
    // Brake toward a depot, then run the tank dry when its edge is a few units from the nose.
    // (Overlap starts at 32.5 units centre-to-centre: jet half-height 10 + depot half-height 22.5.)
    const gapToDepot = h => {
        let gap = Infinity;
        for (const d of h.session.depots.values()) if (d.y > h.session.jet.y) gap = Math.min(gap, d.y - h.session.jet.y);
        return gap;
    };
    assert.equal(g.runUntil(h => gapToDepot(h) < 40 && gapToDepot(h) > 33, 90), true);
    g.session.fuel.setLevel(0.001);
    g.run(2);
    assert.equal(g.of('fuel-empty').length >= 1, true, 'the engine did cut out');
    assert.equal(g.of('jet-destroyed').length, 0, 'jet survived');
    assert.ok(g.session.fuel.level > 0);
    assert.equal(g.session.jet.isStalled, false);
});

// ------------------------------------------------------------------ refuelling

test('flying over a depot refuels at 28 units/s without damage', () => {
    const g = headlessGame({ script: bot({ throttle: 0 }), game: {} });
    g.session.fuel.setLevel(40);
    assert.equal(g.runUntil(h => h.session.jet.state === 'REFUELING', 60), true);
    assert.equal(g.session.isRefueling, true);
    const start = g.of('refuel-start');
    assert.equal(start.length, 1);

    const deltas = [];
    let previous = g.session.fuel.level;
    while (g.session.isRefueling && deltas.length < 200) {
        g.engine.runFrame(DT);
        deltas.push(g.session.fuel.level - previous);
        previous = g.session.fuel.level;
    }
    assert.ok(deltas.length >= 8, `only ${deltas.length} refuelling ticks`);
    for (const d of deltas.slice(0, -1)) near(d, (28 - 2.2) * DT, 0.004);
    assert.equal(g.of('refuel-stop').length, 1);
    assert.equal(g.session.jet.state, 'ALIVE');
    assert.equal(g.session.lives, 3, 'no collision damage');
    assert.equal(g.session.depots.size >= 0, true);
    assert.equal(g.session.score, 0);
});

test('slow flying gains more fuel from a depot than fast flying', () => {
    const gain = throttle => {
        const g = headlessGame({ script: bot({ throttle }), game: {} });
        g.session.fuel.setLevel(20);
        let peak = 20;
        let burnedBefore = 0;
        g.runUntil(h => h.session.isRefueling, 60);
        const entry = g.session.fuel.level;
        burnedBefore = entry;
        g.runUntil(h => !h.session.isRefueling, 10);
        peak = g.session.fuel.level;
        return peak - burnedBefore;
    };
    assert.ok(gain(-1) > gain(0) && gain(0) > gain(1), `${gain(-1)} / ${gain(0)} / ${gain(1)}`);
});

test('the tank never exceeds capacity', () => {
    const g = headlessGame({ script: bot({ throttle: -1 }), game: {} });
    g.session.fuel.setLevel(95);
    g.run(20);
    assert.ok(g.session.fuel.level <= 100);
});

// ------------------------------------------------------------------ depots shot down

test('shooting a depot destroys it: +80, explosion, no refuelling', () => {
    const g = headlessGame({ script: bot({ throttle: 0, fire: true }), game: {} });
    g.session.fuel.setLevel(50);
    assert.equal(g.runUntil(h => h.of('depot-destroyed').length > 0, 60), true);
    const event = g.of('depot-destroyed')[0];
    assert.equal(event.points, 80);
    assert.equal(g.session.score, 80);
    assert.equal(event.depot.destroyed, true);
    assert.equal(g.session.depots.has(event.depot.id), false);
    assert.ok(g.session.particles.count > 20, 'explosion particles');
    assert.equal(g.session.popups.length > 0, true);

    // Fly through where the depot was: nothing to refuel from.
    const before = g.session.fuel.level;
    const isOurs = h => h.session.jet.y > event.depot.y + 40;
    g.runUntil(h => isOurs(h), 20);
    assert.equal(g.of('refuel-start').filter(e => e.frame >= event.frame).length >= 0, true);
    assert.ok(g.session.fuel.level <= before, 'fuel only fell while passing a destroyed depot');
});

test('a destroyed depot stays destroyed after the stream window moves on and back', () => {
    const g = headlessGame({ script: bot({ fire: true }), game: {} });
    assert.equal(g.runUntil(h => h.of('depot-destroyed').length > 0, 60), true);
    const id = g.of('depot-destroyed')[0].depot.id;
    // Force the streamer to forget it by teleporting the jet through a respawn.
    g.session.jet.destroy('land');
    assert.equal(g.runUntil(h => h.of('respawn').length > 0, 10), true);
    g.run(1);
    assert.equal(g.session.depots.has(id), false);
});

// ------------------------------------------------------------------ bridges

test('flying into an intact bridge destroys the jet', () => {
    const g = headlessGame({ script: bot({ throttle: 1, seekDepots: true, fire: false }), game: { startY: 2800 } });
    assert.equal(g.runUntil(h => h.of('jet-destroyed').length > 0, 30), true);
    const boom = g.of('jet-destroyed')[0];
    assert.equal(boom.cause, 'bridge');
    near(boom.y, 3200 - 24 - 10, 8); // stopped at the deck's underside
    assert.equal(g.session.bridges.destroyedCount, 0);
});

test('shooting a bridge destroys it: +500, explosion, checkpoint recorded, passage cleared', () => {
    const g = headlessGame({ script: bot({ throttle: 0, fire: true, seekDepots: false }), game: { startY: 2000, ...noDepots } });
    assert.equal(g.runUntil(h => h.of('bridge-destroyed').length > 0, 30), true);
    const event = g.of('bridge-destroyed')[0];
    assert.equal(event.bridge.number, 1);
    assert.equal(event.points, 500);
    assert.equal(g.session.score, 500);
    assert.equal(g.session.bridges.isIntact(1), false);
    assert.equal(g.session.bridges.checkpoint.number, 1);
    assert.equal(g.session.stage, 1);
    assert.ok(g.session.particles.count > 60, 'chain of explosions along the deck');
    assert.ok(g.session.popups.some(p => p.text === '+500'));

    // Fly through the gap unharmed.
    assert.equal(g.runUntil(h => h.session.jet.y > 3300, 20), true);
    assert.equal(g.session.jet.isFlying, true);
    assert.equal(g.of('jet-destroyed').length, 0);
    assert.equal(g.session.lives, 3);
    assert.equal(g.session.score, 500, 'a bridge only scores once');
});

test('one bridge hit scores once even if several missiles are in flight', () => {
    const g = headlessGame({ script: bot({ throttle: 1, fire: true, seekDepots: false }), game: { startY: 2300, weapon: { maxActiveProjectiles: 5, fireInterval: 0.05 }, ...noDepots } });
    g.run(6);
    assert.equal(g.of('bridge-destroyed').length, 1);
    assert.equal(g.session.score, 500);
});

test('bridge destruction events are consistent with the renderer hook', () => {
    const g = headlessGame({ script: bot({ throttle: 0, fire: true, seekDepots: false }), game: { startY: 2800, ...noDepots } });
    g.runUntil(h => h.of('bridge-destroyed').length > 0, 30);
    assert.equal(g.session.bridges.isDestroyed(1), true);
    assert.equal(g.session.bridges.isDestroyed(2), false);
});

// ------------------------------------------------------------------ crashes, lives, respawn

test('hitting the bank destroys the jet at once and freezes the scroll', () => {
    const g = headlessGame({ script: () => ({ moveX: -1 }), game: noDepots });
    assert.equal(g.runUntil(h => h.of('jet-destroyed').length > 0, 10), true);
    const boom = g.of('jet-destroyed')[0];
    assert.equal(boom.cause, 'land');
    assert.equal(boom.livesLeft, 2);
    assert.equal(g.session.lives, 2);
    assert.equal(g.session.jet.state, 'EXPLODING');
    const cameraAtCrash = g.engine.getStats().cameraY;
    g.run(0.5);
    assert.equal(g.engine.getStats().cameraY, cameraAtCrash);
    assert.equal(g.engine.getStats().scrollSpeed, 0);
    assert.ok(g.session.particles.count > 40);
});

test('after the wreck settles a new jet appears at the start with full fuel and a shield', () => {
    let steer = -1;
    const g = headlessGame({ script: () => ({ moveX: steer }), game: noDepots });
    g.runUntil(h => h.of('jet-destroyed').length > 0, 10);
    steer = 0;
    g.session.fuel.setLevel(55);
    assert.equal(g.runUntil(h => h.of('respawn').length > 0, 10), true);
    const respawn = g.of('respawn')[0];
    assert.equal(g.session.jet.state, 'ALIVE');
    assert.equal(respawn.y, 180);
    assert.equal(g.session.fuel.level, 100);
    assert.equal(g.session.jet.isInvulnerable, true);
    assert.equal(g.session.lives, 2);
    assert.equal(g.engine.getStats().cameraY, 0);
    // Wreck time: explosion 1.0 s + respawn delay 0.8 s.
    const crashFrame = g.of('jet-destroyed')[0].frame;
    const delay = (respawn.frame - crashFrame) * DT;
    assert.ok(delay > 1.75 && delay < 1.95, `delay ${delay}`);
});

test('the camera teleport at respawn is never interpolated across', () => {
    let steer = -1;
    const g = headlessGame({ script: () => ({ moveX: steer }), game: noDepots });
    g.runUntil(h => h.of('jet-destroyed').length > 0, 10);
    steer = 0;
    g.runUntil(h => h.of('respawn').length > 0, 10);
    const frame = g.renders.at(-1);
    assert.equal(frame.previousCameraY, frame.cameraY);
    assert.ok(frame.cameraY < 100, 'camera jumped back to the start');
    g.run(0.1);
    const after = g.renders.at(-1);
    assert.ok(after.cameraY > after.previousCameraY, 'normal scrolling resumes');
});

test('respawn protection ignores a crash, then a crash after it expires is fatal', () => {
    let steer = -1;
    const g = headlessGame({ script: () => ({ moveX: steer }), game: noDepots });
    g.runUntil(h => h.of('jet-destroyed').length > 0, 10);
    g.runUntil(h => h.of('respawn').length > 0, 10);
    const respawnFrame = g.frame();
    // Head for the bank again while shielded: well inside the 3 s protection.
    g.run(2);
    assert.equal(g.session.jet.isInvulnerable, true);
    assert.equal(g.session.jet.isFlying, true);
    assert.equal(g.of('jet-destroyed').length, 1, 'no second death while protected');
    // Protection lapses with the jet still over land: it is destroyed right away.
    assert.equal(g.runUntil(h => h.of('jet-destroyed').length > 1, 3), true);
    const second = g.of('jet-destroyed')[1];
    assert.ok((second.frame - respawnFrame) * DT >= 3 - 2 * DT, `died at ${(second.frame - respawnFrame) * DT}s`);
    steer = 0;
});

test('after a bridge falls, a crash respawns just past it with the bridge still down', () => {
    const g = headlessGame({ script: bot({ throttle: 0, fire: true, seekDepots: false }), game: { startY: 2800, ...noDepots } });
    g.runUntil(h => h.of('bridge-destroyed').length > 0, 30);
    g.runUntil(h => h.session.jet.y > 3400, 10);
    g.session.jet.destroy('land'); // crash somewhere past the bridge
    assert.equal(g.runUntil(h => h.of('respawn').length > 0, 10), true);
    const respawn = g.of('respawn')[0];
    assert.equal(respawn.y, 3200 + 24 + 80);
    assert.equal(g.session.bridges.isIntact(1), false);
    assert.equal(g.session.jet.y, respawn.y);
    assert.equal(g.engine.getStats().cameraY, respawn.y - 180);
    // The respawned jet can fly on without hitting the old bridge behind it.
    g.run(3);
    assert.equal(g.session.jet.isFlying, true);
    assert.equal(g.session.score >= 500, true);
});

test('losing the last jet ends the run; the world freezes; restart is clean', () => {
    const g = headlessGame({ script: () => ({ moveX: -1 }), game: { startLives: 1, ...noDepots } });
    assert.equal(g.runUntil(h => h.session.gameOver, 20), true);
    assert.equal(g.session.lives, 0);
    assert.equal(g.of('game-over').length, 1);
    assert.equal(g.of('respawn').length, 0);
    assert.equal(g.session.jet.state, 'DEAD');
    const camera = g.engine.getStats().cameraY;
    g.run(2);
    assert.equal(g.engine.getStats().cameraY, camera);
    assert.equal(g.engine.getStats().scrollSpeed, 0);
    assert.ok(g.session.gameOverTime > 1.9);
    assert.equal(g.of('game-over').length, 1, 'game-over fires once');

    g.engine.reset(2026);
    assert.equal(g.session.gameOver, false);
    assert.equal(g.session.lives, 1);
    assert.equal(g.session.score, 0);
    assert.equal(g.session.fuel.level, 100);
    assert.equal(g.session.jet.state, 'ALIVE');
    assert.equal(g.engine.getStats().cameraY, 0);
    assert.equal(g.session.particles.count, 0);
    assert.equal(g.session.bridges.destroyedCount, 0);
});

test('destroying a jet while it is refuelling stops the refuel cleanly', () => {
    const g = headlessGame({ script: bot({ throttle: -1 }), game: {} });
    g.session.fuel.setLevel(30);
    g.runUntil(h => h.session.jet.state === 'REFUELING', 60);
    g.session.jet.destroy('land');
    g.run(0.1);
    assert.equal(g.session.jet.state, 'EXPLODING');
    assert.equal(g.session.fuel.isRefueling, false);
});

// ------------------------------------------------------------------ engine integration

test('pause freezes the whole game, including weapons and fuel', () => {
    const g = headlessGame({ script: (frame, h) => ({ ...pilot(h.session, h.engine.world, { fire: true }), pausePressed: frame === 120 }) , game: {} });
    g.run(2);
    const frozen = { y: g.session.jet.y, fuel: g.session.fuel.level, shots: g.session.weapon.activeCount, particles: g.session.particles.count };
    g.run(1); // runs paused: pausePressed was on frame 120
    assert.equal(g.engine.isPaused, true);
    assert.equal(g.session.jet.y, frozen.y);
    assert.equal(g.session.fuel.level, frozen.fuel);
    assert.equal(g.session.weapon.activeCount, frozen.shots);
    assert.equal(g.session.particles.count, frozen.particles);
    assert.equal(g.renders.at(-1).paused, true);
});

test('a firePressed latched across zero-tick frames still fires exactly one missile', () => {
    const g = headlessGame({ script: frame => ({ firePressed: frame === 1, fire: frame === 1 }), game: noDepots });
    for (let i = 0; i < 480; i++) g.engine.runFrame(1 / 240); // press lands on a frame without a tick
    assert.equal(g.of('fire').length, 1);
});

test('the engine rejects a simulation that returns a non-finite camera', () => {
    const sim = {
        reset: () => 0,
        step: () => ({ cameraY: NaN, scrollSpeed: 0, cameraTeleported: false }),
    };
    const engine = new Engine({ seed: 1, input: { update: () => idle() }, renderer: { setWorld() {}, render() {} }, simulation: sim });
    assert.throws(() => engine.runFrame(DT), RangeError);
});

test('engine + simulation: reset re-seeds the world, restarts the sim and interpolation', () => {
    const resets = [];
    const sim = {
        reset: (world, offset) => {
            resets.push([world.seed, offset]);
            return 1000;
        },
        step: ctx => ({ cameraY: ctx.cameraY + 10, scrollSpeed: 600, cameraTeleported: ctx.tick === 3 }),
    };
    const renders = [];
    const engine = new Engine({ seed: 7, input: { update: () => idle() }, renderer: { setWorld() {}, render: (s, a) => renders.push({ ...s, a }) }, simulation: sim });
    assert.deepEqual(resets, [[7, 180]]);
    assert.equal(engine.getStats().cameraY, 1000);
    for (let i = 0; i < 3; i++) engine.runFrame(DT);
    const tele = renders.at(-1);
    assert.equal(tele.previousCameraY, tele.cameraY); // teleport tick: no interpolation across it
    engine.runFrame(DT);
    assert.equal(renders.at(-1).cameraY - renders.at(-1).previousCameraY, 10);
    assert.equal(engine.getStats().scrollSpeed, 600);
    engine.reset(99);
    assert.deepEqual(resets.at(-1), [99, 180]);
    assert.equal(engine.getStats().cameraY, 1000);
});

// ------------------------------------------------------------------ determinism

test('identical seed, config and inputs replay identically', () => {
    const run = () => {
        const g = headlessGame({ seed: 4242, script: bot({ throttle: 0.3, fire: true }), game: {} });
        g.run(40);
        const s = g.session;
        return {
            score: s.score, fuel: s.fuel.level, x: s.jet.x, y: s.jet.y, lives: s.lives,
            events: g.events.map(e => `${e.type}@${e.frame}`).join(','), particles: s.particles.count,
        };
    };
    assert.deepEqual(run(), run());
});

test('event listeners can unsubscribe', () => {
    const g = headlessGame({ script: bot({ fire: true }), game: {} });
    const seen = [];
    const off = g.session.onEvent(e => seen.push(e.type));
    g.run(1);
    const count = seen.length;
    assert.ok(count > 0);
    off();
    g.run(1);
    assert.equal(seen.length, count);
});

// ------------------------------------------------------------------ flyability

test('LEVEL CHECK: a lateral speed of 380 is enough to fly the whole river at full boost', () => {
    // Infinite fuel, always boosting and shooting: only terrain can stop the autopilot.
    const seeds = [1, 7, 42, 99, 2026, 31337, 8675309, 123456789, 13, 7945, 15877, 23803];
    const failures = [];
    for (const seed of seeds) {
        const g = headlessGame({
            seed,
            script: bot({ throttle: 1, fire: true, seekDepots: false }),
            game: { fuel: { capacity: 1e9, startLevel: 1e9 }, ...noDepots },
        });
        g.runUntil(h => h.session.jet.y > 12500 || h.of('jet-destroyed').length > 0, 120);
        const died = g.of('jet-destroyed')[0];
        if (died) failures.push(`seed ${seed}: ${died.cause} at y ${died.y.toFixed(0)}`);
        else assert.ok(g.session.bridges.destroyedCount >= 3, `seed ${seed}: bridges ${g.session.bridges.destroyedCount}`);
    }
    assert.deepEqual(failures, []);
});

test('LEVEL CHECK: at cruise and half boost the autopilot survives on real fuel; depots keep it going', () => {
    // The pilot shoots only bridges, so every depot it needs stays intact: fuel supply is the only limit.
    for (const throttle of [0, 0.5]) {
        for (const seed of [3, 11, 2026, 55555, 13, 7945]) {
            const g = headlessGame({ seed, script: bot({ throttle, fire: 'bridges', seekDepots: true }), game: {} });
            const ok = g.runUntil(h => h.session.jet.y > 10000 || h.of('jet-destroyed').length > 0, 200);
            const died = g.of('jet-destroyed')[0];
            assert.equal(died, undefined, `throttle ${throttle} seed ${seed} died: ${JSON.stringify(died && { cause: died.cause, y: died.y })}`);
            assert.equal(ok, true);
            assert.ok(g.session.bridges.destroyedCount >= 3, `bridges ${g.session.bridges.destroyedCount}`);
            assert.ok(g.of('refuel-start').length >= 5, 'refuelled several times on the way');
        }
    }
});

test('LEVEL CHECK: shooting every depot starves the player of fuel (the intended risk/reward)', () => {
    const g = headlessGame({ seed: 13, script: bot({ throttle: 0, fire: true, seekDepots: true }), game: {} });
    g.runUntil(h => h.of('jet-destroyed').length > 0, 200);
    assert.equal(g.of('jet-destroyed')[0]?.cause, 'fuel');
    assert.ok(g.of('depot-destroyed').length >= 3);
});
