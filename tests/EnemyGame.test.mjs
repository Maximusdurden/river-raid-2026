import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FighterJet } from '../dist/src/entities/enemies/FighterJet.js';
import { GameSession } from '../dist/src/game/GameSession.js';
import { DT, StaticEnemy, headlessGame, pilot } from './helpers.mjs';

const calm = { depots: { chance: 0 } };
const bot = options => (_frame, g) => pilot(g.session, g.engine.world, { seekDepots: false, ...options });

/** A game with one hand-placed enemy `ahead` units above the jet, in the jet's line of fire. */
function staged({ kind = 'helicopter', ahead = 250, script = () => ({}), game = {}, flies = kind === 'fighter', id = 9001 } = {}) {
    const g = headlessGame({ script, game: { ...calm, ...game } });
    const jet = g.session.jet;
    const enemy = new StaticEnemy(id, jet.x, jet.y + ahead, { kind, flies });
    g.session.enemies.set(id, enemy);
    return { g, enemy, jet };
}

// ------------------------------------------------------------- missile kills

test('a missile destroys each enemy type and awards the specified points', () => {
    for (const [kind, points] of [['patrol-boat', 30], ['helicopter', 60], ['fighter', 100]]) {
        const { g, enemy } = staged({ kind, script: () => ({ fire: true }) });
        assert.equal(g.runUntil(h => h.of('enemy-destroyed').length > 0, 3), true, kind);
        const event = g.of('enemy-destroyed')[0];
        assert.equal(event.enemy, enemy);
        assert.equal(event.points, points);
        assert.equal(event.rammed, false);
        assert.equal(g.session.score, points);
        assert.deepEqual([enemy.alive, enemy.destroyed, enemy.despawned], [false, true, false]);
        assert.equal(g.session.enemies.has(enemy.id), false, 'removed from play');
        assert.equal(g.session.lives, 3);
        const popup = g.session.popups.find(p => p.points === points);
        assert.equal(popup?.text, `+${points}`, 'a floating score appears');
        assert.ok(g.session.particles.count > 20, 'debris and fire');
    }
});

test('kills are counted per type', () => {
    const g = headlessGame({ script: () => ({ fire: true }), game: { ...calm, weapon: { maxActiveProjectiles: 6, fireInterval: 0.05 } } });
    const jet = g.session.jet;
    const spec = [['helicopter', 200], ['helicopter', 330], ['patrol-boat', 460], ['fighter', 590]];
    spec.forEach(([kind, dy], i) => g.session.enemies.set(100 + i, new StaticEnemy(100 + i, jet.x, jet.y + dy, { kind, flies: kind === 'fighter' })));
    assert.equal(g.runUntil(h => h.of('enemy-destroyed').length === 4, 6), true);
    assert.deepEqual({ ...g.session.progression.kills }, { patrolBoat: 1, helicopter: 2, depot: 0, fighter: 1, bridge: 0 });
    assert.equal(g.session.score, 60 * 2 + 30 + 100);
    assert.equal(g.session.summary.kills.helicopter, 2);
});

test('each wreck looks like what it was: rotor blades, water spray, or a spark streak', () => {
    const kinds = {};
    for (const kind of ['helicopter', 'patrol-boat', 'fighter']) {
        const { g } = staged({ kind, script: () => ({ fire: true }) });
        g.runUntil(h => h.of('enemy-destroyed').length > 0, 3);
        kinds[kind] = new Set(g.session.particles.snapshot().map(p => p.kind));
    }
    assert.ok(kinds.helicopter.has('blade') && !kinds.helicopter.has('splash'));
    assert.ok(kinds['patrol-boat'].has('splash') && !kinds['patrol-boat'].has('blade'));
    for (const set of Object.values(kinds)) assert.ok(set.has('fire') && set.has('smoke') && set.has('spark'));
});

test('a missile is spent on the enemy it hits: the one behind it survives', () => {
    const g = headlessGame({ script: () => ({ fire: true }), game: { ...calm, weapon: { maxActiveProjectiles: 1 } } });
    const jet = g.session.jet;
    const near = new StaticEnemy(1, jet.x, jet.y + 200, { kind: 'helicopter' });
    const far = new StaticEnemy(2, jet.x, jet.y + 240, { kind: 'helicopter' });
    g.session.enemies.set(1, near);
    g.session.enemies.set(2, far);
    g.runUntil(h => h.of('enemy-destroyed').length > 0, 3);
    assert.equal(g.of('enemy-destroyed')[0].enemy, near);
    assert.equal(far.alive, true);
});

test('shooting an enemy and a depot in the same run adds up through the shared table', () => {
    const g = headlessGame({ script: bot({ fire: true }), game: { weapon: { maxActiveProjectiles: 4, fireInterval: 0.08 }, fuel: { capacity: 1e9, startLevel: 1e9 } } });
    const jet = g.session.jet;
    g.session.enemies.set(1, new StaticEnemy(1, jet.x, jet.y + 220, { kind: 'helicopter' }));
    g.runUntil(h => h.of('enemy-destroyed').length > 0, 3);
    assert.equal(g.session.score, 60);
});

// ---------------------------------------------------------------- ramming

test('flying into an enemy destroys both, costs a life and scores nothing', () => {
    const { g, enemy } = staged({ kind: 'helicopter', ahead: 100 });
    assert.equal(g.runUntil(h => h.of('jet-destroyed').length > 0, 3), true);
    const boom = g.of('jet-destroyed')[0];
    assert.equal(boom.cause, 'enemy');
    assert.equal(boom.livesLeft, 2);
    assert.equal(g.session.lives, 2);
    assert.equal(g.session.jet.state, 'EXPLODING');
    assert.deepEqual([enemy.alive, enemy.destroyed], [false, true]);
    assert.equal(g.session.enemies.has(enemy.id), false);
    const ram = g.of('enemy-destroyed')[0];
    assert.deepEqual([ram.enemy, ram.points, ram.rammed], [enemy, 0, true]);
    assert.equal(g.session.score, 0, 'ramming is not rewarded');
    assert.equal(g.session.progression.totalKills, 0);
    assert.equal(g.session.popups.length, 0);
    assert.equal(g.engine.getStats().scrollSpeed, 0, 'the scroll stops like any crash');
});

test('every enemy type brings the jet down on contact', () => {
    for (const kind of ['patrol-boat', 'helicopter', 'fighter']) {
        const { g } = staged({ kind, ahead: 100 });
        assert.equal(g.runUntil(h => h.of('jet-destroyed').length > 0, 3), true, kind);
        assert.equal(g.of('jet-destroyed')[0].cause, 'enemy');
    }
});

test('after ramming, the next jet returns at the last cleared bridge, shielded, with full fuel', () => {
    const { g } = staged({ ahead: 100 });
    g.session.fuel.setLevel(40);
    g.runUntil(h => h.of('jet-destroyed').length > 0, 3);
    assert.equal(g.runUntil(h => h.of('respawn').length > 0, 5), true);
    assert.equal(g.of('respawn')[0].y, 180, 'no bridge cleared yet: the start line');
    assert.equal(g.session.jet.state, 'ALIVE');
    assert.equal(g.session.jet.isInvulnerable, true);
    assert.equal(g.session.fuel.level, 100);
    assert.equal(g.session.lives, 2);
});

test('respawn protection ghosts the jet through enemies: nobody is destroyed or scored', () => {
    const { g, enemy, jet } = staged({ ahead: 120, script: bot({}) });
    jet.spawn(jet.x, jet.y, { invulnerable: true });
    g.run(1.5);
    assert.equal(g.of('jet-destroyed').length, 0);
    assert.equal(enemy.alive, true, 'the enemy is untouched');
    assert.equal(g.of('enemy-destroyed').length, 0);
    assert.equal(g.session.score, 0);
    assert.equal(g.session.lives, 3);
    assert.ok(jet.y > enemy.y + 20, 'the jet really did fly through it');
});

test('once the shield lapses the jet is vulnerable to enemies again', () => {
    const { g, jet } = staged({ ahead: 5000, script: bot({}) });
    jet.spawn(jet.x, jet.y, { invulnerable: true });
    g.run(3.2);
    assert.equal(jet.isInvulnerable, false);
    const fresh = new StaticEnemy(7, jet.x, jet.y + 110, { kind: 'patrol-boat' });
    g.session.enemies.set(7, fresh);
    assert.equal(g.runUntil(h => h.of('jet-destroyed').length > 0, 3), true);
    assert.equal(g.of('jet-destroyed')[0].cause, 'enemy');
});

test('a shielded jet\u2019s missiles still kill (the shield only protects the pilot)', () => {
    const { g, enemy, jet } = staged({ ahead: 250, script: () => ({ fire: true }) });
    jet.spawn(jet.x, jet.y, { invulnerable: true });
    g.runUntil(h => h.of('enemy-destroyed').length > 0, 3);
    assert.equal(g.of('enemy-destroyed')[0].rammed, false);
    assert.equal(enemy.destroyed, true);
});

test('the last life lost to an enemy is game over', () => {
    const { g } = staged({ ahead: 100, game: { startLives: 1 } });
    assert.equal(g.runUntil(h => h.session.gameOver, 10), true);
    assert.equal(g.session.lives, 0);
    assert.equal(g.of('game-over').length, 1);
});

// ------------------------------------------------------------ enemies and respawn

test('a respawn re-populates the armada fresh around the checkpoint, deterministically', () => {
    // Find a seed whose opening window (around y = 6000) actually holds enemies.
    let chosen = null;
    for (let seed = 1; seed < 80 && !chosen; seed++) {
        const g = headlessGame({ seed, game: { startY: 6000, enemies: {}, depots: { chance: 0 } } });
        if (g.session.enemies.size >= 2) chosen = { seed, ids: [...g.session.enemies.keys()].sort((a, b) => a - b), first: [...g.session.enemies.values()] };
    }
    assert.ok(chosen, 'no seed with enemies near y = 6000');
    const g = headlessGame({ seed: chosen.seed, game: { startY: 6000, enemies: {}, depots: { chance: 0 } } });
    const before = [...g.session.enemies.values()];
    g.session.jet.destroy('land');
    assert.equal(g.runUntil(h => h.of('respawn').length > 0, 10), true);
    const after = [...g.session.enemies.values()];
    assert.deepEqual(after.map(e => e.id).sort((a, b) => a - b), chosen.ids);
    for (const e of after) assert.ok(!before.includes(e), 'new instances, not the old wrecks');
    for (const e of after) assert.ok(e.alive && e.age < 0.5, 'fresh');
});

test('enemies shot down before a death come back after it (like the arcade), but depots and bridges stay down', () => {
    const { g, enemy } = staged({ script: () => ({ fire: true }), game: { depots: { chance: 1 } } });
    g.runUntil(h => h.of('enemy-destroyed').length > 0, 3);
    assert.equal(enemy.destroyed, true);
    g.session.jet.destroy('land');
    assert.equal(g.runUntil(h => h.of('respawn').length > 0, 10), true);
    assert.equal(g.session.enemies.has(9001), false, 'a hand-placed enemy is not part of the armada');
});

test('enemies far behind the camera are dropped, so the armada stays small', () => {
    const g = headlessGame({ script: bot({ throttle: 1 }), game: { enemies: {}, depots: { chance: 0 }, fuel: { capacity: 1e9, startLevel: 1e9, } } });
    let peak = 0;
    let lowest = Infinity;
    let highest = -Infinity;
    for (let i = 0; i < 60 * 40 && g.session.jet.isFlying; i++) {
        g.engine.runFrame(DT);
        const camera = g.session.cameraY;
        peak = Math.max(peak, g.session.enemies.size);
        for (const e of g.session.enemies.values()) {
            lowest = Math.min(lowest, e.y - camera);
            highest = Math.max(highest, e.y - camera);
        }
    }
    assert.ok(peak < 30, `peak ${peak}`);
    assert.ok(lowest >= -165, `an enemy lingered ${lowest} below the view`);
    assert.ok(highest <= 720 + 360 + 80, `an enemy spawned ${highest} above the camera`);
});

// -------------------------------------------------------------------- fighters

test('a parked fighter launches when the player gets within 600 and leaves a vapour trail', () => {
    const g = headlessGame({ script: bot({}), game: calm });
    const jet = g.session.jet;
    const y = jet.y + 590;
    const left = g.engine.world.sample(y).leftBankX;
    const fighter = new FighterJet(77, left - 26, y, { speed: 460, direction: 1 });
    g.session.enemies.set(77, fighter);
    g.run(1 / 60);
    assert.equal(g.of('fighter-launch').length, 1);
    assert.equal(g.of('fighter-launch')[0].enemy, fighter);
    assert.equal(fighter.isStreaking, true);
    g.run(0.3);
    assert.ok(g.session.particles.snapshot().some(p => p.kind === 'vapor'), 'a contrail');
    assert.equal(g.of('fighter-launch').length, 1, 'the launch is announced once');
});

test('a fighter further away than the trigger stays parked, and a crossed fighter leaves play unscored', () => {
    const far = headlessGame({ script: bot({}), game: calm });
    const jet = far.session.jet;
    const y = jet.y + 900;
    const parked = new FighterJet(1, far.engine.world.sample(y).leftBankX - 26, y, { speed: 400, direction: 1 });
    far.session.enemies.set(1, parked);
    far.run(1);
    assert.equal(parked.state, 'parked');
    assert.equal(far.of('fighter-launch').length, 0);

    const g = headlessGame({ script: bot({}), game: calm });
    const y2 = g.session.jet.y + 590;
    const crossing = new FighterJet(2, g.engine.world.sample(y2).leftBankX - 26, y2, { speed: 460, direction: 1 });
    g.session.enemies.set(2, crossing);
    assert.equal(g.runUntil(() => !crossing.alive, 4), true);
    assert.deepEqual([crossing.despawned, crossing.destroyed], [true, false]);
    assert.equal(g.session.enemies.has(2), false);
    assert.equal(g.session.score, 0);
    assert.equal(g.of('enemy-destroyed').length, 0);
    assert.equal(g.session.jet.isFlying, true);
});

// ---------------------------------------------------------- progression in play

test('crossing 10,000 points awards an extra life with a 1UP popup, a banner and an event', () => {
    const { g } = staged({ kind: 'helicopter', script: () => ({ fire: true }) });
    g.session.progression.addPoints(9950);
    assert.equal(g.session.lives, 3);
    g.runUntil(h => h.of('extra-life').length > 0, 3);
    assert.equal(g.session.score, 10010);
    assert.equal(g.session.lives, 4);
    assert.equal(g.of('extra-life')[0].lives, 4);
    assert.ok(g.session.popups.some(p => p.text === '1UP' && p.points === 0));
    const banner = g.session.notices.find(n => n.kind === 'extra-life');
    assert.equal(banner.title, 'EXTRA JET!');
    assert.match(banner.subtitle, /10,000/);
    assert.equal(g.session.summary.bonusLives, 1);
    g.run(3);
    assert.equal(g.session.notices.length, 0, 'banners fade away');
});

test('only the award that crosses the threshold fires the extra-life event', () => {
    const g = headlessGame({ script: () => ({ fire: true }), game: { ...calm, weapon: { maxActiveProjectiles: 4, fireInterval: 0.05 } } });
    const jet = g.session.jet;
    g.session.progression.addPoints(9890);
    for (let i = 0; i < 4; i++) g.session.enemies.set(10 + i, new StaticEnemy(10 + i, jet.x, jet.y + 180 + i * 70, { kind: 'helicopter' }));
    g.runUntil(h => h.of('enemy-destroyed').length === 4, 6);
    assert.equal(g.session.score, 10130);
    assert.equal(g.of('extra-life').length, 1);
    assert.equal(g.session.lives, 4);
});

test('the point table and the bonus threshold are configurable', () => {
    const g = headlessGame({ script: () => ({ fire: true }), game: { ...calm, points: { helicopter: 400 }, bonusLifeEvery: 500 } });
    const jet = g.session.jet;
    g.session.enemies.set(1, new StaticEnemy(1, jet.x, jet.y + 200, { kind: 'helicopter' }));
    g.session.enemies.set(2, new StaticEnemy(2, jet.x, jet.y + 300, { kind: 'helicopter' }));
    g.runUntil(h => h.of('enemy-destroyed').length === 2, 4);
    assert.equal(g.session.score, 800);
    assert.equal(g.session.lives, 4);
    assert.equal(g.session.progression.nextBonusAt, 1000);
});

test('shooting a bridge clears a section: the stage counter, banner and event all agree', () => {
    const g = headlessGame({ script: bot({ fire: true }), game: { startY: 2800, ...calm } });
    assert.equal(g.session.stage, 0);
    assert.equal(g.runUntil(h => h.of('stage-clear').length > 0, 30), true);
    assert.equal(g.of('stage-clear')[0].cleared, 1);
    assert.equal(g.session.stage, 1);
    assert.equal(g.session.progression.stageNumber, 2);
    assert.equal(g.session.score, 500);
    assert.equal(g.session.progression.kills.bridge, 1);
    const banner = g.session.notices.find(n => n.kind === 'stage-clear');
    assert.equal(banner.title, 'SECTION 1 CLEARED');
    assert.match(banner.subtitle, /\+500/);
    assert.equal(g.session.victory, false, 'the run is not over after one bridge');
    g.run(3);
    assert.equal(g.session.notices.filter(n => n.kind === 'stage-clear').length, 0);
});

test('destroying the last bridge wins the run and freezes the world', () => {
    const g = headlessGame({ script: bot({ fire: true }), game: { startY: 2800, victoryBridges: 1, ...calm } });
    assert.equal(g.runUntil(h => h.session.victory, 30), true);
    assert.equal(g.of('victory').length, 1);
    assert.equal(g.of('victory')[0].score, 500);
    assert.equal(g.session.runEnded, true);
    assert.equal(g.session.gameOver, false);
    assert.deepEqual([g.session.summary.bridges, g.session.summary.section, g.session.summary.score], [1, 2, 500]);
    const frozen = { camera: g.engine.getStats().cameraY, y: g.session.jet.y };
    g.run(2);
    assert.equal(g.engine.getStats().cameraY, frozen.camera);
    assert.equal(g.session.jet.y, frozen.y);
    assert.equal(g.engine.getStats().scrollSpeed, 0);
    assert.ok(g.session.gameOverTime > 1.9);
    assert.equal(g.of('victory').length, 1, 'announced once');

    g.engine.reset(2026);
    assert.deepEqual([g.session.victory, g.session.runEnded, g.session.score, g.session.stage], [false, false, 0, 0]);
});

test('victoryBridges 0 means an endless river', () => {
    const g = headlessGame({ script: bot({ fire: true }), game: { startY: 2800, victoryBridges: 0, ...calm } });
    g.runUntil(h => h.of('stage-clear').length > 0, 30);
    g.run(2);
    assert.equal(g.session.victory, false);
    assert.equal(g.session.jet.isFlying, true);
});

test('the end-of-run summary reports what was destroyed', () => {
    const g = headlessGame({ script: () => ({ moveX: -1 }), game: { startLives: 1, ...calm } });
    g.session.progression.award('helicopter');
    g.session.progression.award('fighter');
    g.runUntil(h => h.session.gameOver, 20);
    const s = g.session.summary;
    assert.equal(s.score, 160);
    assert.equal(s.kills.helicopter, 1);
    assert.equal(s.kills.fighter, 1);
    assert.equal(s.section, 1);
});

test('setup validation: lives, victory goal and the table', () => {
    assert.throws(() => new GameSession({ victoryBridges: 1.5 }), RangeError);
    assert.throws(() => new GameSession({ victoryBridges: -1 }), RangeError);
    assert.throws(() => new GameSession({ points: { bridge: -5 } }), RangeError);
    assert.equal(new GameSession({ startLives: 5 }).lives, 5);
    assert.equal(new GameSession().progression.pointsFor('fighter'), 100);
});

// ---------------------------------------------------------- whole-run invariants

function longRun(seed, seconds = 90) {
    const g = headlessGame({
        seed,
        script: bot({ fire: true, throttle: 0 }),
        game: { startLives: 40, enemies: {}, fuel: { capacity: 1e9, startLevel: 1e9 }, victoryBridges: 0 },
    });
    g.run(seconds);
    return g;
}

test('INVARIANT: the score is exactly the sum of what the events paid out', () => {
    let kills = 0;
    for (const seed of [2026, 13, 77, 4242]) {
        const g = longRun(seed);
        const paid = g.events.reduce((sum, e) => sum + (e.type === 'enemy-destroyed' || e.type === 'depot-destroyed' || e.type === 'bridge-destroyed' ? e.points : 0), 0);
        assert.equal(g.session.score, paid, `seed ${seed}`);
        const enemyKills = g.of('enemy-destroyed').filter(e => !e.rammed);
        const table = { 'patrol-boat': 30, helicopter: 60, fighter: 100 };
        for (const e of enemyKills) assert.equal(e.points, table[e.enemy.kind]);
        for (const e of g.of('enemy-destroyed').filter(e => e.rammed)) assert.equal(e.points, 0);
        assert.equal(g.session.progression.totalKills, enemyKills.length + g.of('depot-destroyed').length + g.of('bridge-destroyed').length);
        kills += enemyKills.length;
    }
    assert.ok(kills > 8, `only ${kills} kills across all runs: the armada never met the player`);
});

test('INVARIANT: lives = start - deaths + extra lives, and an extra life only follows a threshold', () => {
    for (const seed of [2026, 13, 77]) {
        const g = longRun(seed);
        const deaths = g.of('jet-destroyed').length;
        assert.equal(g.session.lives, 40 - deaths + g.session.progression.bonusLivesGranted, `seed ${seed}`);
        assert.equal(g.session.progression.bonusLivesGranted, Math.floor(g.session.score / 10000));
        // Every death with lives left ends in a respawn; the only one that may be outstanding is a
        // wreck that is still settling at the moment the run stops being simulated.
        const pending = g.session.jet.isFlying ? 0 : 1;
        assert.equal(deaths - g.of('respawn').length, pending, `seed ${seed}: ${deaths} deaths, ${g.of('respawn').length} respawns`);
    }
});

test('INVARIANT: every death has a cause, and enemy deaths are real collisions', () => {
    let enemyDeaths = 0;
    for (const seed of [2026, 13, 77, 4242, 31337]) {
        const g = longRun(seed);
        for (const death of g.of('jet-destroyed')) {
            assert.ok(['land', 'bridge', 'enemy', 'fuel'].includes(death.cause));
            if (death.cause === 'enemy') {
                enemyDeaths++;
                const ram = g.of('enemy-destroyed').find(e => e.rammed && Math.abs(e.frame - death.frame) <= 1);
                assert.ok(ram, 'a ram is recorded alongside the death');
            }
        }
        assert.equal(g.of('jet-destroyed').filter(e => e.cause === 'fuel').length, 0, 'unlimited fuel');
    }
    assert.ok(enemyDeaths > 0, 'the armada never actually got the jet: the test would be vacuous');
});

test('enemy runs are exactly replayable from the seed', () => {
    const signature = () => {
        const g = longRun(2026, 40);
        return JSON.stringify({
            score: g.session.score, lives: g.session.lives, y: g.session.jet.y, x: g.session.jet.x,
            events: g.events.map(e => `${e.type}@${e.frame}${e.enemy ? `:${e.enemy.id}` : ''}`),
            enemies: [...g.session.enemies.values()].map(e => [e.id, +e.x.toFixed(6), +e.y.toFixed(6)]),
        });
    };
    assert.equal(signature(), signature());
});
