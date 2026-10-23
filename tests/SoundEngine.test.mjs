import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import {
    ENGINE_CUTOFF_HZ, ENGINE_LEVEL, ENGINE_PITCH_HZ, EXPLOSION_SPECS, KLAXON_PATTERN_HZ, KLAXON_STEP_SECONDS,
    REFUEL_PATTERN_HZ, REFUEL_STEP_SECONDS, SoundEngine, cuesForEvent, engineCutoffHz, engineLevel, enginePitchHz,
} from '../dist/src/audio/SoundEngine.js';

// ------------------------------------------------------------ fake Web Audio

class FakeParam {
    constructor(value = 0) {
        this.value = value;
        this.calls = [];
    }

    setValueAtTime(v, t) { this.calls.push(['set', v, t]); this.value = v; return this; }
    linearRampToValueAtTime(v, t) { this.calls.push(['linear', v, t]); return this; }
    exponentialRampToValueAtTime(v, t) { this.calls.push(['exp', v, t]); return this; }
    setTargetAtTime(v, t, k) { this.calls.push(['target', v, t, k]); this.value = v; return this; }
    get targets() { return this.calls.filter(c => c[0] === 'target').map(c => c[1]); }
}

class FakeNode {
    constructor(ctx, kind) {
        this.ctx = ctx;
        this.kind = kind;
        this.connections = [];
        this.disconnected = false;
        ctx.nodes.push(this);
    }

    connect(target) { this.connections.push(target); return target; }
    disconnect() { this.disconnected = true; }
}

class FakeGain extends FakeNode {
    constructor(ctx) { super(ctx, 'gain'); this.gain = new FakeParam(1); }
}

class FakeOscillator extends FakeNode {
    constructor(ctx) {
        super(ctx, 'oscillator');
        this.type = 'sine';
        this.frequency = new FakeParam(440);
        this.detune = new FakeParam(0);
        this.startedAt = null;
        this.stoppedAt = null;
    }

    start(t = 0) { this.startedAt = t; }
    stop(t = 0) { this.stoppedAt = t; }
    get initialFrequency() { return this.frequency.calls.find(c => c[0] === 'set')?.[1] ?? this.frequency.value; }
}

class FakeFilter extends FakeNode {
    constructor(ctx) {
        super(ctx, 'filter');
        this.type = 'lowpass';
        this.frequency = new FakeParam(350);
        this.Q = new FakeParam(1);
    }
}

class FakeCompressor extends FakeNode {
    constructor(ctx) {
        super(ctx, 'compressor');
        this.threshold = new FakeParam();
        this.knee = new FakeParam();
        this.ratio = new FakeParam();
        this.attack = new FakeParam();
        this.release = new FakeParam();
    }
}

class FakeSource extends FakeNode {
    constructor(ctx) { super(ctx, 'source'); this.buffer = null; this.starts = []; }
    start(...args) { this.starts.push(args); }
    stop() {}
}

class FakeContext {
    constructor({ state = 'suspended', failResume = false } = {}) {
        this.state = state;
        this.failResume = failResume;
        this.currentTime = 0;
        this.sampleRate = 8000;
        this.destination = { kind: 'destination' };
        this.nodes = [];
        this.resumeCalls = 0;
        this.suspendCalls = 0;
        this.closeCalls = 0;
        this.onstatechange = null;
    }

    createGain() { return new FakeGain(this); }
    createOscillator() { return new FakeOscillator(this); }
    createBiquadFilter() { return new FakeFilter(this); }
    createDynamicsCompressor() { return new FakeCompressor(this); }
    createBufferSource() { return new FakeSource(this); }
    createBuffer(channels, length, rate) {
        const data = new Float32Array(length);
        return { numberOfChannels: channels, length, sampleRate: rate, getChannelData: () => data };
    }

    async resume() {
        this.resumeCalls++;
        if (this.failResume) throw new Error('blocked');
        this.state = 'running';
        this.onstatechange?.();
    }

    async suspend() { this.suspendCalls++; this.state = 'suspended'; this.onstatechange?.(); }
    async close() { this.closeCalls++; this.state = 'closed'; }

    of(kind) { return this.nodes.filter(n => n.kind === kind); }
    get oscillators() { return this.of('oscillator'); }
}

/** An engine that has been unlocked and is running, with a hook to the fake context. */
async function running(options = {}) {
    const contexts = [];
    const changes = [];
    const engine = new SoundEngine({
        createContext: () => {
            const ctx = new FakeContext(options.context);
            contexts.push(ctx);
            return ctx;
        },
        onChange: state => changes.push(state),
        ...options.engine,
    });
    if (options.unlock !== false) await engine.unlock();
    return { engine, ctx: contexts[0], contexts, changes };
}

// --------------------------------------------------------------- pure helpers

test('engine pitch: drops on the brake, hums at cruise, screams at boost', () => {
    assert.equal(enginePitchHz(-1), ENGINE_PITCH_HZ.brake);
    assert.equal(enginePitchHz(0), ENGINE_PITCH_HZ.cruise);
    assert.equal(enginePitchHz(1), ENGINE_PITCH_HZ.boost);
    assert.ok(ENGINE_PITCH_HZ.brake < ENGINE_PITCH_HZ.cruise && ENGINE_PITCH_HZ.cruise < ENGINE_PITCH_HZ.boost);
    let previous = -Infinity;
    for (let t = -1; t <= 1.0001; t += 0.05) {
        const hz = enginePitchHz(t);
        assert.ok(hz > previous, `not rising at ${t}`);
        previous = hz;
    }
});

test('engine pitch, brightness and level clamp and tolerate bad input', () => {
    for (const bad of [NaN, Infinity, -Infinity, undefined]) {
        assert.equal(enginePitchHz(bad === Infinity ? 0 : bad), enginePitchHz(0));
    }
    assert.equal(enginePitchHz(5), ENGINE_PITCH_HZ.boost);
    assert.equal(enginePitchHz(-5), ENGINE_PITCH_HZ.brake);
    assert.equal(engineCutoffHz(NaN), ENGINE_CUTOFF_HZ.cruise);
    assert.equal(engineLevel(NaN), ENGINE_LEVEL.cruise);
});

test('the engine gets brighter and louder with the throttle, and the cutoff moves smoothly', () => {
    assert.ok(Math.abs(engineCutoffHz(-1) - ENGINE_CUTOFF_HZ.brake) < 1e-9);
    assert.ok(Math.abs(engineCutoffHz(0) - ENGINE_CUTOFF_HZ.cruise) < 1e-9);
    assert.ok(Math.abs(engineCutoffHz(1) - ENGINE_CUTOFF_HZ.boost) < 1e-6);
    assert.ok(Math.abs(engineLevel(-1) - ENGINE_LEVEL.brake) < 1e-12);
    assert.ok(Math.abs(engineLevel(1) - ENGINE_LEVEL.boost) < 1e-12);
    let cutoff = 0;
    let level = 0;
    for (let t = -1; t <= 1.0001; t += 0.1) {
        assert.ok(engineCutoffHz(t) > cutoff && engineLevel(t) > level);
        cutoff = engineCutoffHz(t);
        level = engineLevel(t);
    }
});

test('explosion recipes: bridges boom longest and deepest, enemies are short and snappy', () => {
    const { enemy, depot, jet, bridge } = EXPLOSION_SPECS;
    assert.ok(bridge.duration > jet.duration && jet.duration > depot.duration && depot.duration > enemy.duration);
    assert.ok(bridge.boom.from < jet.boom.from && bridge.boom.to < jet.boom.to);
    assert.equal(enemy.boom, undefined, 'enemies get no sub-bass');
    assert.ok(depot.boom && jet.boom && bridge.boom);
    assert.ok(bridge.peak > enemy.peak);
    for (const spec of Object.values(EXPLOSION_SPECS)) assert.ok(spec.lowpassFrom > spec.lowpassTo, 'bright to dark');
});

// ---------------------------------------------------------- event -> cue table

test('game events map to the right cues', () => {
    const cues = event => cuesForEvent(event).map(r => r.cue);
    assert.deepEqual(cues({ type: 'fire' }), ['fire']);
    assert.deepEqual(cues({ type: 'enemy-destroyed', rammed: false }), ['hit', 'explosion-enemy']);
    assert.deepEqual(cues({ type: 'enemy-destroyed', rammed: true }), ['explosion-enemy']);
    assert.deepEqual(cues({ type: 'depot-destroyed' }), ['explosion-depot']);
    assert.deepEqual(cues({ type: 'bridge-destroyed' }), ['explosion-bridge', 'fanfare']);
    assert.deepEqual(cues({ type: 'jet-destroyed' }), ['explosion-jet']);
    assert.deepEqual(cues({ type: 'extra-life' }), ['extra-life']);
    assert.deepEqual(cues({ type: 'respawn' }), ['respawn']);
    assert.deepEqual(cues({ type: 'game-over' }), ['game-over']);
    assert.deepEqual(cues({ type: 'victory' }), ['victory']);
    assert.deepEqual(cues({ type: 'fighter-launch' }), ['fighter-launch']);
});

test('events that make no sound of their own map to nothing', () => {
    for (const type of ['refuel-start', 'refuel-stop', 'low-fuel', 'fuel-empty', 'stage-clear']) {
        assert.deepEqual(cuesForEvent({ type }), [], type);
    }
});

test('the bridge fanfare follows the blast rather than masking it', () => {
    const [blast, fanfare] = cuesForEvent({ type: 'bridge-destroyed' });
    assert.equal(blast.delay, 0);
    assert.ok(fanfare.delay >= 0.3);
    const [, hitBoom] = cuesForEvent({ type: 'enemy-destroyed', rammed: false });
    assert.ok(hitBoom.delay > 0 && hitBoom.delay < 0.05, 'the hit tick lands just before the boom');
});

// ----------------------------------------------------------------- lifecycle

test('without Web Audio support everything is a safe no-op and the state says so', async () => {
    const engine = new SoundEngine();
    assert.equal(engine.state, 'unsupported');
    assert.equal(await engine.unlock(), false);
    assert.equal(engine.play('fire'), false);
    engine.handleEvent({ type: 'fire' });
    engine.syncGame({ throttle: 1, engineOn: true, refueling: true, lowFuel: true, paused: false });
    engine.update();
    engine.setMasterVolume(0.3);
    await engine.destroy();
});

test('audio starts locked (browsers need a gesture) and nothing plays until it is unlocked', async () => {
    const { engine, contexts } = await running({ unlock: false });
    assert.equal(engine.state, 'locked');
    assert.equal(contexts.length, 0, 'no context is created before a gesture');
    assert.equal(engine.play('fire'), false);
    assert.equal(engine.context, null);
});

test('unlock creates the context, resumes it and reports "on"', async () => {
    const { engine, ctx, changes } = await running({ unlock: false });
    assert.equal(await engine.unlock(), true);
    const live = engine.context;
    assert.equal(live.state, 'running');
    assert.equal(live.resumeCalls, 1);
    assert.equal(engine.state, 'on');
    assert.ok(changes.includes('on'));
    assert.equal(await engine.unlock(), true, 'idempotent');
    assert.equal(engine.context, live, 'still one context');
    assert.equal(ctx, undefined, 'the factory only ran on unlock');
});

test('a blocked resume leaves the engine locked rather than throwing', async () => {
    const { engine } = await running({ unlock: false, context: { failResume: true } });
    assert.equal(await engine.unlock(), false);
    assert.equal(engine.state, 'locked');
    assert.equal(engine.play('fire'), false);
});

test('a throwing context factory is survivable', async () => {
    const engine = new SoundEngine({ createContext: () => { throw new Error('no audio device'); } });
    assert.equal(await engine.unlock(), false);
    assert.equal(engine.play('fire'), false);
});

test('the audio graph is built once: three buses -> compressor -> master -> destination, and a running drone', async () => {
    const { ctx } = await running();
    assert.equal(ctx.of('compressor').length, 1);
    const [master] = ctx.of('gain');
    const compressor = ctx.of('compressor')[0];
    assert.deepEqual(compressor.connections, [master], 'the compressor feeds the master volume');
    assert.deepEqual(master.connections, [ctx.destination], 'and the master volume feeds the speakers');
    const buses = ctx.of('gain').filter(g => g.connections.includes(compressor));
    assert.equal(buses.length, 3, 'sfx, drone and warning buses all feed the compressor');
    const voices = ctx.oscillators.map(o => o.type).sort();
    assert.deepEqual(voices, ['sawtooth', 'sine', 'triangle'], 'saw + triangle drone and a vibrato LFO');
    assert.ok(ctx.oscillators.every(o => o.startedAt !== null));
    assert.ok(ctx.of('filter').some(f => f.type === 'lowpass'));
});

test('no external assets: the engine never needs fetch, Audio elements or files', async () => {
    const before = typeof globalThis.fetch;
    const { engine } = await running();
    engine.play('explosion-bridge');
    engine.play('fanfare');
    assert.equal(typeof globalThis.fetch, before);
});

// ------------------------------------------------------------------ mute / volume

test('mute silences the master bus and blocks one-shots; unmute restores them', async () => {
    const { engine, ctx, changes } = await running({ engine: { masterVolume: 0.5 } });
    const master = ctx.of('gain')[0];
    assert.equal(master.gain.value, 0.5);
    assert.equal(engine.toggleMute(), true);
    assert.equal(engine.muted, true);
    assert.equal(engine.state, 'muted');
    assert.equal(master.gain.targets.at(-1), 0);
    assert.equal(engine.play('fire'), false);
    assert.equal(changes.at(-1), 'muted');
    assert.equal(engine.toggleMute(), false);
    assert.equal(engine.state, 'on');
    assert.equal(master.gain.targets.at(-1), 0.5);
    assert.equal(engine.play('fire'), true);
});

test('muting works before audio is unlocked, and is honoured when it is', async () => {
    const { engine } = await running({ unlock: false, engine: { muted: true } });
    assert.equal(engine.state, 'muted');
    await engine.unlock();
    const master = engine.context.of('gain')[0];
    assert.equal(master.gain.value, 0, 'starts silent');
    assert.equal(engine.play('fire'), false);
});

test('setMuted is idempotent and only notifies on a change', async () => {
    const { engine, changes } = await running();
    const base = changes.length;
    engine.setMuted(false);
    assert.equal(changes.length, base);
    engine.setMuted(true);
    engine.setMuted(true);
    assert.equal(changes.length, base + 1);
});

test('master volume is clamped to [0, 1] and applied live; bad values are ignored', async () => {
    const { engine, ctx } = await running();
    const master = ctx.of('gain')[0];
    engine.setMasterVolume(0.25);
    assert.equal(engine.masterVolume, 0.25);
    assert.equal(master.gain.targets.at(-1), 0.25);
    engine.setMasterVolume(7);
    assert.equal(engine.masterVolume, 1);
    engine.setMasterVolume(-3);
    assert.equal(engine.masterVolume, 0);
    engine.setMasterVolume(NaN);
    assert.equal(engine.masterVolume, 0);
    assert.equal(new SoundEngine({ masterVolume: 9 }).masterVolume, 1);
    assert.equal(new SoundEngine({ masterVolume: NaN }).masterVolume, 0.6);
});

// -------------------------------------------------------------------- one-shots

test('every cue plays, schedules sound and is logged', async () => {
    const { engine, ctx } = await running();
    const cues = ['fire', 'hit', 'explosion-enemy', 'explosion-depot', 'explosion-jet', 'explosion-bridge', 'fanfare',
        'extra-life', 'respawn', 'game-over', 'victory', 'fighter-launch'];
    for (const cue of cues) {
        const nodes = ctx.nodes.length;
        assert.equal(engine.play(cue), true, cue);
        assert.ok(ctx.nodes.length > nodes, `${cue} created no audio nodes`);
    }
    assert.deepEqual([...engine.recentCues], cues);
});

test('explosions are shaped noise through a resonant low-pass sweeping down, with an exponential decay', async () => {
    const { engine, ctx } = await running();
    const before = ctx.nodes.length;
    engine.play('explosion-bridge');
    const fresh = ctx.nodes.slice(before);
    const source = fresh.find(n => n.kind === 'source');
    assert.ok(source?.buffer, 'a noise buffer is used');
    const lowpass = fresh.find(n => n.kind === 'filter' && n.type === 'lowpass');
    assert.ok(lowpass.Q.value >= EXPLOSION_SPECS.bridge.q - 1e-9, 'resonant');
    const sweep = lowpass.frequency.calls;
    assert.equal(sweep[0][1], EXPLOSION_SPECS.bridge.lowpassFrom);
    assert.equal(sweep.find(c => c[0] === 'exp')[1], EXPLOSION_SPECS.bridge.lowpassTo);
    const envelope = fresh.filter(n => n.kind === 'gain').map(g => g.gain.calls).find(c => c.some(x => x[0] === 'exp'));
    assert.ok(envelope.some(c => c[0] === 'exp' && c[1] < 0.001), 'decays exponentially to silence');
    const boom = fresh.find(n => n.kind === 'oscillator' && n.type === 'sine');
    assert.ok(boom, 'sub-bass boom');
    assert.equal(boom.initialFrequency, EXPLOSION_SPECS.bridge.boom.from);
    assert.equal(boom.frequency.calls.find(c => c[0] === 'exp')[1], EXPLOSION_SPECS.bridge.boom.to);
});

test('an enemy blast has no boom oscillator and is shorter than a bridge\u2019s', async () => {
    const { engine, ctx } = await running();
    const nodes = ctx.nodes.length;
    engine.play('explosion-enemy');
    const fresh = ctx.nodes.slice(nodes);
    assert.equal(fresh.filter(n => n.kind === 'oscillator').length, 0);
    const start = fresh.find(n => n.kind === 'source').starts[0];
    assert.ok(start[2] < 0.6, `burst length ${start[2]}`);
});

test('missile fire is a fast downward frequency sweep with a punchy attack', async () => {
    const { engine, ctx } = await running();
    const nodes = ctx.nodes.length;
    engine.play('fire');
    const fresh = ctx.nodes.slice(nodes);
    const osc = fresh.find(n => n.kind === 'oscillator' && n.type === 'square');
    const start = osc.initialFrequency;
    const end = osc.frequency.calls.find(c => c[0] === 'exp')[1];
    assert.ok(start > 800 && end < start / 5, `${start} -> ${end}`);
    assert.ok(osc.stoppedAt - osc.startedAt < 0.3, 'short');
    const gain = fresh.filter(n => n.kind === 'gain').find(g => g.gain.calls.some(c => c[0] === 'linear'));
    const attack = gain.gain.calls.find(c => c[0] === 'linear');
    assert.ok(attack[2] - osc.startedAt <= 0.005, 'near-instant transient');
});

test('the bridge fanfare is a rising chord cadence resolving on a bright major triad', async () => {
    const { engine, ctx } = await running();
    const nodes = ctx.nodes.length;
    engine.play('fanfare');
    // Chord voices are sawtooths; the bass notes (triangle/sine) share their start times.
    const tones = ctx.nodes.slice(nodes).filter(n => n.kind === 'oscillator' && n.type === 'sawtooth');
    const byStart = new Map();
    for (const t of tones) byStart.set(t.startedAt, [...(byStart.get(t.startedAt) ?? []), t.initialFrequency]);
    const starts = [...byStart.keys()].sort((a, b) => a - b);
    assert.ok(starts.length >= 3, 'three chords');
    const roots = starts.map(s => Math.max(...byStart.get(s)));
    assert.ok(roots[1] > roots[0] && roots[2] > roots[1], 'climbs');
    const final = byStart.get(starts.at(-1)).sort((a, b) => a - b);
    assert.ok(final.length >= 3);
    const ratio = final[1] / final[0];
    assert.ok(Math.abs(ratio - 1.26) < 0.02, `major third ratio ${ratio}`);
});

test('victory is a longer, bigger fanfare than a bridge', async () => {
    const { engine, ctx } = await running();
    const length = cue => {
        const nodes = ctx.nodes.length;
        engine.play(cue);
        const tones = ctx.nodes.slice(nodes).filter(n => n.kind === 'oscillator');
        return Math.max(...tones.map(t => t.stoppedAt)) - Math.min(...tones.map(t => t.startedAt));
    };
    assert.ok(length('victory') > length('fanfare') + 0.5);
});

test('a delayed cue is scheduled in the future, relative to the audio clock', async () => {
    const { engine, ctx } = await running();
    ctx.currentTime = 10;
    engine.handleEvent({ type: 'bridge-destroyed' });
    const sources = ctx.of('source');
    assert.ok(sources.some(s => s.starts[0][0] === 10), 'blast now');
    const tones = ctx.oscillators.filter(o => o.startedAt >= 10.4);
    assert.ok(tones.length > 0, 'the fanfare starts about half a second later');
});

test('handleEvent plays every cue an event calls for', async () => {
    const { engine } = await running();
    engine.handleEvent({ type: 'enemy-destroyed', rammed: false });
    engine.handleEvent({ type: 'low-fuel' });
    assert.deepEqual([...engine.recentCues], ['hit', 'explosion-enemy']);
});

test('one-shot nodes are released when they finish', async () => {
    const { engine, ctx } = await running();
    const before = ctx.nodes.length;
    engine.play('fire');
    const created = ctx.nodes.slice(before);
    for (const node of created) node.onended?.();
    assert.ok(created.filter(n => n.kind === 'oscillator' || n.kind === 'source').every(n => n.disconnected));
});

test('the noise buffer is reproducible: same seed, same samples', async () => {
    const data = async seed => {
        const { ctx } = await running({ engine: { seed } });
        const source = ctx.of('source')[0] ?? null;
        if (!source) {
            const { engine, ctx: c2 } = await running({ engine: { seed } });
            engine.play('explosion-enemy');
            return Array.from(c2.of('source')[0].buffer.getChannelData(0).slice(0, 64));
        }
        return Array.from(source.buffer.getChannelData(0).slice(0, 64));
    };
    assert.deepEqual(await data(5), await data(5));
    assert.notDeepEqual(await data(5), await data(6));
});

// ------------------------------------------------------------------- engine drone

test('the drone pitch follows the throttle: brake < cruise < boost', async () => {
    const { engine, ctx } = await running();
    const saw = ctx.oscillators.find(o => o.type === 'sawtooth');
    const triangle = ctx.oscillators.find(o => o.type === 'triangle');
    const filter = ctx.of('filter').find(f => f.type === 'lowpass');
    const state = throttle => ({ throttle, engineOn: true, refueling: false, lowFuel: false, paused: false });
    engine.syncGame(state(-1));
    engine.syncGame(state(0));
    engine.syncGame(state(1));
    const pitches = saw.frequency.targets;
    assert.deepEqual(pitches.slice(-3), [52, 88, 196]);
    assert.deepEqual(triangle.frequency.targets.slice(-3), [26, 44, 98], 'an octave below');
    const cutoffs = filter.frequency.targets.slice(-3);
    assert.ok(cutoffs[0] < cutoffs[1] && cutoffs[1] < cutoffs[2]);
});

test('the drone fades in with the engine and out when it stops, is silent when paused', async () => {
    const { engine, ctx } = await running();
    const drone = ctx.of('gain').find(g => g.gain.value === 0 && g.connections.length === 1);
    const on = { throttle: 0, engineOn: true, refueling: false, lowFuel: false, paused: false };
    engine.syncGame(on);
    const level = drone.gain.targets.at(-1);
    assert.ok(level > 0.1 && level < 0.3, `cruise level ${level}`);
    engine.syncGame({ ...on, engineOn: false });
    assert.equal(drone.gain.targets.at(-1), 0);
    engine.syncGame(on);
    assert.ok(drone.gain.targets.at(-1) > 0);
    engine.syncGame({ ...on, paused: true });
    assert.equal(drone.gain.targets.at(-1), 0);
});

test('unchanged game state does not re-issue audio parameter changes every frame', async () => {
    const { engine, ctx } = await running();
    const saw = ctx.oscillators.find(o => o.type === 'sawtooth');
    const state = { throttle: 0.5, engineOn: true, refueling: false, lowFuel: false, paused: false };
    engine.syncGame(state);
    const count = saw.frequency.calls.length;
    for (let i = 0; i < 100; i++) engine.syncGame(state);
    assert.equal(saw.frequency.calls.length, count);
});

test('the drone follows the game state even when sync arrives before unlock', async () => {
    const { engine } = await running({ unlock: false });
    engine.syncGame({ throttle: 1, engineOn: true, refueling: false, lowFuel: false, paused: false });
    await engine.unlock();
    const saw = engine.context.oscillators.find(o => o.type === 'sawtooth');
    assert.ok(saw.frequency.targets.includes(196), 'it starts at the current throttle, not at the default');
});

// ------------------------------------------------------------------ refuel chime

const base = { throttle: 0, engineOn: true, refueling: false, lowFuel: false, paused: false };
const notes = (ctx, type) => ctx.oscillators.filter(o => o.type === type && o.startedAt !== null);

test('refuelling plays an ascending arpeggio that repeats while refuelling', async () => {
    const { engine, ctx } = await running();
    const sine = () => notes(ctx, 'sine').filter(o => o.stoppedAt - o.startedAt < 0.2 && o.initialFrequency > 400);
    const begin = sine().length;
    for (let frame = 0; frame < 60; frame++) {
        ctx.currentTime = frame / 60;
        engine.syncGame({ ...base, refueling: true });
    }
    const played = sine().slice(begin).sort((a, b) => a.startedAt - b.startedAt);
    const played4 = played.slice(0, 4).map(o => o.initialFrequency);
    assert.deepEqual(played4.map(f => Math.round(f)), REFUEL_PATTERN_HZ.slice(0, 4).map(Math.round));
    assert.ok(played4.every((f, i) => i === 0 || f > played4[i - 1]), 'ascending');
    assert.ok(played.length >= 8, `${played.length} notes in a second`);
    const gaps = played.slice(1).map((o, i) => o.startedAt - played[i].startedAt);
    assert.ok(gaps.every(g => g >= REFUEL_STEP_SECONDS - 1e-9), 'on the grid');
    assert.ok(gaps.some(g => g > REFUEL_STEP_SECONDS * 1.5), 'a rest after each run of four');
});

test('the refuel chime stops when refuelling stops, and restarts from its first note', async () => {
    const { engine, ctx } = await running();
    const chime = () => notes(ctx, 'sine').filter(o => o.stoppedAt - o.startedAt < 0.2 && o.initialFrequency > 400).length;
    ctx.currentTime = 1;
    engine.syncGame({ ...base, refueling: true });
    const first = chime();
    assert.ok(first > 0);
    ctx.currentTime = 2;
    engine.syncGame({ ...base, refueling: false });
    assert.equal(chime(), first, 'nothing scheduled once it stops');
    ctx.currentTime = 3;
    engine.syncGame({ ...base, refueling: true });
    const latest = notes(ctx, 'sine').filter(o => o.startedAt >= 3 && o.initialFrequency > 400)[0];
    assert.equal(Math.round(latest.initialFrequency), Math.round(REFUEL_PATTERN_HZ[0]), 'a fresh arpeggio starts on its root');
});

test('the refuel chime is silent when muted or paused, and never schedules more than a short lookahead', async () => {
    const { engine, ctx } = await running();
    const count = () => ctx.oscillators.length;
    engine.setMuted(true);
    const before = count();
    ctx.currentTime = 1;
    engine.syncGame({ ...base, refueling: true });
    assert.equal(count(), before);
    engine.setMuted(false);
    engine.syncGame({ ...base, refueling: true, paused: true });
    assert.equal(count(), before);
    const start = count();
    ctx.currentTime = 5;
    engine.syncGame({ ...base, refueling: true });
    const scheduled = ctx.oscillators.slice(start).filter(o => o.startedAt !== null && o.initialFrequency > 400);
    assert.ok(scheduled.every(o => o.startedAt <= 5 + 0.15), 'only a little ahead of the clock');
});

// --------------------------------------------------------------------- klaxon

test('low fuel sounds a two-tone klaxon: alternating tones, twice, then a pause', async () => {
    const { engine, ctx } = await running();
    const start = ctx.oscillators.length;
    for (let frame = 0; frame < 120; frame++) {
        ctx.currentTime = frame / 60;
        engine.syncGame({ ...base, lowFuel: true });
    }
    const alarm = ctx.oscillators.slice(start).filter(o => o.type === 'square').sort((a, b) => a.startedAt - b.startedAt);
    const freqs = alarm.slice(0, 4).map(o => o.initialFrequency);
    assert.deepEqual(freqs, [740, 988, 740, 988]);
    assert.deepEqual(KLAXON_PATTERN_HZ.slice(0, 4), freqs);
    const gaps = alarm.slice(1).map((o, i) => o.startedAt - alarm[i].startedAt);
    assert.ok(gaps.slice(0, 3).every(g => Math.abs(g - KLAXON_STEP_SECONDS) < 1e-6));
    assert.ok(gaps.some(g => g > KLAXON_STEP_SECONDS * 2.5), 'the pause between bursts');
    assert.ok(alarm.length >= 8, `${alarm.length} beeps in two seconds`);
});

test('the klaxon stops when fuel is restored, when the game is paused or muted', async () => {
    const { engine, ctx } = await running();
    const alarms = () => ctx.oscillators.filter(o => o.type === 'square' && [740, 988].includes(o.initialFrequency)).length;
    ctx.currentTime = 1;
    engine.syncGame({ ...base, lowFuel: true });
    const n = alarms();
    assert.ok(n > 0);
    ctx.currentTime = 2;
    engine.syncGame({ ...base, lowFuel: false });
    assert.equal(alarms(), n);
    engine.syncGame({ ...base, lowFuel: true, paused: true });
    assert.equal(alarms(), n);
    engine.setMuted(true);
    engine.syncGame({ ...base, lowFuel: true });
    assert.equal(alarms(), n);
});

test('the klaxon keeps sounding through the final engine-out glide (the drone does not)', async () => {
    const { engine, ctx } = await running();
    const drone = ctx.of('gain').find(g => g.gain.value === 0 && g.connections.length === 1);
    ctx.currentTime = 1;
    engine.syncGame({ ...base, lowFuel: true, engineOn: false });
    assert.equal(drone.gain.targets.at(-1), 0);
    assert.ok(ctx.oscillators.some(o => o.type === 'square' && o.initialFrequency === 740));
});

// ---------------------------------------------------------- gestures and keys

function pageFixture() {
    const dom = new JSDOM('<input id="field"><canvas id="c" tabindex="0"></canvas>', { pretendToBeVisual: true });
    return { dom, window: dom.window, document: dom.window.document };
}

async function settle() {
    await new Promise(resolve => setImmediate(resolve));
}

test('the first pointer press unlocks audio', async () => {
    const { window } = pageFixture();
    const { engine } = await running({ unlock: false });
    engine.attach(window);
    assert.equal(engine.state, 'locked');
    window.document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
    await settle();
    assert.equal(engine.state, 'on');
    engine.detach();
});

test('the first key press unlocks audio too', async () => {
    const { window } = pageFixture();
    const { engine } = await running({ unlock: false });
    engine.attach(window);
    window.document.body.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'ArrowUp', bubbles: true }));
    await settle();
    assert.equal(engine.state, 'on');
    engine.detach();
});

test('M toggles mute from anywhere on the page, but not while typing, repeating or with modifiers', async () => {
    const { window, document } = pageFixture();
    const { engine } = await running();
    engine.attach(window);
    const press = (target, extra = {}) => target.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'KeyM', bubbles: true, cancelable: true, ...extra }));
    press(document.getElementById('c'));
    assert.equal(engine.muted, true);
    press(document.body);
    assert.equal(engine.muted, false);
    press(document.getElementById('field'));
    assert.equal(engine.muted, false, 'typing an "m" in a text field must not mute');
    press(document.body, { repeat: true });
    assert.equal(engine.muted, false, 'key repeat is ignored');
    for (const extra of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) press(document.body, extra);
    assert.equal(engine.muted, false, 'browser shortcuts are left alone');
    press(window);
    assert.equal(engine.muted, true, 'also works when dispatched at the window');
    engine.detach();
});

test('detach removes every listener: M and gestures do nothing afterwards', async () => {
    const { window, document } = pageFixture();
    const { engine } = await running({ unlock: false });
    engine.attach(window);
    engine.detach();
    document.body.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'KeyM', bubbles: true }));
    document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
    await settle();
    assert.equal(engine.muted, false);
    assert.equal(engine.context, null);
    engine.detach();
});

test('re-attaching moves the listeners rather than doubling them', async () => {
    const { window, document } = pageFixture();
    const { engine } = await running();
    engine.attach(window);
    engine.attach(window);
    document.body.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'KeyM', bubbles: true }));
    assert.equal(engine.muted, true, 'toggled once, not twice');
    engine.detach();
});

test('hiding the tab suspends audio; showing it resumes (but never overrides the user\u2019s mute)', async () => {
    const { window, document } = pageFixture();
    const { engine } = await running();
    const ctx = engine.context;
    engine.attach(window);
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new window.Event('visibilitychange'));
    await settle();
    assert.equal(ctx.suspendCalls, 1);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new window.Event('visibilitychange'));
    await settle();
    assert.equal(ctx.state, 'running');
    assert.equal(engine.state, 'on');
    engine.detach();
});

// ------------------------------------------------------------------ destroy

test('destroy stops the drone, closes the context and allows a later unlock', async () => {
    const { engine, ctx, contexts } = await running();
    const oscillators = ctx.oscillators.slice();
    await engine.destroy();
    assert.equal(ctx.closeCalls, 1);
    assert.ok(oscillators.every(o => o.stoppedAt !== null), 'the drone oscillators were stopped');
    assert.equal(engine.context, null);
    assert.equal(engine.play('fire'), false);
    await engine.unlock();
    assert.equal(contexts.length, 2, 'a fresh context');
    assert.equal(engine.state, 'on');
    await engine.destroy();
    await engine.destroy();
});
