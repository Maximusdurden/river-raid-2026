import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    DEFAULT_AUDIO_CHANNELS, SoundEngine, loadAudioSettings, sanitizeAudioSettings, serializeAudioSettings,
} from '../dist/src/audio/SoundEngine.js';

// ---------------------------------------------------------------- fake Web Audio

class FakeParam {
    constructor(value = 0) { this.value = value; this.calls = []; }
    setValueAtTime(v, t) { this.calls.push(['set', v, t]); this.value = v; return this; }
    linearRampToValueAtTime(v, t) { this.calls.push(['linear', v, t]); return this; }
    exponentialRampToValueAtTime(v, t) { this.calls.push(['exp', v, t]); return this; }
    setTargetAtTime(v, t, k) { this.calls.push(['target', v, t, k]); this.value = v; return this; }
}

class FakeNode {
    constructor(ctx, kind) { this.ctx = ctx; this.kind = kind; this.connections = []; ctx.nodes.push(this); }
    connect(target) { this.connections.push(target); return target; }
    disconnect() {}
}

class FakeContext {
    constructor() {
        this.state = 'suspended';
        this.currentTime = 0;
        this.sampleRate = 8000;
        this.destination = { kind: 'destination' };
        this.nodes = [];
    }
    createGain() { const n = new FakeNode(this, 'gain'); n.gain = new FakeParam(1); return n; }
    createOscillator() {
        const n = new FakeNode(this, 'oscillator');
        n.type = 'sine'; n.frequency = new FakeParam(440); n.detune = new FakeParam(0);
        n.start = () => {}; n.stop = () => {};
        return n;
    }
    createBiquadFilter() { const n = new FakeNode(this, 'filter'); n.type = 'lowpass'; n.frequency = new FakeParam(350); n.Q = new FakeParam(1); return n; }
    createDynamicsCompressor() {
        const n = new FakeNode(this, 'compressor');
        for (const p of ['threshold', 'knee', 'ratio', 'attack', 'release']) n[p] = new FakeParam();
        return n;
    }
    createBufferSource() { const n = new FakeNode(this, 'source'); n.starts = []; n.start = (...a) => n.starts.push(a); n.stop = () => {}; return n; }
    createBuffer(c, length, rate) { const data = new Float32Array(length); return { length, sampleRate: rate, getChannelData: () => data }; }
    async resume() { this.state = 'running'; }
    async suspend() { this.state = 'suspended'; }
    async close() { this.state = 'closed'; }
}

class MemoryStorage {
    constructor(initial = {}) { this.data = new Map(Object.entries(initial)); this.failReads = false; this.failWrites = false; }
    getItem(key) { if (this.failReads) throw new Error('SecurityError'); return this.data.has(key) ? this.data.get(key) : null; }
    setItem(key, value) { if (this.failWrites) throw new Error('Quota'); this.data.set(key, String(value)); }
    removeItem(key) { this.data.delete(key); }
}
const KEY = 'riverraid.audio_settings';

async function running(options = {}) {
    const contexts = [];
    const engine = new SoundEngine({
        createContext: () => { const c = new FakeContext(); contexts.push(c); return c; },
        storage: options.storage ?? new MemoryStorage(),
        ...options.engine,
    });
    if (options.unlock !== false) await engine.unlock();
    const ctx = contexts[0];
    // Resolve the graph: the compressor's inputs are the three buses; the master is its output.
    const graph = ctx ? (() => {
        const compressor = ctx.nodes.find(n => n.kind === 'compressor');
        const buses = ctx.nodes.filter(n => n.kind === 'gain' && n.connections.includes(compressor));
        const master = compressor.connections[0];
        // Creation order in build(): master, sfx, drone, warning.
        const [sfx, drone, warning] = buses;
        return { compressor, master, sfx, drone, warning };
    })() : null;
    return { engine, ctx, graph, storage: options.storage };
}

const base = { throttle: 0.5, engineOn: true, refueling: false, lowFuel: false, paused: false };
/** The most recent target a gain was told to fade to. */
const target = gain => gain.gain.calls.filter(c => c[0] === 'target').at(-1)?.[1] ?? gain.gain.value;
const oscillators = ctx => ctx.nodes.filter(n => n.kind === 'oscillator');
const klaxon = ctx => oscillators(ctx).filter(o => o.type === 'square' && [740, 988].includes(o.frequency.calls.find(c => c[0] === 'set')?.[1]));

// ---------------------------------------------------------------- the settings model

test('the default configuration is the specified shape and values', () => {
    assert.deepEqual({ ...DEFAULT_AUDIO_CHANNELS }, {
        masterVolume: 0.6, muted: false, sfxEnabled: true, droneEnabled: true, warningsEnabled: true,
    });
    const engine = new SoundEngine({ storage: null });
    assert.deepEqual(engine.channels, { ...DEFAULT_AUDIO_CHANNELS });
    assert.deepEqual([engine.sfxEnabled, engine.droneEnabled, engine.warningsEnabled], [true, true, true]);
});

test('sanitising keeps valid fields, repairs bad ones and never throws', () => {
    assert.deepEqual(sanitizeAudioSettings({ masterVolume: 0.25, muted: true, sfxEnabled: false, droneEnabled: false, warningsEnabled: false }), {
        masterVolume: 0.25, muted: true, sfxEnabled: false, droneEnabled: false, warningsEnabled: false,
    });
    assert.equal(sanitizeAudioSettings({ masterVolume: 9 }).masterVolume, 1);
    assert.equal(sanitizeAudioSettings({ masterVolume: -2 }).masterVolume, 0);
    for (const bad of [NaN, Infinity, '0.5', null, {}, [], true]) {
        assert.equal(sanitizeAudioSettings({ masterVolume: bad }).masterVolume, 0.6, String(bad));
    }
    for (const bad of ['true', 1, 0, null, [], {}]) {
        assert.equal(sanitizeAudioSettings({ sfxEnabled: bad }).sfxEnabled, true, `sfx ${String(bad)}`);
        assert.equal(sanitizeAudioSettings({ muted: bad }).muted, false, `muted ${String(bad)}`);
    }
    for (const junk of [null, undefined, 5, 'x', [], true]) assert.deepEqual(sanitizeAudioSettings(junk), { ...DEFAULT_AUDIO_CHANNELS });
    assert.deepEqual(sanitizeAudioSettings({ droneEnabled: false }, { ...DEFAULT_AUDIO_CHANNELS, masterVolume: 0.9 }).masterVolume, 0.9, 'a base supplies the fallbacks');
});

test('settings round-trip through JSON', () => {
    const config = { masterVolume: 0.35, muted: true, sfxEnabled: false, droneEnabled: true, warningsEnabled: false };
    const storage = new MemoryStorage({ [KEY]: serializeAudioSettings(config) });
    assert.deepEqual(loadAudioSettings(storage), config);
    assert.deepEqual(Object.keys(JSON.parse(serializeAudioSettings(config))).sort(),
        ['droneEnabled', 'masterVolume', 'muted', 'sfxEnabled', 'warningsEnabled']);
});

test('missing, corrupt or unreadable saved settings give the defaults', () => {
    for (const bad of [null, 'not json', '{', '[]', 'null', '5', '"x"']) {
        const stored = bad === null ? new MemoryStorage() : new MemoryStorage({ [KEY]: bad });
        assert.deepEqual(loadAudioSettings(stored), { ...DEFAULT_AUDIO_CHANNELS }, String(bad));
    }
    const broken = new MemoryStorage();
    broken.failReads = true;
    assert.deepEqual(loadAudioSettings(broken), { ...DEFAULT_AUDIO_CHANNELS });
    assert.deepEqual(loadAudioSettings(null), { ...DEFAULT_AUDIO_CHANNELS });
});

test('Phase 4\u2019s separate volume and mute keys are carried over once, and new settings win', () => {
    const old = new MemoryStorage({ 'riverraid.volume': '0.3', 'riverraid.muted': '1' });
    assert.deepEqual(loadAudioSettings(old), { ...DEFAULT_AUDIO_CHANNELS, masterVolume: 0.3, muted: true });
    const onlyMuted = new MemoryStorage({ 'riverraid.muted': '0' });
    assert.deepEqual(loadAudioSettings(onlyMuted), { ...DEFAULT_AUDIO_CHANNELS });
    const both = new MemoryStorage({ 'riverraid.volume': '0.3', 'riverraid.muted': '1', [KEY]: serializeAudioSettings({ ...DEFAULT_AUDIO_CHANNELS, masterVolume: 0.8 }) });
    assert.equal(loadAudioSettings(both).masterVolume, 0.8);
    assert.equal(loadAudioSettings(both).muted, false);
    assert.equal(loadAudioSettings(new MemoryStorage({ 'riverraid.volume': 'loud' })).masterVolume, 0.6, 'junk legacy volume');
});

test('explicit constructor options override saved settings', () => {
    const storage = new MemoryStorage({ [KEY]: serializeAudioSettings({ ...DEFAULT_AUDIO_CHANNELS, masterVolume: 0.2, sfxEnabled: false }) });
    const engine = new SoundEngine({ storage, masterVolume: 0.9, muted: true, channels: { droneEnabled: false } });
    assert.deepEqual(engine.channels, { masterVolume: 0.9, muted: true, sfxEnabled: false, droneEnabled: false, warningsEnabled: true });
});

// ------------------------------------------------------------------ persistence

test('every change is saved to riverraid.audio_settings', () => {
    const storage = new MemoryStorage();
    const engine = new SoundEngine({ storage });
    assert.equal(storage.data.has(KEY), false, 'nothing is written just for starting up');
    engine.setSfxEnabled(false);
    assert.equal(JSON.parse(storage.data.get(KEY)).sfxEnabled, false);
    engine.setDroneEnabled(false);
    engine.setWarningsEnabled(false);
    engine.setMasterVolume(0.4);
    engine.setMuted(true);
    assert.deepEqual(JSON.parse(storage.data.get(KEY)), {
        masterVolume: 0.4, muted: true, sfxEnabled: false, droneEnabled: false, warningsEnabled: false,
    });
});

test('a new engine restores what the last one saved', () => {
    const storage = new MemoryStorage();
    const first = new SoundEngine({ storage });
    first.setSfxEnabled(false);
    first.setMasterVolume(0.15);
    first.setWarningsEnabled(false);
    const second = new SoundEngine({ storage });
    assert.deepEqual(second.channels, { masterVolume: 0.15, muted: false, sfxEnabled: false, droneEnabled: true, warningsEnabled: false });
});

test('setting a switch to its current value changes and saves nothing', () => {
    const storage = new MemoryStorage();
    const engine = new SoundEngine({ storage });
    const seen = [];
    engine.subscribe(config => seen.push(config));
    engine.setSfxEnabled(true);
    engine.setDroneEnabled(true);
    engine.setWarningsEnabled(true);
    engine.setMuted(false);
    engine.setMasterVolume(0.6);
    assert.equal(seen.length, 0);
    assert.equal(storage.data.has(KEY), false);
});

test('failing storage never breaks a toggle', () => {
    const storage = new MemoryStorage();
    storage.failWrites = true;
    storage.failReads = true;
    const engine = new SoundEngine({ storage });
    assert.doesNotThrow(() => {
        engine.setSfxEnabled(false);
        engine.setMuted(true);
    });
    assert.equal(engine.sfxEnabled, false);
    assert.equal(engine.muted, true);
});

test('subscribers hear every change with a fresh snapshot, and can unsubscribe', () => {
    const engine = new SoundEngine({ storage: null });
    const seen = [];
    const off = engine.subscribe(config => seen.push(config));
    engine.setDroneEnabled(false);
    engine.setMasterVolume(0.1);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].droneEnabled, false);
    assert.equal(seen[1].masterVolume, 0.1);
    seen[0].droneEnabled = true;
    assert.equal(engine.droneEnabled, false, 'a snapshot cannot change the engine');
    off();
    engine.setSfxEnabled(false);
    assert.equal(seen.length, 2);
});

// ------------------------------------------------------------------- routing

test('three buses feed one compressor, which feeds the master volume, which feeds the speakers', async () => {
    const { ctx, graph } = await running();
    assert.equal(ctx.nodes.filter(n => n.kind === 'compressor').length, 1);
    assert.equal(ctx.nodes.filter(n => n.kind === 'gain' && n.connections.includes(graph.compressor)).length, 3);
    assert.deepEqual(graph.compressor.connections, [graph.master]);
    assert.deepEqual(graph.master.connections, [ctx.destination]);
});

test('the drone is wired to its own bus, and the klaxon and effects to theirs', async () => {
    const { engine, ctx, graph } = await running();
    engine.syncGame({ ...base, lowFuel: true });
    ctx.currentTime = 1;
    engine.syncGame({ ...base, lowFuel: true });
    engine.play('fire');
    const reaches = (node, bus) => {
        const seen = new Set();
        const walk = n => {
            if (n === bus) return true;
            if (seen.has(n)) return false;
            seen.add(n);
            return (n.connections ?? []).some(walk);
        };
        return walk(node);
    };
    const saw = oscillators(ctx).find(o => o.type === 'sawtooth' && o.connections.length > 0 && o.frequency.calls.length === 0 || o.type === 'sawtooth');
    assert.ok(reaches(saw, graph.drone), 'the engine saw reaches the drone bus');
    assert.ok(!reaches(saw, graph.sfx) && !reaches(saw, graph.warning));
    const alarm = klaxon(ctx)[0];
    assert.ok(alarm, 'a klaxon note was scheduled');
    assert.ok(reaches(alarm, graph.warning) && !reaches(alarm, graph.sfx) && !reaches(alarm, graph.drone));
    const shot = oscillators(ctx).find(o => o.type === 'square' && o.frequency.calls.find(c => c[0] === 'set')?.[1] === 1150);
    assert.ok(shot, 'the missile chirp exists');
    assert.ok(reaches(shot, graph.sfx) && !reaches(shot, graph.warning) && !reaches(shot, graph.drone));
});

test('buses start at the saved switch positions', async () => {
    const { graph } = await running({ engine: { channels: { sfxEnabled: false, warningsEnabled: false } } });
    assert.equal(graph.sfx.gain.value, 0);
    assert.equal(graph.warning.gain.value, 0);
    assert.equal(graph.drone.gain.value, 1);
});

// ---------------------------------------------------------- channel filtering

test('drone off: the drone bus fades to silence at once, and back on again', async () => {
    const { engine, ctx, graph } = await running();
    engine.syncGame(base);
    assert.ok(target(graph.drone) === 1);
    ctx.currentTime = 2;
    engine.setDroneEnabled(false);
    const fade = graph.drone.gain.calls.at(-1);
    assert.deepEqual(fade.slice(0, 2), ['target', 0]);
    assert.equal(fade[2], 2, 'starts now');
    assert.ok(fade[3] <= 0.05, `time constant ${fade[3]} s: effectively instant`);
    assert.equal(target(graph.sfx) > 0, true, 'effects are unaffected');
    assert.equal(target(graph.warning), 1, 'and so are the warnings');
    engine.setDroneEnabled(true);
    assert.equal(target(graph.drone), 1);
});

test('drone off while the engine keeps running: the oscillators are still driven, only the bus is shut', async () => {
    const { engine, graph } = await running();
    engine.setDroneEnabled(false);
    engine.syncGame({ ...base, throttle: 1 });
    assert.equal(target(graph.drone), 0);
    engine.setDroneEnabled(true);
    assert.equal(target(graph.drone), 1, 'turning it back on is instant: the drone is already at the right pitch');
});

test('warnings off: the klaxon is never scheduled, and its bus is silent', async () => {
    const { engine, ctx, graph } = await running({ engine: { channels: { warningsEnabled: false } } });
    for (let frame = 0; frame < 120; frame++) {
        ctx.currentTime = frame / 60;
        engine.syncGame({ ...base, lowFuel: true });
    }
    assert.equal(klaxon(ctx).length, 0);
    assert.equal(target(graph.warning), 0);
});

test('turning warnings off mid-alarm stops it; turning them on restarts it from the first note', async () => {
    const { engine, ctx, graph } = await running();
    ctx.currentTime = 1;
    engine.syncGame({ ...base, lowFuel: true });
    const before = klaxon(ctx).length;
    assert.ok(before > 0, 'the alarm is sounding');
    engine.setWarningsEnabled(false);
    assert.equal(target(graph.warning), 0);
    ctx.currentTime = 2;
    engine.syncGame({ ...base, lowFuel: true });
    assert.equal(klaxon(ctx).length, before, 'nothing new is scheduled while off');
    engine.setWarningsEnabled(true);
    ctx.currentTime = 3;
    engine.syncGame({ ...base, lowFuel: true });
    const restarted = klaxon(ctx).slice(before);
    assert.ok(restarted.length > 0);
    assert.equal(restarted[0].frequency.calls.find(c => c[0] === 'set')[1], 740, 'a fresh pattern from the first tone');
    assert.equal(target(graph.warning), 1);
});

test('warnings off never affects effects or the drone', async () => {
    const { engine, graph } = await running();
    engine.setWarningsEnabled(false);
    assert.equal(engine.play('explosion-bridge'), true);
    assert.ok(target(graph.sfx) > 0 && target(graph.drone) === 1);
});

test('sfx off: every one-shot cue is refused and nothing is scheduled', async () => {
    const { engine, ctx } = await running({ engine: { channels: { sfxEnabled: false } } });
    const cues = ['fire', 'hit', 'explosion-enemy', 'explosion-depot', 'explosion-jet', 'explosion-bridge', 'fanfare',
        'extra-life', 'respawn', 'game-over', 'victory', 'fighter-launch'];
    const nodes = ctx.nodes.length;
    for (const cue of cues) assert.equal(engine.play(cue), false, cue);
    engine.handleEvent({ type: 'bridge-destroyed' });
    engine.handleEvent({ type: 'enemy-destroyed', rammed: false });
    assert.equal(ctx.nodes.length, nodes, 'no audio nodes created at all');
    assert.deepEqual([...engine.recentCues], []);
});

test('sfx off also silences the refuel chime, but the drone and alarm carry on', async () => {
    const { engine, ctx, graph } = await running({ engine: { channels: { sfxEnabled: false } } });
    const chimes = () => oscillators(ctx).filter(o => o.type === 'sine' && (o.frequency.calls.find(c => c[0] === 'set')?.[1] ?? 0) > 400).length;
    const before = chimes();
    ctx.currentTime = 1;
    engine.syncGame({ ...base, refueling: true, lowFuel: true });
    assert.equal(chimes(), before);
    assert.ok(klaxon(ctx).length > 0, 'the alarm still sounds');
    assert.equal(target(graph.drone), 1);
    assert.equal(target(graph.sfx), 0);
});

test('sfx on again: cues play and the bus is open', async () => {
    const { engine, graph } = await running({ engine: { channels: { sfxEnabled: false } } });
    engine.setSfxEnabled(true);
    assert.equal(engine.play('fire'), true);
    assert.ok(target(graph.sfx) > 0);
});

test('switching effects off fades the bus out, so a sound already playing is cut within milliseconds', async () => {
    const { engine, ctx, graph } = await running();
    engine.play('explosion-bridge');
    ctx.currentTime = 0.5;
    engine.setSfxEnabled(false);
    const fade = graph.sfx.gain.calls.at(-1);
    assert.deepEqual(fade.slice(0, 2), ['target', 0]);
    assert.equal(fade[2], 0.5);
    assert.ok(fade[3] <= 0.05);
});

test('each switch is independent of the others', async () => {
    const { engine, graph } = await running();
    const state = () => [target(graph.sfx) > 0, target(graph.drone) > 0, target(graph.warning) > 0];
    assert.deepEqual(state(), [true, true, true]);
    engine.setSfxEnabled(false);
    assert.deepEqual(state(), [false, true, true]);
    engine.setDroneEnabled(false);
    assert.deepEqual(state(), [false, false, true]);
    engine.setWarningsEnabled(false);
    assert.deepEqual(state(), [false, false, false]);
    engine.setSfxEnabled(true);
    assert.deepEqual(state(), [true, false, false]);
    engine.setDroneEnabled(true);
    engine.setWarningsEnabled(true);
    assert.deepEqual(state(), [true, true, true]);
});

test('switches set before audio is unlocked apply as soon as it is', async () => {
    const { engine } = await running({ unlock: false });
    engine.setSfxEnabled(false);
    engine.setDroneEnabled(false);
    engine.setWarningsEnabled(false);
    await engine.unlock();
    const compressor = engine.context.nodes.find(n => n.kind === 'compressor');
    const buses = engine.context.nodes.filter(n => n.kind === 'gain' && n.connections.includes(compressor));
    assert.deepEqual(buses.map(b => b.gain.value), [0, 0, 0]);
});

// ------------------------------------------------------ master mute and volume

test('master mute silences the master gain whatever the channel switches say, and unmute restores it', async () => {
    const { engine, graph } = await running({ engine: { masterVolume: 0.5 } });
    assert.equal(graph.master.gain.value, 0.5);
    engine.setMuted(true);
    assert.equal(target(graph.master), 0);
    assert.equal(engine.play('fire'), false);
    engine.setSfxEnabled(true);
    assert.equal(target(graph.master), 0, 'a channel switch does not un-mute');
    engine.setMuted(false);
    assert.equal(target(graph.master), 0.5);
});

test('the volume acts after the limiter: the compressor sees the same signal at any volume', async () => {
    const { engine, graph } = await running();
    engine.setMasterVolume(0.1);
    engine.setMasterVolume(1);
    assert.equal(target(graph.master), 1);
    assert.equal(target(graph.sfx), 0.9, 'bus levels do not depend on the master volume');
    assert.equal(target(graph.drone), 1);
    assert.ok(graph.compressor.ratio.value >= 10, 'it is configured as a limiter');
});

test('a muted engine still stores switch changes made in the options screen', () => {
    const storage = new MemoryStorage();
    const engine = new SoundEngine({ storage, muted: true });
    engine.setDroneEnabled(false);
    const saved = JSON.parse(storage.data.get(KEY));
    assert.deepEqual([saved.muted, saved.droneEnabled], [true, false]);
});
