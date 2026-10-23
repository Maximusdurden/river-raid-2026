import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_POINT_TABLE, ProgressionSystem } from '../dist/src/systems/ProgressionSystem.js';

test('the point table matches the specification', () => {
    assert.deepEqual({ ...DEFAULT_POINT_TABLE }, { patrolBoat: 30, helicopter: 60, depot: 80, fighter: 100, bridge: 500 });
    const p = new ProgressionSystem();
    for (const [source, points] of Object.entries(DEFAULT_POINT_TABLE)) assert.equal(p.pointsFor(source), points);
});

test('starts at zero with three lives in section 1', () => {
    const p = new ProgressionSystem();
    assert.deepEqual([p.score, p.lives, p.stage, p.stageNumber, p.bonusLivesGranted, p.totalKills], [0, 3, 0, 1, 0, 0]);
    assert.equal(p.nextBonusAt, 10000);
});

test('award adds the table value, records the kill and reports the result', () => {
    const p = new ProgressionSystem();
    const results = ['patrolBoat', 'helicopter', 'depot', 'fighter'].map(s => p.award(s));
    assert.deepEqual(results.map(r => r.points), [30, 60, 80, 100]);
    assert.deepEqual(results.map(r => r.score), [30, 90, 170, 270]);
    assert.equal(p.score, 270);
    assert.deepEqual({ ...p.kills }, { patrolBoat: 1, helicopter: 1, depot: 1, fighter: 1, bridge: 0 });
    assert.equal(p.totalKills, 4);
});

test('destroying a bridge scores 500 and advances the stage counter', () => {
    const p = new ProgressionSystem();
    assert.equal(p.award('bridge').points, 500);
    assert.deepEqual([p.stage, p.stageNumber, p.score], [1, 2, 500]);
    p.award('bridge');
    assert.deepEqual([p.stage, p.stageNumber, p.kills.bridge], [2, 3, 2]);
    // Other kills never move the stage.
    p.award('fighter');
    assert.equal(p.stage, 2);
});

test('an extra life arrives exactly when the score reaches 10,000', () => {
    const p = new ProgressionSystem();
    assert.equal(p.addPoints(9999).bonusLives, 0);
    assert.equal(p.lives, 3);
    const crossing = p.addPoints(1);
    assert.deepEqual([crossing.bonusLives, p.lives, p.score, p.bonusLivesGranted], [1, 4, 10000, 1]);
    assert.equal(p.nextBonusAt, 20000);
    assert.equal(p.addPoints(1).bonusLives, 0);
    assert.equal(p.lives, 4);
});

test('crossing the threshold through a kill reports the bonus on that award', () => {
    const p = new ProgressionSystem();
    p.addPoints(9950);
    const result = p.award('helicopter');
    assert.equal(result.score, 10010);
    assert.equal(result.bonusLives, 1);
    assert.equal(p.lives, 4);
    assert.equal(p.kills.helicopter, 1, 'raw points never count as a kill');
});

test('one big award that jumps several thresholds pays out every one of them', () => {
    const p = new ProgressionSystem();
    const result = p.addPoints(25000);
    assert.equal(result.bonusLives, 2);
    assert.equal(p.lives, 5);
    assert.equal(p.nextBonusAt, 30000);
});

test('no threshold is ever paid twice, however the score is built up', () => {
    const p = new ProgressionSystem();
    let paid = 0;
    for (let i = 0; i < 4000; i++) paid += p.award(i % 3 === 0 ? 'helicopter' : i % 3 === 1 ? 'patrolBoat' : 'depot').bonusLives;
    assert.equal(paid, Math.floor(p.score / 10000));
    assert.equal(p.lives, 3 + paid);
    assert.equal(p.bonusLivesGranted, paid);
});

test('losing lives does not affect thresholds: the next extra life is still tied to the score', () => {
    const p = new ProgressionSystem();
    p.loseLife();
    p.loseLife();
    p.loseLife();
    assert.equal(p.lives, 0);
    assert.equal(p.loseLife(), 0, 'never below zero');
    p.addPoints(10000);
    assert.equal(p.lives, 1);
});

test('bonus lives can be switched off', () => {
    const p = new ProgressionSystem({ bonusLifeEvery: 0 });
    assert.equal(p.addPoints(1_000_000).bonusLives, 0);
    assert.equal(p.lives, 3);
    assert.equal(p.nextBonusAt, null);
});

test('the life cap blocks payout but the threshold still counts as passed', () => {
    const p = new ProgressionSystem({ startLives: 3, maxLives: 5 });
    const result = p.addPoints(50000);
    assert.equal(result.bonusLives, 2, 'only the room left is given');
    assert.equal(p.lives, 5);
    assert.equal(p.bonusLivesGranted, 5, 'all five thresholds were passed');
    assert.equal(p.addPoints(1).bonusLives, 0);
    p.loseLife();
    assert.equal(p.addPoints(1).bonusLives, 0, 'no back-pay for thresholds already passed');
    assert.equal(p.addPoints(10000).bonusLives, 1, 'the next threshold pays again once there is room');
});

test('a custom threshold and a custom table work', () => {
    const p = new ProgressionSystem({ bonusLifeEvery: 500, points: { bridge: 100 } });
    assert.equal(p.award('bridge').points, 100);
    assert.equal(p.pointsFor('helicopter'), 60, 'unspecified entries keep their defaults');
    p.addPoints(400);
    assert.equal(p.lives, 4);
    assert.equal(p.nextBonusAt, 1000);
});

test('invalid or non-positive points are ignored', () => {
    const p = new ProgressionSystem();
    for (const value of [0, -50, NaN, Infinity, -Infinity]) {
        const r = p.addPoints(value);
        assert.deepEqual([r.points, r.bonusLives, r.score], [0, 0, 0]);
    }
    assert.equal(p.score, 0);
});

test('kills returns a copy, so callers cannot tamper with the counters', () => {
    const p = new ProgressionSystem();
    p.award('fighter');
    const snapshot = p.kills;
    snapshot.fighter = 999;
    assert.equal(p.kills.fighter, 1);
});

test('reset starts a fresh run but keeps the configuration', () => {
    const p = new ProgressionSystem({ startLives: 5, bonusLifeEvery: 2000 });
    p.award('bridge');
    p.addPoints(5000);
    p.loseLife();
    p.reset();
    assert.deepEqual([p.score, p.lives, p.stage, p.bonusLivesGranted, p.totalKills, p.nextBonusAt], [0, 5, 0, 0, 0, 2000]);
    assert.deepEqual({ ...p.kills }, { patrolBoat: 0, helicopter: 0, depot: 0, fighter: 0, bridge: 0 });
});

test('invalid configuration is rejected', () => {
    for (const bad of [
        { startLives: 0 }, { startLives: 1.5 }, { maxLives: 2 }, { maxLives: 3.5 }, { bonusLifeEvery: -1 },
        { bonusLifeEvery: NaN }, { points: { bridge: -1 } }, { points: { depot: NaN } },
    ]) {
        assert.throws(() => new ProgressionSystem(bad), RangeError, JSON.stringify(bad));
    }
});
