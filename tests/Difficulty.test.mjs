import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FuelSystem } from '../dist/src/systems/FuelSystem.js';
import {
    CAMPAIGN_DIFFICULTY, DEFAULT_DIFFICULTY, difficultyAt, hardCapScale, normalizeStage, softCapScale, validateDifficultyConfig,
} from '../dist/src/systems/Difficulty.js';
import { DepotSpawner } from '../dist/src/entities/FuelDepot.js';
import { FIGHTER_MAX_SPEED, FIGHTER_MIN_SPEED, FIGHTER_SPEED_LIMIT, FIGHTER_TRIGGER_DISTANCE } from '../dist/src/entities/enemies/FighterJet.js';
import { HELICOPTER_MAX_SPEED, HELICOPTER_SPEED_LIMIT } from '../dist/src/entities/enemies/Helicopter.js';
import { DEFAULT_JET_CONFIG, PlayerJet, scaleJetConfig } from '../dist/src/entities/PlayerJet.js';
import { GameSession } from '../dist/src/game/GameSession.js';
import { boxTouchesLand } from '../dist/src/systems/CollisionSystem.js';
import { EnemySpawner, createEnemy } from '../dist/src/systems/EnemySpawner.js';
import { RiverGenerator } from '../dist/src/world/RiverGenerator.js';
import { DT, headlessGame, pilot } from './helpers.mjs';

const near = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message ?? ''} expected ${expected} +/- ${tolerance}, got ${actual}`);
const stages = Array.from({ length: 101 }, (_, i) => i);
const rich = { fuel: { capacity: 1e9, startLevel: 1e9 }, depots: { chance: 0 }, enemies: { enabled: false } };
const bot = (options = {}) => (_f, g) => pilot(g.session, g.engine.world, { seekDepots: false, fire: true, throttle: 0, ...options });

// ------------------------------------------------------------------ the formulas

test('stage 0 is exactly the campaign game: every scale is 1 and nothing extra spawns', () => {
    const p = difficultyAt(0);
    assert.deepEqual(
        [p.speedScale, p.burnScale, p.helicopterSpeedScale, p.depotChanceScale, p.fighterSpeedScale, p.extraEnemyChance],
        [1, 1, 1, 1, 1, 0],
    );
    assert.equal(p.fighterTrigger, FIGHTER_TRIGGER_DISTANCE);
    assert.deepEqual(CAMPAIGN_DIFFICULTY, p);
});

test('stages are whole numbers >= 0: nonsense is stage 0, fractions round down', () => {
    for (const bad of [-1, -50, NaN, Infinity, -Infinity]) assert.equal(normalizeStage(bad), 0, String(bad));
    assert.equal(normalizeStage(3.9), 3);
    assert.equal(normalizeStage(7), 7);
    assert.deepEqual(difficultyAt(NaN), difficultyAt(0));
    assert.deepEqual(difficultyAt(-4), difficultyAt(0));
    assert.deepEqual(difficultyAt(5.7), difficultyAt(5));
});

test('SPEED: +3.5% per bridge in a straight line, then a soft cap that approaches 1.8x without reaching it', () => {
    const scale = n => difficultyAt(n).speedScale;
    // Every one of the first 13 bridges adds 3.0-4.0% of the base speed (the spec's "+3% to +4%").
    for (let n = 0; n < 13; n++) near(scale(n + 1) - scale(n), 0.035, 1e-9, `bridge ${n + 1}`);
    // Strictly increasing forever, never reaching the ceiling.
    for (let n = 0; n < 200; n++) {
        assert.ok(scale(n + 1) > scale(n), `still rising at ${n}`);
        assert.ok(scale(n) < DEFAULT_DIFFICULTY.speedCap, `below the cap at ${n}`);
    }
    for (const n of [300, 1000, 1e6]) assert.ok(scale(n) <= DEFAULT_DIFFICULTY.speedCap, `never above the cap, even far out (${n})`);
    // The increments only ever shrink (concave): that is what makes it a soft cap and not a wall.
    for (let n = 1; n < 200; n++) assert.ok(scale(n + 1) - scale(n) <= scale(n) - scale(n - 1) + 1e-12, `concave at ${n}`);
    // No kink where the line turns into the curve.
    const kink = Math.round((0.8 * 0.6) / 0.035);
    near(scale(kink + 1) - scale(kink), scale(kink) - scale(kink - 1), 0.004, 'smooth at the knee');
    near(scale(100), 1.8, 1e-3, 'effectively at the ceiling by bridge 100');
});

test('SPEED: the example speeds from the brief (cruise ~390, brake ~160, boost ~750) are what the cap gives', () => {
    const p = difficultyAt(60);
    near(DEFAULT_JET_CONFIG.cruiseSpeed * p.speedScale, 390, 8);
    near(DEFAULT_JET_CONFIG.minSpeed * p.speedScale, 160, 4);
    near(DEFAULT_JET_CONFIG.maxSpeed * p.speedScale, 750, 10);
});

test('FUEL: burn rises 2.5% per bridge in a line and stops dead at 1.6x', () => {
    for (let n = 0; n <= 24; n++) near(difficultyAt(n).burnScale, 1 + 0.025 * n, 1e-12, `bridge ${n}`);
    for (let n = 24; n <= 300; n++) assert.equal(difficultyAt(n).burnScale, 1.6, `capped at ${n}`);
});

test('HELICOPTERS: +5% per bridge up to exactly 1.75x', () => {
    for (let n = 0; n <= 15; n++) near(difficultyAt(n).helicopterSpeedScale, 1 + 0.05 * n, 1e-12);
    for (let n = 15; n <= 200; n++) assert.equal(difficultyAt(n).helicopterSpeedScale, 1.75);
    assert.ok(HELICOPTER_MAX_SPEED * 1.75 <= HELICOPTER_SPEED_LIMIT, 'the helicopter limit leaves room for the cap');
});

test('FIGHTERS: the launch envelope grows from 600 to 850 and the fastest streak from 460 to 580', () => {
    assert.equal(difficultyAt(0).fighterTrigger, 600);
    assert.equal(difficultyAt(15).fighterTrigger, 850);
    assert.equal(difficultyAt(500).fighterTrigger, 850);
    near(FIGHTER_MAX_SPEED * difficultyAt(15).fighterSpeedScale, 580, 1e-9);
    near(FIGHTER_MAX_SPEED * difficultyAt(500).fighterSpeedScale, FIGHTER_SPEED_LIMIT, 1e-9);
    for (let n = 0; n < 40; n++) {
        assert.ok(difficultyAt(n + 1).fighterTrigger >= difficultyAt(n).fighterTrigger);
        assert.ok(difficultyAt(n + 1).fighterSpeedScale >= difficultyAt(n).fighterSpeedScale);
    }
    // Even the slowest fighter stays at or above its normal minimum, and none can exceed the limit.
    for (const n of stages) {
        const s = difficultyAt(n).fighterSpeedScale;
        assert.ok(FIGHTER_MIN_SPEED * s >= FIGHTER_MIN_SPEED);
        assert.ok(FIGHTER_MAX_SPEED * s <= FIGHTER_SPEED_LIMIT + 1e-9);
    }
});

test('DEPOTS: untouched through bridge 10, then eased down to 85% over the next ten and held there', () => {
    for (let n = 0; n <= 10; n++) assert.equal(difficultyAt(n).depotChanceScale, 1, `bridge ${n}`);
    near(difficultyAt(15).depotChanceScale, 0.925, 1e-12, 'halfway there');
    near(difficultyAt(20).depotChanceScale, 0.85, 1e-12);
    for (let n = 20; n <= 200; n++) near(difficultyAt(n).depotChanceScale, 0.85, 1e-12);
    for (let n = 0; n < 60; n++) assert.ok(difficultyAt(n + 1).depotChanceScale <= difficultyAt(n).depotChanceScale, 'never increases');
});

test('ENEMY WAVES: an extra enemy chance of 6% per bridge, up to 60%', () => {
    assert.equal(difficultyAt(0).extraEnemyChance, 0);
    near(difficultyAt(1).extraEnemyChance, 0.06, 1e-12);
    near(difficultyAt(5).extraEnemyChance, 0.3, 1e-12);
    for (let n = 10; n <= 100; n++) assert.equal(difficultyAt(n).extraEnemyChance, 0.6);
});

test('the curve helpers: a soft cap never passes its ceiling, a hard cap stops exactly on it', () => {
    for (const n of [0, 1, 10, 50]) assert.ok(softCapScale(n, 0.1, 1.5) < 1.5);
    assert.ok(softCapScale(100000, 0.1, 1.5) <= 1.5, 'far out it settles on the cap');
    assert.equal(softCapScale(5, 0, 2), 1, 'no growth, no change');
    assert.equal(softCapScale(5, 0.1, 1), 1, 'a cap of 1 means no change');
    assert.equal(hardCapScale(1000, 0.1, 1.3), 1.3);
    assert.equal(hardCapScale(0, 0.1, 1.3), 1);
});

test('the difficulty config is validated', () => {
    assert.doesNotThrow(() => validateDifficultyConfig(DEFAULT_DIFFICULTY));
    for (const bad of [
        { speedGrowth: -1 }, { speedCap: 0.9 }, { speedKnee: 1 }, { speedKnee: -0.1 }, { burnCap: 0 }, { depotThinBy: 1 }, { depotThinBy: -0.1 },
        { fighterTriggerEnd: 500 }, { fighterSpeedEnd: 300 }, { extraEnemyMax: 1.5 }, { helicopterGrowth: NaN }, { fighterRampBridges: -1 },
    ]) {
        assert.throws(() => validateDifficultyConfig({ ...DEFAULT_DIFFICULTY, ...bad }), RangeError, JSON.stringify(bad));
        assert.throws(() => new GameSession({ difficulty: bad }), RangeError, JSON.stringify(bad));
    }
});

// -------------------------------------------- maneuverability stays strictly proportional

test('the jet scales every forward and sideways limit by the same factor, at every stage', () => {
    const base = DEFAULT_JET_CONFIG;
    for (const n of stages) {
        const k = difficultyAt(n).speedScale;
        const c = scaleJetConfig(base, k);
        near(c.maxLateralSpeed / c.cruiseSpeed, base.maxLateralSpeed / base.cruiseSpeed, 1e-9, `lateral/cruise at ${n}`);
        near(c.maxLateralSpeed / c.maxSpeed, base.maxLateralSpeed / base.maxSpeed, 1e-9, `lateral/boost at ${n}`);
        near(c.maxLateralSpeed / c.minSpeed, base.maxLateralSpeed / base.minSpeed, 1e-9, `lateral/brake at ${n}`);
        near(c.lateralAcceleration / c.acceleration, base.lateralAcceleration / base.acceleration, 1e-9, `lateral accel at ${n}`);
        near(c.lateralDeceleration / c.deceleration, base.lateralDeceleration / base.deceleration, 1e-9, `lateral decel at ${n}`);
        // Time to swerve and to reach top speed are unchanged: it feels the same, only faster.
        near(c.maxLateralSpeed / c.lateralAcceleration, base.maxLateralSpeed / base.lateralAcceleration, 1e-9, `time to swerve at ${n}`);
        near((c.maxSpeed - c.cruiseSpeed) / c.acceleration, (base.maxSpeed - base.cruiseSpeed) / base.acceleration, 1e-9, `time to boost at ${n}`);
        near(c.cruiseSpeed / base.cruiseSpeed, k, 1e-12);
        near(c.maxLateralSpeed / base.maxLateralSpeed, k, 1e-12);
        for (const kept of ['width', 'height', 'worldWidth', 'maxRollDegrees', 'rollResponse', 'invulnerableSeconds', 'explosionDuration', 'stallDuration']) {
            assert.equal(c[kept], base[kept], `${kept} is not scaled`);
        }
    }
});

test('the steepest bank asks for the same share of the jet\'s sideways speed at every stage', () => {
    let steepest = 0;
    for (const seed of [1, 2, 3, 2026, 77]) {
        const world = new RiverGenerator(seed);
        let previous = world.sample(0);
        for (let y = 4; y <= 24000; y += 4) {
            const now = world.sample(y);
            steepest = Math.max(steepest, Math.abs(now.leftBankX - previous.leftBankX) / 4, Math.abs(now.rightBankX - previous.rightBankX) / 4);
            previous = now;
        }
    }
    assert.ok(steepest > 0, 'the rivers do slope');
    const demand = n => {
        const c = scaleJetConfig(DEFAULT_JET_CONFIG, difficultyAt(n).speedScale);
        return (steepest * c.cruiseSpeed) / c.maxLateralSpeed; // sideways speed needed to follow the bank at cruise, as a share of the limit
    };
    for (const n of stages) near(demand(n), demand(0), 1e-9, `stage ${n}`);
    assert.ok(demand(0) < 1, `the steepest bank (${steepest.toFixed(2)} units per unit) is followable at cruise`);
});

test('at the speed cap the autopilot still flies the whole river: cruising and at full boost, on several seeds', () => {
    const k = DEFAULT_DIFFICULTY.speedCap;
    for (const throttle of [0, 1]) {
        for (const seed of [1, 2, 3, 2026]) {
            const g = headlessGame({
                seed, script: bot({ throttle }),
                game: { ...rich, startLives: 1, jet: scaleJetConfig(DEFAULT_JET_CONFIG, k) },
            });
            g.run(30);
            assert.equal(g.session.gameOver, false, `seed ${seed}, throttle ${throttle}: lost the jet to ${g.session.jet.deathCause} at ${g.session.jet.y.toFixed(0)}`);
            assert.ok(g.session.jet.y > 8000, 'and it really did cover the ground');
        }
    }
});

test('a jet at the speed cap cannot tunnel through anything in a single step', () => {
    const topStep = DEFAULT_JET_CONFIG.maxSpeed * DEFAULT_DIFFICULTY.speedCap * DT;
    assert.ok(topStep < DEFAULT_JET_CONFIG.height, `${topStep.toFixed(1)} units per tick is less than the jet's own length (${DEFAULT_JET_CONFIG.height})`);
    assert.ok(FIGHTER_SPEED_LIMIT * DT < 22, 'nor can the fastest fighter pass through a jet');
});

// ------------------------------------------------------------------- jet and fuel units

test('PlayerJet: scale in, scale out, and the current speed is left to ease', () => {
    const jet = new PlayerJet();
    assert.equal(jet.speedScale, 1);
    assert.equal(jet.config, jet.baseConfig, 'unscaled it is the very same object');
    jet.setSpeedScale(1.5);
    assert.equal(jet.config.cruiseSpeed, 330);
    assert.equal(jet.baseConfig.cruiseSpeed, 220, 'the base is never touched');
    assert.equal(jet.speed, 220, 'speed does not jump');
    jet.update(DT, { moveX: 0, moveY: 0, enginePowered: true });
    assert.ok(jet.speed > 220 && jet.speed <= 220 + 360 * 1.5 * DT + 1e-9, 'it accelerates at the new, proportionally larger rate');
    jet.spawn(480, 0);
    assert.equal(jet.speed, 330, 'a fresh jet starts at the scaled cruise');
    jet.setSpeedScale(1);
    assert.equal(jet.config.cruiseSpeed, 220);
    for (const bad of [0, -1, NaN, Infinity]) assert.throws(() => jet.setSpeedScale(bad), RangeError, String(bad));
    assert.equal(jet.speedScale, 1, 'a refused change changes nothing');
});

test('PlayerJet: the engine-out glide scales too, so a stall lasts as long as before', () => {
    const slow = new PlayerJet();
    const fast = new PlayerJet();
    fast.setSpeedScale(1.8);
    for (const jet of [slow, fast]) jet.spawn(480, 0);
    const lose = jet => {
        const start = jet.speed;
        jet.update(0.25, { moveX: 0, moveY: 0, enginePowered: false });
        return (start - jet.speed) / start;
    };
    near(lose(fast), lose(slow), 1e-9);
});

test('FuelSystem: the burn scale multiplies every burn rate but not refuelling', () => {
    const fuel = new FuelSystem();
    assert.equal(fuel.burnScale, 1);
    const base = [-1, 0, 1].map(t => fuel.burnRate(t));
    fuel.setBurnScale(1.4);
    [-1, 0, 1].forEach((t, i) => near(fuel.burnRate(t), (base[i] ?? 0) * 1.4, 1e-12));
    fuel.setLevel(50);
    fuel.update(1, { throttle: 0, refueling: false });
    near(fuel.level, 50 - 2.2 * 1.4, 1e-9);
    fuel.setLevel(10);
    const gain = fuel.update(1, { throttle: 0, refueling: true });
    near(gain.refueled, 28, 1e-9, 'refuelling is as fast as ever');
    for (const bad of [0, -1, NaN]) assert.throws(() => fuel.setBurnScale(bad), RangeError);
});

// ------------------------------------------------------------- the session, end to end

test('CAMPAIGN is untouched: a bridge falls and nothing gets faster, hungrier or stricter', () => {
    const g = headlessGame({ script: bot(), game: { startY: 2800, mode: 'campaign', ...rich } });
    assert.equal(g.runUntil(h => h.of('stage-clear').length > 0, 60), true);
    assert.equal(g.session.stage, 1);
    assert.equal(g.session.jet.speedScale, 1);
    assert.equal(g.session.fuel.burnScale, 1);
    assert.deepEqual(g.session.difficulty, CAMPAIGN_DIFFICULTY);
    assert.doesNotMatch(g.session.notices.find(n => n.kind === 'stage-clear').subtitle, /SPEED/);
});

test('ENDLESS: destroying a bridge makes the jet, the fuel and the banner one stage harder', () => {
    const g = headlessGame({ script: bot(), game: { startY: 2800, mode: 'endless', ...rich } });
    assert.equal(g.session.jet.speedScale, 1, 'bridge 0 is the plain game');
    assert.equal(g.runUntil(h => h.of('stage-clear').length > 0, 60), true);
    const p = difficultyAt(1);
    const jet = g.session.jet;
    assert.equal(g.session.difficulty.stage, 1);
    near(jet.speedScale, p.speedScale, 1e-12);
    near(jet.config.cruiseSpeed, 220 * p.speedScale, 1e-9);
    near(jet.config.maxLateralSpeed, 380 * p.speedScale, 1e-9);
    near(jet.config.maxLateralSpeed / jet.config.cruiseSpeed, 380 / 220, 1e-12, 'maneuverability scaled with speed');
    near(g.session.fuel.burnScale, 1.025, 1e-12);
    near(g.session.fuel.burnRate(0), 2.2 * 1.025, 1e-12);
    const banner = g.session.notices.find(n => n.kind === 'stage-clear');
    assert.match(banner.subtitle, /\+500/);
    assert.match(banner.subtitle, /SPEED \+3\.5%/);
});

test('ENDLESS: the scroll never jolts when a bridge falls: speed changes by at most the (scaled) acceleration each tick', () => {
    const g = headlessGame({ script: bot(), game: { startY: 2800, mode: 'endless', ...rich } });
    let previous = g.session.jet.speed;
    let worst = 0;
    for (let i = 0; i < 60 * 12; i++) {
        g.engine.runFrame(DT);
        const speed = g.session.jet.speed;
        worst = Math.max(worst, Math.abs(speed - previous));
        previous = speed;
    }
    assert.ok(g.session.stage >= 1, 'a bridge fell during the run');
    assert.ok(worst <= 480 * 1.1 * DT + 1e-9, `largest per-tick change ${worst.toFixed(2)}`);
});

test('ENDLESS: the speed keeps climbing bridge after bridge, in step with the formula', () => {
    const g = headlessGame({
        seed: 2026, script: bot(), game: { startY: 3200 - 500, mode: 'endless', startLives: 20, ...rich },
    });
    const seen = new Map();
    for (let i = 0; i < 60 * 150 && g.session.stage < 9; i++) {
        g.engine.runFrame(DT);
        seen.set(g.session.stage, g.session.jet.speedScale);
    }
    assert.ok(g.session.stage >= 9, `reached ${g.session.stage}`);
    for (const [stage, scale] of seen) near(scale, difficultyAt(stage).speedScale, 1e-12, `stage ${stage}`);
    const values = [...seen.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
    for (let i = 1; i < values.length; i++) assert.ok((values[i] ?? 0) > (values[i - 1] ?? 0));
});

test('a restart is stage 0 again: speed, burn and the jet\'s cruise are back to normal', () => {
    const g = headlessGame({ script: bot(), game: { startY: 2800, mode: 'endless', ...rich } });
    g.runUntil(h => h.of('stage-clear').length > 0, 60);
    assert.ok(g.session.jet.speedScale > 1);
    g.engine.reset(2026);
    assert.equal(g.session.stage, 0);
    assert.equal(g.session.jet.speedScale, 1);
    assert.equal(g.session.fuel.burnScale, 1);
    assert.equal(g.session.jet.speed, 220);
    assert.deepEqual(g.session.difficulty, CAMPAIGN_DIFFICULTY);
});

test('switching modes mid-run applies and removes the difficulty at once', () => {
    const g = headlessGame({ script: bot(), game: { startY: 2800, mode: 'endless', ...rich } });
    g.runUntil(h => h.of('stage-clear').length > 0, 60);
    const scaled = g.session.jet.speedScale;
    assert.ok(scaled > 1);
    g.session.setMode('campaign');
    assert.equal(g.session.jet.speedScale, 1);
    assert.equal(g.session.fuel.burnScale, 1);
    g.session.setMode('endless');
    near(g.session.jet.speedScale, scaled, 1e-12, 'back to where the bridges left it');
});

test('a jet that respawns after a crash comes back at the current stage\'s cruise speed', () => {
    let crash = false;
    const g = headlessGame({
        script: (f, h) => (crash ? { moveX: -1, moveY: 0, fire: false } : bot()(f, h)),
        game: { startY: 2800, mode: 'endless', startLives: 5, ...rich },
    });
    g.runUntil(h => h.of('stage-clear').length > 0, 60);
    const p = difficultyAt(g.session.stage);
    crash = true;
    assert.equal(g.runUntil(h => h.of('respawn').length > 0, 30), true);
    crash = false;
    near(g.session.jet.speed, 220 * p.speedScale, 1e-9);
    assert.equal(g.session.jet.config.cruiseSpeed, g.session.jet.speed);
});

test('without bridges destroyed there is no difficulty at all, even in endless', () => {
    const g = headlessGame({ script: bot(), game: { mode: 'endless', ...rich } });
    g.run(8); // the first bridge is still ahead
    assert.equal(g.session.stage, 0);
    assert.deepEqual(g.session.difficulty, CAMPAIGN_DIFFICULTY);
});

test('the difficulty tuning can be overridden per game, and is validated', () => {
    const g = headlessGame({ script: bot(), game: { startY: 2800, mode: 'endless', difficulty: { speedGrowth: 0.1, burnGrowth: 0.2 }, ...rich } });
    g.runUntil(h => h.of('stage-clear').length > 0, 60);
    near(g.session.jet.speedScale, 1.1, 1e-12);
    near(g.session.fuel.burnScale, 1.2, 1e-12);
});

// ------------------------------------------------------------------------ the layout

function spawners(seed, { endless = false, config = {} } = {}) {
    const world = new RiverGenerator(seed);
    const depots = new DepotSpawner(world);
    const enemies = new EnemySpawner(world, depots, config);
    if (endless) {
        depots.setChanceScale(y => difficultyAt(world.stageAt(y)).depotChanceScale);
        enemies.setDifficulty(stage => difficultyAt(stage));
    }
    return { world, depots, enemies };
}
const regular = p => p.id % 4 !== 2;
const extra = p => p.id % 4 === 2;
const SPAN = 3200 * 26;

test('the river knows its stage: bridges every 3200 units', () => {
    const world = new RiverGenerator(1);
    assert.equal(world.bridgeInterval, 3200);
    assert.equal(world.stageAt(0), 0);
    assert.equal(world.stageAt(3199), 0);
    assert.equal(world.stageAt(3200), 1);
    assert.equal(world.stageAt(32000), 10);
    assert.equal(world.stageAt(-5), 0);
    assert.equal(world.stageAt(NaN), 0);
    for (const y of [0, 700, 3199, 3200, 9000, 25000]) assert.equal(world.stageAt(y), world.getSectionAt(y).stage, `agrees with the section at ${y}`);
});

test('clearing the difficulty gives back the campaign layout exactly', () => {
    for (const seed of [1, 2026]) {
        const plain = spawners(seed);
        const toggled = spawners(seed, { endless: true });
        toggled.enemies.setDifficulty(null);
        toggled.depots.setChanceScale(null);
        assert.deepEqual(toggled.enemies.placementsIn(0, SPAN), plain.enemies.placementsIn(0, SPAN));
        for (let slot = 0; slot < 400; slot++) assert.deepEqual(toggled.depots.place(slot), plain.depots.place(slot));
    }
});

test('endless enemies are the campaign enemies, only faster and with extras added: nothing is moved or removed', () => {
    let freed = 0;
    for (const seed of [1, 2, 3, 2026]) {
        const base = spawners(seed).enemies.placementsIn(0, SPAN);
        const hard = spawners(seed, { endless: true }).enemies.placementsIn(0, SPAN);
        const hardRegular = new Map(hard.filter(regular).map(p => [p.id, p]));
        for (const p of base) {
            const q = hardRegular.get(p.id);
            assert.ok(q, `enemy ${p.id} is still there`);
            assert.deepEqual([q.kind, q.x, q.y, q.stage], [p.kind, p.x, p.y, p.stage], `enemy ${p.id} has not moved`);
            // Before bridge 10 nothing about the regular enemies differs at all. From there depots are thinned,
            // which can free the first helicopter of a pair that was refused, and the second then patrols the
            // opposite way to it: the only thing that can change.
            if (p.stage < 10) assert.equal(q.direction, p.direction, `enemy ${p.id} keeps its heading`);
            hardRegular.delete(p.id);
        }
        // The only others are enemies that used to be refused for being too near a depot, and only
        // where depots have been thinned out (bridge 10 on): fewer depots, more room.
        for (const q of hardRegular.values()) {
            assert.ok(q.stage >= 10, `seed ${seed}: a new regular enemy at stage ${q.stage} must come from a thinned depot`);
            freed++;
        }
    }
    assert.ok(freed >= 0);
});

test('endless helicopters sweep faster by the stage\'s factor, never past the limit', () => {
    let checked = 0;
    for (const seed of [1, 2, 3, 2026]) {
        const base = new Map(spawners(seed).enemies.placementsIn(0, SPAN).map(p => [p.id, p]));
        for (const q of spawners(seed, { endless: true }).enemies.placementsIn(0, SPAN).filter(regular)) {
            if (q.kind !== 'helicopter') continue;
            const p = base.get(q.id);
            if (!p) continue; // freed by a thinned depot: no campaign twin to compare with
            const expected = Math.min(HELICOPTER_SPEED_LIMIT, p.speed * difficultyAt(p.stage).helicopterSpeedScale);
            near(q.speed, expected, 1e-9, `helicopter ${q.id} at stage ${p.stage}`);
            assert.ok(q.speed >= p.speed && q.speed <= HELICOPTER_SPEED_LIMIT);
            checked++;
        }
    }
    assert.ok(checked > 30, `checked ${checked} helicopters`);
});

test('endless fighters launch from further away and streak faster, within the limits', () => {
    let checked = 0;
    let beyond600 = 0;
    for (const seed of [1, 2, 3, 2026, 77, 9]) {
        const base = new Map(spawners(seed).enemies.placementsIn(0, SPAN).map(p => [p.id, p]));
        for (const q of spawners(seed, { endless: true }).enemies.placementsIn(0, SPAN).filter(regular)) {
            if (q.kind !== 'fighter') continue;
            const p = base.get(q.id);
            if (!p) continue;
            const profile = difficultyAt(p.stage);
            near(q.triggerDistance - p.triggerDistance, profile.fighterTrigger - FIGHTER_TRIGGER_DISTANCE, 1e-9, 'the whole envelope moves');
            assert.ok(q.triggerDistance >= profile.fighterTrigger - 60 - 1e-9 && q.triggerDistance <= profile.fighterTrigger + 60 + 1e-9);
            near(q.speed, Math.min(FIGHTER_SPEED_LIMIT, p.speed * profile.fighterSpeedScale), 1e-9);
            assert.ok(q.speed >= FIGHTER_MIN_SPEED && q.speed <= FIGHTER_SPEED_LIMIT);
            if (q.triggerDistance > 660) beyond600++;
            checked++;
        }
    }
    assert.ok(checked > 20, `checked ${checked} fighters`);
    assert.ok(beyond600 > 5, 'late fighters really do launch from beyond the old 600 envelope');
});

test('endless adds extra enemies only after the first bridge, more of them as the bridges go by, and they close the gaps', () => {
    let early = 0;
    let late = 0;
    let meanGapBase = 0;
    let meanGapHard = 0;
    const mean = list => list.reduce((s, v) => s + v, 0) / Math.max(1, list.length);
    for (const seed of [1, 2, 3, 2026, 77, 9]) {
        const hard = spawners(seed, { endless: true }).enemies.placementsIn(0, SPAN);
        const extras = hard.filter(extra);
        early += extras.filter(p => p.stage === 0).length;
        late += extras.filter(p => p.stage >= 8).length;
        for (const p of extras) assert.ok(p.kind === 'helicopter' || p.kind === 'patrol-boat', 'extras are boats and helicopters');
        // Average gap between neighbouring enemies in the late stages.
        const inRange = list => list.filter(p => p.y >= 3200 * 8 && p.y < 3200 * 24).map(p => p.y).sort((a, b) => a - b);
        const gaps = list => list.slice(1).map((y, i) => y - (list[i] ?? 0));
        const b = gaps(inRange(spawners(seed).enemies.placementsIn(0, SPAN)));
        const h = gaps(inRange(hard));
        meanGapBase += mean(b);
        meanGapHard += mean(h);
        assert.ok(h.length > b.length, `seed ${seed}: more enemies in the late river`);
        assert.ok(mean(h) < mean(b), `seed ${seed}: neighbouring enemies are closer together (${mean(h).toFixed(0)} vs ${mean(b).toFixed(0)})`);
    }
    assert.equal(early, 0, 'stage 0 gets no extras');
    assert.ok(late > 40, `late extras: ${late}`);
    assert.ok(meanGapHard < meanGapBase * 0.85, `the average gap shrinks by at least 15% (${meanGapHard.toFixed(0)} vs ${meanGapBase.toFixed(0)})`);
});

test('an extra enemy never sits on top of a regular one from its own slot, and always has water under it', () => {
    let checked = 0;
    for (const seed of [1, 2, 3, 2026]) {
        const { world, enemies } = spawners(seed, { endless: true });
        const all = enemies.placementsIn(0, SPAN);
        for (const e of all.filter(extra)) {
            const slot = Math.floor(e.id / 4);
            for (const r of enemies.place(slot).filter(regular)) assert.ok(Math.abs(r.y - e.y) >= 45, `slot ${slot}: extra and regular are ${Math.abs(r.y - e.y).toFixed(0)} apart`);
            const body = createEnemy(e);
            assert.equal(boxTouchesLand(world, { x: e.x, y: e.y, width: body.width, height: body.height }), false, `extra ${e.id} is in open water`);
            assert.equal(world.findBridges(e.y - 150, e.y + 150).length, 0, `extra ${e.id} keeps clear of bridges`);
            checked++;
        }
    }
    assert.ok(checked > 30, `checked ${checked} extras`);
});

test('every enemy the endless layout makes can actually be built (no speed out of range)', () => {
    let built = 0;
    for (const seed of [1, 2, 3, 2026, 77, 9, 123, 456]) {
        for (const p of spawners(seed, { endless: true }).enemies.placementsIn(0, 3200 * 60)) {
            assert.doesNotThrow(() => createEnemy(p), `seed ${seed} placement ${p.id}`);
            built++;
        }
    }
    assert.ok(built > 500, `built ${built}`);
});

test('the endless layout is still a pure function of the seed: same every time, in any order', () => {
    const a = spawners(2026, { endless: true });
    const b = spawners(2026, { endless: true });
    const forward = [];
    for (let slot = 0; slot < 300; slot++) forward.push(a.enemies.place(slot));
    const backward = [];
    for (let slot = 299; slot >= 0; slot--) backward.unshift(b.enemies.place(slot));
    assert.deepEqual(backward, forward);
    assert.deepEqual(spawners(2026, { endless: true }).enemies.placementsIn(0, SPAN), a.enemies.placementsIn(0, SPAN));
});

test('turning the armada off turns the extras off too', () => {
    const off = spawners(2026, { endless: true, config: { enabled: false } });
    assert.deepEqual(off.enemies.placementsIn(0, SPAN), []);
});

test('DEPOTS: endless only ever removes depots, from bridge 10 on; the rest are exactly where they were', () => {
    let baseLate = 0;
    let hardLate = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 2026, 77, 123, 999]) {
        const base = spawners(seed);
        const hard = spawners(seed, { endless: true });
        for (let slot = 0; slot < 4000; slot++) {
            const b = base.depots.place(slot);
            const h = hard.depots.place(slot);
            if (h) assert.deepEqual(h, b, `seed ${seed} slot ${slot}: a surviving depot is where it was`);
            if (!b) assert.equal(h, null, 'and none is invented');
            const stage = base.world.stageAt(slot * 520);
            if (stage <= 9) assert.deepEqual(h, b, `stage ${stage}: no thinning before bridge 10`);
            if (stage >= 21) {
                if (b) baseLate++;
                if (h) hardLate++;
            }
        }
    }
    assert.ok(baseLate > 1500, `baseline depots in the late river: ${baseLate}`);
    const share = hardLate / baseLate;
    assert.ok(share > 0.8 && share < 0.9, `about 85% remain (${(share * 100).toFixed(1)}%)`);
});

test('DEPOTS: the scale is clamped to 0-1, so a bad function cannot add depots or break the layout', () => {
    const world = new RiverGenerator(2026);
    const depots = new DepotSpawner(world);
    const base = Array.from({ length: 200 }, (_, i) => depots.place(i));
    depots.setChanceScale(() => 7);
    assert.deepEqual(Array.from({ length: 200 }, (_, i) => depots.place(i)), base, 'above 1 is just 1');
    depots.setChanceScale(() => -3);
    assert.ok(Array.from({ length: 200 }, (_, i) => depots.place(i)).every(p => p === null), 'below 0 is just 0');
    depots.setChanceScale(null);
    assert.deepEqual(Array.from({ length: 200 }, (_, i) => depots.place(i)), base);
});

test('a game that streams the endless river in plays out: enemies and depots appear at their stage, and the run is deterministic', () => {
    const run = () => {
        const g = headlessGame({
            seed: 2026, script: bot({ throttle: 0 }),
            game: { startY: 3200 * 8, mode: 'endless', startLives: 99, fuel: { capacity: 1e9, startLevel: 1e9 }, enemies: {} },
        });
        g.run(25);
        return { score: g.session.score, y: g.session.jet.y, stage: g.session.stage, kills: { ...g.session.progression.kills } };
    };
    const first = run();
    assert.deepEqual(run(), first, 'same seed, same inputs, same result');
    assert.ok(first.y > 3200 * 8, 'it flew on');
});
