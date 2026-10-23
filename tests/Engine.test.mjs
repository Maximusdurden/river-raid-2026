import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_ENGINE_CONFIG, Engine, computeTargetSpeed } from '../dist/src/core/Engine.js';

const DT = DEFAULT_ENGINE_CONFIG.fixedDeltaTime;

function idle(overrides = {}) {
    return { moveX: 0, moveY: 0, fire: false, firePressed: false, pausePressed: false, activeDevice: 'keyboard', ...overrides };
}

/** Scripted input: `script(frameIndex)` returns a partial InputState. */
function fixture({ script = () => ({}), config, seed = 2026, touchWorld = false } = {}) {
    const frames = { input: 0 };
    const renders = [];
    const worlds = [];
    const input = { update: () => idle(script(frames.input++)) };
    const renderer = {
        setWorld: world => worlds.push(world),
        render: (state, alpha) => {
            renders.push({ ...state, alpha });
            if (touchWorld) {
                // Mimic the real renderer: load every slice that is on screen.
                const world = worlds.at(-1);
                const first = Math.floor(state.cameraY / 8) - 1;
                for (let i = first; i <= first + 94; i++) world.getSlice(i);
            }
        },
    };
    const engine = new Engine({ seed, input, renderer, ...(config ? { config } : {}) });
    return { engine, renders, worlds, frames };
}

test('runs exactly 60 fixed ticks per simulated second at a 60 Hz frame rate', () => {
    const { engine } = fixture();
    for (let i = 0; i < 60; i++) engine.runFrame(DT);
    assert.equal(engine.getStats().tickCount, 60);
});

test('tick count is independent of display refresh rate', () => {
    for (const hz of [30, 60, 75, 120, 144, 240]) {
        const { engine } = fixture();
        const frames = hz * 2; // two simulated seconds
        for (let i = 0; i < frames; i++) engine.runFrame(1 / hz);
        const ticks = engine.getStats().tickCount;
        assert.ok(Math.abs(ticks - 120) <= 1, `${hz} Hz produced ${ticks} ticks`);
    }
});

test('simulation result is identical across refresh rates (same total time)', () => {
    const results = [30, 60, 144, 240].map(hz => {
        const { engine } = fixture();
        for (let i = 0; i < hz * 3; i++) engine.runFrame(1 / hz);
        return engine.getStats().cameraY;
    });
    for (const y of results) assert.ok(Math.abs(y - results[0]) < 220 / 60 * 1.01, `${results}`);
});

test('alpha is the leftover fraction in [0, 1) and renders carry the last two states', () => {
    const { engine, renders } = fixture();
    engine.runFrame(DT * 1.5);
    let r = renders.at(-1);
    assert.ok(Math.abs(r.alpha - 0.5) < 1e-9);
    assert.equal(r.cameraY > r.previousCameraY, true);
    assert.ok(Math.abs(r.cameraY - r.previousCameraY - 220 * DT) < 1e-9);
    engine.runFrame(DT * 0.25); // alpha 0.75: still no new tick
    r = renders.at(-1);
    assert.ok(Math.abs(r.alpha - 0.75) < 1e-9);
    const before = engine.getStats().tickCount;
    engine.runFrame(DT * 0.25); // reaches a full tick
    assert.equal(engine.getStats().tickCount, before + 1);
    for (const render of renders) assert.ok(render.alpha >= 0 && render.alpha < 1);
});

test('high refresh displays render every frame but tick only when due', () => {
    const { engine, renders } = fixture();
    for (let i = 0; i < 240; i++) engine.runFrame(1 / 240);
    assert.equal(renders.length, 240);
    assert.ok(Math.abs(engine.getStats().tickCount - 60) <= 1);
    // Interpolated camera positions must be strictly smooth: never decreasing between frames.
    const cams = renders.map(r => r.previousCameraY + (r.cameraY - r.previousCameraY) * r.alpha);
    for (let i = 1; i < cams.length; i++) assert.ok(cams[i] >= cams[i - 1] - 1e-9, `frame ${i}`);
});

test('interpolated motion advances evenly per frame (no 144 Hz stutter)', () => {
    const { engine, renders } = fixture();
    for (let i = 0; i < 60; i++) engine.runFrame(1 / 144); // warm up past start-up
    renders.length = 0;
    for (let i = 0; i < 288; i++) engine.runFrame(1 / 144);
    const cams = renders.map(r => r.previousCameraY + (r.cameraY - r.previousCameraY) * r.alpha);
    const steps = cams.slice(1).map((c, i) => c - cams[i]);
    const expected = 220 / 144;
    for (const s of steps) assert.ok(Math.abs(s - expected) < expected * 0.05, `step ${s} vs ${expected}`);
});

test('slow frames are clamped and the backlog is dropped (no spiral of death)', () => {
    const { engine } = fixture();
    engine.runFrame(10);
    const stats = engine.getStats();
    assert.ok(stats.tickCount <= DEFAULT_ENGINE_CONFIG.maxStepsPerFrame);
    assert.ok(stats.alpha >= 0 && stats.alpha < 1);
    const { engine: capped } = fixture({ config: { maxStepsPerFrame: 3 } });
    capped.runFrame(0.25);
    assert.equal(capped.getStats().tickCount, 3);
});

test('invalid frame times are ignored safely', () => {
    const { engine } = fixture();
    for (const bad of [NaN, -1, Infinity, undefined, null]) engine.runFrame(bad);
    assert.equal(engine.getStats().tickCount, 0);
    assert.equal(engine.getStats().cameraY, 0);
});

test('throttle maps moveY to scroll speed with acceleration limits', () => {
    const cfg = DEFAULT_ENGINE_CONFIG;
    assert.equal(computeTargetSpeed(0, cfg), cfg.cruiseSpeed);
    assert.equal(computeTargetSpeed(1, cfg), cfg.maxSpeed);
    assert.equal(computeTargetSpeed(-1, cfg), cfg.minSpeed);
    assert.equal(computeTargetSpeed(5, cfg), cfg.maxSpeed);
    assert.equal(computeTargetSpeed(NaN, cfg), cfg.cruiseSpeed);
    assert.equal(computeTargetSpeed(0.5, cfg), cfg.cruiseSpeed + 0.5 * (cfg.maxSpeed - cfg.cruiseSpeed));
    assert.equal(computeTargetSpeed(-0.5, cfg), cfg.cruiseSpeed - 0.5 * (cfg.cruiseSpeed - cfg.minSpeed));

    const { engine } = fixture({ script: () => ({ moveY: 1 }) });
    engine.runFrame(DT);
    assert.ok(Math.abs(engine.getStats().scrollSpeed - (cfg.cruiseSpeed + cfg.acceleration * DT)) < 1e-9);
    for (let i = 0; i < 120; i++) engine.runFrame(DT);
    assert.equal(engine.getStats().scrollSpeed, cfg.maxSpeed);
    assert.equal(engine.getStats().throttle, 1);

    const { engine: brake } = fixture({ script: () => ({ moveY: -1 }) });
    for (let i = 0; i < 120; i++) brake.runFrame(DT);
    assert.equal(brake.getStats().scrollSpeed, cfg.minSpeed);
});

test('camera advances by speed * dt and speed never leaves its limits', () => {
    const { engine } = fixture({ script: i => ({ moveY: Math.sin(i / 7) * 2 }) });
    let last = 0;
    for (let i = 0; i < 600; i++) {
        engine.runFrame(DT);
        const s = engine.getStats();
        assert.ok(s.scrollSpeed >= DEFAULT_ENGINE_CONFIG.minSpeed - 1e-9);
        assert.ok(s.scrollSpeed <= DEFAULT_ENGINE_CONFIG.maxSpeed + 1e-9);
        assert.ok(s.cameraY > last);
        last = s.cameraY;
    }
});

test('pause freezes the simulation, keeps rendering, and resumes seamlessly', () => {
    const { engine, renders } = fixture({ script: i => (i === 10 || i === 20 ? { pausePressed: true } : {}) });
    for (let i = 0; i < 10; i++) engine.runFrame(DT * 1.5);
    const rendersBefore = renders.length;
    engine.runFrame(DT * 1.5); // frame 10: pause pressed
    assert.equal(engine.isPaused, true);
    const frozen = engine.getStats();
    for (let i = 0; i < 9; i++) engine.runFrame(DT * 1.5); // frames 11..19
    assert.equal(engine.getStats().tickCount, frozen.tickCount);
    assert.equal(engine.getStats().cameraY, frozen.cameraY);
    assert.equal(engine.getStats().alpha, frozen.alpha);
    assert.ok(renders.length > rendersBefore + 9); // still drawing
    engine.runFrame(DT * 1.5); // frame 20: resume
    assert.equal(engine.isPaused, false);
    assert.ok(engine.getStats().tickCount > frozen.tickCount);
});

test('firePressed is latched to exactly one tick, even across zero-tick frames', () => {
    const seen = [];
    const { engine } = fixture({ script: i => (i === 1 ? { firePressed: true, fire: true } : {}) });
    engine.onTick(ctx => seen.push(ctx.input.firePressed));
    for (let i = 0; i < 480; i++) engine.runFrame(1 / 240); // press lands on a 0-tick frame at 240 Hz
    assert.equal(seen.filter(Boolean).length, 1);
    assert.ok(seen.length >= 119);

    // A press on a frame that runs several ticks only reaches the first of them.
    const burst = [];
    const { engine: e2 } = fixture({ script: i => (i === 0 ? { firePressed: true } : {}) });
    e2.onTick(ctx => burst.push(ctx.input.firePressed));
    e2.runFrame(DT * 3.2);
    assert.deepEqual(burst, [true, false, false]);
});

test('presses made while paused are discarded', () => {
    const fired = [];
    const { engine } = fixture({
        script: i => (i === 0 ? { pausePressed: true } : i === 1 ? { firePressed: true } : i === 2 ? { pausePressed: true } : {}),
    });
    engine.onTick(ctx => fired.push(ctx.input.firePressed));
    for (let i = 0; i < 10; i++) engine.runFrame(DT);
    assert.equal(fired.some(Boolean), false);
});

test('tick listeners receive context, can unsubscribe, and never see pausePressed', () => {
    const { engine } = fixture({ script: i => (i <= 1 ? { pausePressed: true } : { moveX: 0.5 }) });
    const contexts = [];
    const off = engine.onTick(ctx => contexts.push(ctx));
    for (let i = 0; i < 5; i++) engine.runFrame(DT);
    assert.ok(contexts.length >= 3);
    const c = contexts[0];
    assert.equal(c.deltaTime, DT);
    assert.equal(c.tick, 1);
    assert.equal(c.world, engine.world);
    assert.equal(c.input.pausePressed, false); // frame 1 had pausePressed; ticks never see it
    assert.equal(contexts.at(-1).input.moveX, 0.5);
    const count = contexts.length;
    off();
    engine.runFrame(DT);
    assert.equal(contexts.length, count);
});

test('reset restarts the run deterministically with a new world', () => {
    const { engine, worlds } = fixture({ script: () => ({ moveY: 1 }) });
    for (let i = 0; i < 100; i++) engine.runFrame(DT);
    const first = engine.getStats();
    assert.ok(first.cameraY > 0);
    engine.reset(555);
    assert.equal(worlds.length, 2);
    assert.equal(engine.world.seed, 555);
    assert.equal(engine.getStats().cameraY, 0);
    assert.equal(engine.getStats().tickCount, 0);
    assert.equal(engine.getStats().scrollSpeed, DEFAULT_ENGINE_CONFIG.cruiseSpeed);
    for (let i = 0; i < 100; i++) engine.runFrame(DT);
    assert.equal(engine.getStats().cameraY, first.cameraY);
    engine.reset(2026);
    assert.deepEqual(engine.world.getSlice(40), worlds[0].getSlice(40));
});

test('identical seeds and inputs give identical runs (replayability)', () => {
    const script = i => ({ moveY: Math.sin(i / 13), pausePressed: i === 200 || i === 230 });
    const run = () => {
        const { engine } = fixture({ script, seed: 99 });
        for (let i = 0; i < 400; i++) engine.runFrame(1 / 60);
        return engine.getStats();
    };
    const a = run();
    const b = run();
    assert.equal(a.cameraY, b.cameraY);
    assert.equal(a.scrollSpeed, b.scrollSpeed);
    assert.equal(a.tickCount, b.tickCount);
});

test('world cache is pruned as the camera advances', () => {
    const { engine } = fixture({ script: () => ({ moveY: 1 }), touchWorld: true });
    for (let i = 0; i < 3000; i++) engine.runFrame(DT);
    assert.ok(engine.getStats().cameraY > 20000);
    const cached = engine.world.cachedSliceCount;
    assert.ok(cached > 90 && cached < 200, `${cached} cached`);
});

test('stats report fps, tick rate and device', () => {
    const { engine } = fixture({ script: () => ({ activeDevice: 'gamepad' }) });
    for (let i = 0; i < 240; i++) engine.runFrame(1 / 120);
    const s = engine.getStats();
    assert.ok(Math.abs(s.fps - 120) < 1, `fps ${s.fps}`);
    assert.ok(Math.abs(s.ticksPerSecond - 60) < 3, `tps ${s.ticksPerSecond}`);
    assert.ok(Math.abs(s.frameTimeMs - 1000 / 120) < 0.5);
    assert.equal(s.activeDevice, 'gamepad');
    assert.equal(s.seed, 2026);
    assert.equal(s.playerLineY, s.cameraY + DEFAULT_ENGINE_CONFIG.playerLineOffset);
});

test('start/stop/destroy: headless start throws a helpful error; lifecycle is idempotent', () => {
    const { engine } = fixture();
    assert.throws(() => engine.start(), /requestAnimationFrame/);
    engine.stop();
    engine.stop();
    engine.destroy();
    assert.equal(engine.getStats().running, false);
});

test('start drives frames from requestAnimationFrame with clamped first/long gaps', () => {
    const callbacks = [];
    globalThis.requestAnimationFrame = cb => callbacks.push(cb);
    globalThis.cancelAnimationFrame = () => callbacks.splice(0);
    try {
        const { engine, renders } = fixture();
        engine.start();
        engine.start(); // idempotent
        assert.equal(callbacks.length, 1);
        callbacks.shift()(1000); // first frame: no elapsed time
        assert.equal(engine.getStats().tickCount, 0);
        callbacks.shift()(1017); // 17 ms later: one 16.67 ms tick is due
        assert.equal(engine.getStats().tickCount, 1);
        callbacks.shift()(60000); // a minute-long tab sleep must not fast-forward the sim
        assert.ok(engine.getStats().tickCount <= 1 + DEFAULT_ENGINE_CONFIG.maxStepsPerFrame);
        assert.equal(renders.length, 3);
        engine.stop();
        const pending = callbacks.length;
        assert.equal(pending, 0);
    } finally {
        delete globalThis.requestAnimationFrame;
        delete globalThis.cancelAnimationFrame;
    }
});

test('invalid engine configs are rejected', () => {
    const base = { input: { update: idle }, renderer: { setWorld() {}, render() {} }, seed: 1 };
    for (const config of [
        { fixedDeltaTime: 0 },
        { fixedDeltaTime: NaN },
        { maxFrameTime: 0.001 },
        { maxStepsPerFrame: 0 },
        { maxStepsPerFrame: 1.5 },
        { minSpeed: 300 },
        { maxSpeed: 100 },
        { acceleration: 0 },
        { playerLineOffset: -1 },
    ]) {
        assert.throws(() => new Engine({ ...base, config }), RangeError, JSON.stringify(config));
    }
});
