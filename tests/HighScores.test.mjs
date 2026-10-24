import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STORAGE_KEYS } from '../dist/src/core/Storage.js';
import {
    HighScoreBoard, INITIALS_ALPHABET, INITIALS_LENGTH, MAX_HIGH_SCORES, beatsRecordScore, defaultHighScores, formatDate, insertHighScore,
    isInitialsChar, isValidDate, isValidInitials, normalizeInitials, parseHighScores, qualifiesForHighScore, rankEntries, rankForScore,
    sanitizeEntry, serializeHighScores,
} from '../dist/src/systems/HighScoreSystem.js';

const KEY = 'riverraid.highscores';

class MemoryStorage {
    constructor(initial = {}) { this.data = new Map(Object.entries(initial)); this.failReads = false; this.failWrites = false; this.writes = 0; }
    getItem(key) { if (this.failReads) throw new Error('SecurityError'); return this.data.has(key) ? this.data.get(key) : null; }
    setItem(key, value) { if (this.failWrites) throw new Error('Quota'); this.writes++; this.data.set(key, String(value)); }
    removeItem(key) { this.data.delete(key); }
}

const day = (y, m, d) => new Date(y, m - 1, d, 15, 30);
const run = (initials, score, extra = {}) => ({ initials, score, bridgesCleared: 3, mode: 'endless', ...extra });
const entry = (rank, initials, score) => ({ rank, initials, score, bridgesCleared: 1, mode: 'campaign', date: '2026-02-03' });
/** A full table: scores 1000, 900 ... 100, named AAA..JJJ. */
const fullTable = () => Array.from({ length: 10 }, (_, i) => entry(i + 1, String.fromCharCode(65 + i).repeat(3), (10 - i) * 100));
const scores = entries => entries.map(e => e.score);
const names = entries => entries.map(e => e.initials);
const board = (storage = new MemoryStorage(), now = () => day(2026, 10, 23)) => new HighScoreBoard({ storage, now });

// ------------------------------------------------------------------ the starting table

test('a fresh install starts with the five classic names, in order', () => {
    const table = defaultHighScores();
    assert.deepEqual(table.map(e => [e.rank, e.initials, e.score, e.bridgesCleared, e.mode]), [
        [1, 'ACE', 18500, 10, 'campaign'],
        [2, 'MAX', 14200, 8, 'endless'],
        [3, 'RAI', 11800, 7, 'endless'],
        [4, 'DEX', 9400, 5, 'endless'],
        [5, 'PIL', 7200, 4, 'campaign'],
    ]);
    for (const e of table) {
        assert.ok(isValidInitials(e.initials) && isValidDate(e.date), e.initials);
    }
    assert.notEqual(defaultHighScores(), defaultHighScores(), 'a new array each time, so nothing shares state');
    assert.notEqual(defaultHighScores()[0], defaultHighScores()[0]);
});

test('the first launch writes the starting table to riverraid.highscores, and a second launch reads it back', () => {
    const storage = new MemoryStorage();
    const first = board(storage);
    assert.equal(KEY, STORAGE_KEYS.highScores);
    assert.deepEqual(names(first.entries), ['ACE', 'MAX', 'RAI', 'DEX', 'PIL']);
    assert.ok(storage.data.has(KEY), 'written down at once');
    assert.deepEqual(JSON.parse(storage.data.get(KEY)).map(e => e.initials), ['ACE', 'MAX', 'RAI', 'DEX', 'PIL']);
    assert.deepEqual(board(storage).entries, first.entries);
    assert.equal(first.record, 18500);
});

// -------------------------------------------------------------------- fields

test('initials: an alphabet of A-Z, 0-9, dot and dash', () => {
    assert.equal(INITIALS_LENGTH, 3);
    assert.equal(INITIALS_ALPHABET.length, 38);
    assert.equal(INITIALS_ALPHABET, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-');
    for (const c of 'AZ09.-') assert.ok(isInitialsChar(c), c);
    for (const c of ['a', ' ', '_', '*', '', 'AB', '\u00c9', '\u0000']) assert.equal(isInitialsChar(c), false, JSON.stringify(c));
});

test('initials: valid means exactly three alphabet characters', () => {
    for (const ok of ['ACE', 'A.B', '9-9', '...', '---', 'Z0Z']) assert.ok(isValidInitials(ok), ok);
    for (const bad of ['ac', 'ace', 'ABCD', 'AB', '', ' AB', 'A B', 'A_B', null, undefined, 12, ['A', 'B', 'C']]) assert.equal(isValidInitials(bad), false, String(bad));
});

test('initials are tidied: upper-cased, junk dropped, cut to three, padded with dots', () => {
    assert.equal(normalizeInitials('ace'), 'ACE');
    assert.equal(normalizeInitials('a!c@e#'), 'ACE');
    assert.equal(normalizeInitials('ABCDEF'), 'ABC');
    assert.equal(normalizeInitials('ab'), 'AB.');
    assert.equal(normalizeInitials('a'), 'A..');
    assert.equal(normalizeInitials(''), '...');
    assert.equal(normalizeInitials('!!!'), '...');
    assert.equal(normalizeInitials(null), '...');
    assert.equal(normalizeInitials(42), '...');
    assert.equal(normalizeInitials('a-9'), 'A-9');
    for (const raw of ['x', 'hello world', '\u00e9\u00e8!', '  q  ']) assert.ok(isValidInitials(normalizeInitials(raw)), raw);
});

test('dates are local YYYY-MM-DD and validated for real calendar days', () => {
    assert.equal(formatDate(new Date(2026, 0, 5, 23, 59)), '2026-01-05', 'a late score belongs to that evening');
    assert.equal(formatDate(new Date(2026, 11, 31, 0, 1)), '2026-12-31');
    assert.equal(formatDate(new Date(2026, 8, 9)), '2026-09-09');
    for (const ok of ['2026-02-28', '2024-02-29', '1999-12-31']) assert.ok(isValidDate(ok), ok);
    for (const bad of ['2026-02-30', '2025-02-29', '2026-13-01', '2026-00-10', '2026-1-1', '26-01-01', '', 'yesterday', null, 20260101]) {
        assert.equal(isValidDate(bad), false, String(bad));
    }
});

test('a stored entry is repaired where it can be and refused where it cannot', () => {
    assert.deepEqual(sanitizeEntry({ initials: 'abc', score: 1234.9, bridgesCleared: 3.7, mode: 'endless', date: '2026-02-03' }),
        { initials: 'ABC', score: 1234, bridgesCleared: 3, mode: 'endless', date: '2026-02-03' });
    const repaired = sanitizeEntry({ initials: 'ab', score: 5, mode: 'story', date: 'soon' });
    assert.deepEqual([repaired.initials, repaired.mode, repaired.bridgesCleared], ['AB.', 'campaign', 0]);
    assert.ok(isValidDate(repaired.date));
    for (const bad of [null, undefined, 5, 'x', [], {}, { initials: 'ABC' }, { score: 5 }, { initials: 'ABC', score: -1 }, { initials: 'ABC', score: NaN },
        { initials: 'ABC', score: Infinity }, { initials: 'ABC', score: '100' }, { initials: '', score: 5 }, { initials: '!!!', score: 5 }, { initials: 7, score: 5 }]) {
        assert.equal(sanitizeEntry(bad), null, JSON.stringify(bad));
    }
    assert.equal(sanitizeEntry({ initials: 'ABC', score: 0 }).score, 0, 'zero is a number, though it will never qualify');
});

// ------------------------------------------------------------------ ordering

test('ranking sorts best first, renumbers from 1, and keeps ties in the order given', () => {
    const ranked = rankEntries([
        { initials: 'LOW', score: 10, bridgesCleared: 0, mode: 'campaign', date: '2026-01-01' },
        { initials: 'AAA', score: 50, bridgesCleared: 0, mode: 'campaign', date: '2026-01-01' },
        { initials: 'BBB', score: 50, bridgesCleared: 0, mode: 'campaign', date: '2026-01-01' },
        { initials: 'TOP', score: 99, bridgesCleared: 0, mode: 'campaign', date: '2026-01-01' },
    ]);
    assert.deepEqual(ranked.map(e => [e.rank, e.initials]), [[1, 'TOP'], [2, 'AAA'], [3, 'BBB'], [4, 'LOW']]);
});

test('ranking prunes to ten', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ initials: 'AAA', score: i + 1, bridgesCleared: 0, mode: 'campaign', date: '2026-01-01' }));
    const ranked = rankEntries(many);
    assert.equal(ranked.length, MAX_HIGH_SCORES);
    assert.deepEqual(scores(ranked), [25, 24, 23, 22, 21, 20, 19, 18, 17, 16]);
    assert.equal(ranked.at(-1).rank, 10);
});

// ------------------------------------------------------------ qualification

test('a score qualifies if it is above zero and would land in the top ten', () => {
    const table = defaultHighScores();
    assert.equal(qualifiesForHighScore(table, 1), true, 'a table with room takes anything above zero');
    assert.equal(qualifiesForHighScore(table, 7200), true, 'even a tie with last place while there is room');
    for (const bad of [0, -5, NaN, Infinity, -Infinity, 0.4, '500', null, undefined]) assert.equal(qualifiesForHighScore(table, bad), false, String(bad));
    const full = fullTable(); // 1000 ... 100
    assert.equal(qualifiesForHighScore(full, 101), true);
    assert.equal(qualifiesForHighScore(full, 100), false, 'equalling 10th place does not displace it');
    assert.equal(qualifiesForHighScore(full, 99), false);
    assert.equal(qualifiesForHighScore(full, 5000), true);
    assert.equal(qualifiesForHighScore([], 1), true);
});

test('the rank a score would take: ties go below the existing equal score', () => {
    const table = defaultHighScores(); // 18500, 14200, 11800, 9400, 7200
    assert.equal(rankForScore(table, 99999), 1);
    assert.equal(rankForScore(table, 18500), 2, 'a tie with the leader is second');
    assert.equal(rankForScore(table, 18501), 1);
    assert.equal(rankForScore(table, 12000), 3);
    assert.equal(rankForScore(table, 11800), 4, 'a tie goes below');
    assert.equal(rankForScore(table, 7200), 6);
    assert.equal(rankForScore(table, 100), 6, 'last of a table that still has room');
    assert.equal(rankForScore(table, 10.9), 6, 'fractions round down');
    assert.equal(rankForScore(table, 0), null);
    assert.equal(rankForScore(fullTable(), 100), null);
    assert.equal(rankForScore(fullTable(), 101), 10);
});

test('it beats the record only if it is strictly above number one', () => {
    const table = defaultHighScores();
    assert.equal(beatsRecordScore(table, 18501), true);
    assert.equal(beatsRecordScore(table, 18500), false, 'a tie is not a record');
    assert.equal(beatsRecordScore(table, 18499), false);
    assert.equal(beatsRecordScore(table, 0), false);
    assert.equal(beatsRecordScore(table, NaN), false);
    assert.equal(beatsRecordScore([], 5), true, 'anything beats an empty table');
    assert.equal(beatsRecordScore([], 0), false);
});

// ----------------------------------------------------------------- insertion

test('inserting puts a run in its place, renumbers the rest, and leaves the input alone', () => {
    const table = defaultHighScores();
    const before = JSON.stringify(table);
    const { entries, rank } = insertHighScore(table, { initials: 'ZED', score: 12000, bridgesCleared: 6, mode: 'endless', date: '2026-10-23' });
    assert.equal(rank, 3);
    assert.deepEqual(names(entries), ['ACE', 'MAX', 'ZED', 'RAI', 'DEX', 'PIL']);
    assert.deepEqual(entries.map(e => e.rank), [1, 2, 3, 4, 5, 6]);
    assert.equal(JSON.stringify(table), before, 'the original is untouched');
    assert.deepEqual(entries[2], { rank: 3, initials: 'ZED', score: 12000, bridgesCleared: 6, mode: 'endless', date: '2026-10-23' });
});

test('inserting at the very top and the very bottom', () => {
    const table = defaultHighScores();
    assert.equal(insertHighScore(table, run('TOP', 99999, { date: '2026-10-23' })).rank, 1);
    assert.deepEqual(names(insertHighScore(table, run('TOP', 99999, { date: '2026-10-23' })).entries).slice(0, 3), ['TOP', 'ACE', 'MAX']);
    const bottom = insertHighScore(table, run('LOW', 50, { date: '2026-10-23' }));
    assert.equal(bottom.rank, 6);
    assert.equal(bottom.entries.at(-1).initials, 'LOW');
});

test('TIE-BREAK: an equal score goes below the older one, whether in the middle or at the top', () => {
    const table = defaultHighScores();
    const mid = insertHighScore(table, run('NEW', 11800, { date: '2026-10-23' }));
    assert.deepEqual(names(mid.entries), ['ACE', 'MAX', 'RAI', 'NEW', 'DEX', 'PIL']);
    assert.equal(mid.rank, 4);
    const top = insertHighScore(table, run('NEW', 18500, { date: '2026-10-23' }));
    assert.deepEqual(names(top.entries).slice(0, 2), ['ACE', 'NEW']);
    // Many equal scores: first in stays first.
    let t = [];
    for (const n of ['AAA', 'BBB', 'CCC', 'DDD']) t = insertHighScore(t, run(n, 500, { date: '2026-10-23' })).entries;
    assert.deepEqual(names(t), ['AAA', 'BBB', 'CCC', 'DDD']);
});

test('PRUNING: a full table drops its last entry when a better score arrives, and refuses one that is not better', () => {
    const full = fullTable();
    const better = insertHighScore(full, run('NEW', 550, { date: '2026-10-23' }));
    assert.equal(better.rank, 6);
    assert.equal(better.entries.length, 10);
    assert.deepEqual(scores(better.entries), [1000, 900, 800, 700, 600, 550, 500, 400, 300, 200], 'the old 10th (100) fell off');
    assert.deepEqual(better.entries.map(e => e.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const score of [100, 99, 1, 0]) {
        const refused = insertHighScore(full, run('NEW', score, { date: '2026-10-23' }));
        assert.equal(refused.rank, null, String(score));
        assert.deepEqual(refused.entries, full, 'the table comes back unchanged');
    }
});

test('inserting something unusable changes nothing', () => {
    const table = defaultHighScores();
    for (const bad of [run('ABC', NaN), run('ABC', -4), run('ABC', 0), run('!!!', 5000)]) {
        const result = insertHighScore(table, { ...bad, date: '2026-10-23' });
        assert.equal(result.rank, null, JSON.stringify(bad));
        assert.deepEqual(result.entries, table);
    }
});

// ------------------------------------------------------------------- storage

test('a table round-trips through JSON exactly', () => {
    const table = insertHighScore(defaultHighScores(), run('ZED', 12000, { date: '2026-10-23' })).entries;
    assert.deepEqual(parseHighScores(serializeHighScores(table)), table);
    const stored = JSON.parse(serializeHighScores(table));
    assert.deepEqual(Object.keys(stored[0]).sort(), ['bridgesCleared', 'date', 'initials', 'mode', 'rank', 'score']);
});

test('unreadable storage is "nothing there": missing, not JSON, not a list, or no valid entry', () => {
    for (const bad of [null, '', 'garbage', '{', '{}', '"text"', '42', 'null', '[]', '[null, 5, "x"]', '[{"score": 5}]', '[{"initials":"ABC","score":-1}]']) {
        assert.equal(parseHighScores(bad), null, String(bad));
    }
});

test('a damaged table is rebuilt from what is good: bad entries dropped, order and ranks restored, ten at most', () => {
    const messy = JSON.stringify([
        { rank: 9, initials: 'low', score: 100, bridgesCleared: 1, mode: 'endless', date: '2026-01-01' },
        { initials: 'bad', score: 'lots' },
        null,
        { rank: 1, initials: 'top', score: 9000.7, bridgesCleared: 2, mode: 'weird', date: 'not a date' },
        { rank: 4, initials: 'mid', score: 500, bridgesCleared: -3, mode: 'campaign', date: '2026-03-04' },
    ]);
    const table = parseHighScores(messy);
    assert.deepEqual(table.map(e => [e.rank, e.initials, e.score]), [[1, 'TOP', 9000], [2, 'MID', 500], [3, 'LOW', 100]]);
    assert.equal(table[0].mode, 'campaign');
    assert.equal(table[1].bridgesCleared, 0);
    const huge = JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ initials: 'AAA', score: i + 1, bridgesCleared: 0, mode: 'campaign', date: '2026-01-01' })));
    assert.equal(parseHighScores(huge).length, 10);
    assert.equal(parseHighScores(huge)[0].score, 40);
});

test('the board falls back to the starting table when storage is garbage, and heals it', () => {
    const storage = new MemoryStorage({ [KEY]: '{{{ nope' });
    const b = board(storage);
    assert.deepEqual(names(b.entries), ['ACE', 'MAX', 'RAI', 'DEX', 'PIL']);
    assert.deepEqual(JSON.parse(storage.data.get(KEY)).map(e => e.initials), ['ACE', 'MAX', 'RAI', 'DEX', 'PIL']);
});

test('storage that throws, or no storage at all, never breaks the board', () => {
    const broken = new MemoryStorage();
    broken.failReads = true;
    broken.failWrites = true;
    const a = board(broken);
    assert.equal(a.entries.length, 5);
    const result = a.submit(run('ZED', 12000));
    assert.equal(result.rank, 3, 'it still keeps the table in memory');
    assert.equal(a.entries.length, 6);
    const none = new HighScoreBoard({ storage: null });
    assert.equal(none.submit(run('ZED', 12000)).rank, 3);
    none.reset();
    assert.equal(none.entries.length, 5);
});

// ------------------------------------------------------------------- the board

test('submitting a qualifying run files it with today\'s date and saves it', () => {
    const storage = new MemoryStorage();
    const b = board(storage, () => day(2026, 10, 23));
    const result = b.submit(run('zed', 12000, { bridgesCleared: 6 }));
    assert.deepEqual(result.entry, { rank: 3, initials: 'ZED', score: 12000, bridgesCleared: 6, mode: 'endless', date: '2026-10-23' });
    assert.equal(result.rank, 3);
    assert.equal(result.isRecord, false);
    assert.deepEqual(names(board(storage).entries), ['ACE', 'MAX', 'ZED', 'RAI', 'DEX', 'PIL'], 'a new session sees it');
});

test('submitting a run that does not qualify does nothing', () => {
    const storage = new MemoryStorage();
    const b = board(storage);
    for (const bad of [0, -1, NaN]) assert.equal(b.submit(run('ZED', bad)), null);
    const before = storage.writes;
    const full = new HighScoreBoard({ storage: new MemoryStorage({ [KEY]: serializeHighScores(fullTable()) }) });
    assert.equal(full.submit(run('ZED', 100)), null, 'a tie with 10th place');
    assert.equal(full.entries.length, 10);
    assert.equal(storage.writes, before, 'nothing was written');
});

test('the record flag is set only for a score strictly above number one', () => {
    const b = board();
    assert.equal(b.beatsRecord(18500), false);
    assert.equal(b.submit(run('TIE', 18500)).isRecord, false);
    assert.equal(b.entries[1].initials, 'TIE');
    assert.equal(b.submit(run('WIN', 18501)).isRecord, true);
    assert.equal(b.record, 18501);
    assert.equal(b.entries[0].initials, 'WIN');
    assert.equal(b.submit(run('AGN', 18501)).isRecord, false, 'matching the new record is not beating it');
});

test('the latest run is remembered while it stays on the table, so the view can blink it', () => {
    const b = board();
    assert.equal(b.latestRank, null);
    b.submit(run('ZED', 12000));
    assert.equal(b.latestRank, 3);
    b.submit(run('TOP', 99999));
    assert.equal(b.latestRank, 1, 'the latest is the newest');
    b.submit(run('MID', 13000)); // 99999, 18500, 14200, then 13000: fourth
    assert.equal(b.latestRank, 4);
    // A run that does not qualify is not "the latest": the blink stays on the last one that made the table.
    b.submit(run('NIL', 0));
    assert.equal(b.latestRank, 4);
    // And the latest is always the newest submission, so it is on the table until a reset.
    const small = board();
    small.submit(run('LOW', 50));
    for (let i = 0; i < 6; i++) small.submit(run('BIG', 20000 + i));
    assert.equal(small.entries.length, 10);
    assert.equal(small.latestRank, 1, 'the newest, biggest run');
});

test('two identical-looking runs: the newer one is the one that blinks', () => {
    const b = board();
    b.submit(run('SAM', 5000));
    b.submit(run('SAM', 5000));
    assert.equal(b.latestRank, 7, 'the second sits below the first (which took 6th, below PIL\'s 7200)');
});

test('reset restores the starting table, forgets the latest run, and saves', () => {
    const storage = new MemoryStorage();
    const b = board(storage);
    b.submit(run('ZED', 12000));
    b.submit(run('TOP', 99999));
    b.reset();
    assert.deepEqual(names(b.entries), ['ACE', 'MAX', 'RAI', 'DEX', 'PIL']);
    assert.equal(b.latestRank, null);
    assert.equal(b.record, 18500);
    assert.deepEqual(names(board(storage).entries), ['ACE', 'MAX', 'RAI', 'DEX', 'PIL'], 'and it stays reset');
});

test('listeners hear about submissions and resets, and can stop listening', () => {
    const b = board();
    const seen = [];
    const off = b.subscribe(entries => seen.push(entries.length));
    b.submit(run('ZED', 12000));
    b.reset();
    b.submit(run('NIL', 0));
    assert.deepEqual(seen, [6, 5], 'a refused run is not news');
    off();
    b.submit(run('ZED', 12000));
    assert.deepEqual(seen, [6, 5]);
});

test('the entries a board hands out are copies: editing them cannot corrupt the table', () => {
    const b = board();
    const copy = b.entries;
    copy[0].score = 1;
    copy.pop();
    assert.equal(b.entries[0].score, 18500);
    assert.equal(b.entries.length, 5);
});

test('a board always holds at most ten entries however many runs arrive', () => {
    const b = board();
    for (let i = 1; i <= 40; i++) b.submit(run('AAA', i * 1000));
    assert.equal(b.entries.length, 10);
    assert.deepEqual(b.entries.map(e => e.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.deepEqual(scores(b.entries), [...scores(b.entries)].sort((x, y) => y - x), 'always best first');
});

test('an actual run feeds the board: the session summary gives the bridges and the mode', async () => {
    const { headlessGame, pilot } = await import('./helpers.mjs');
    const g = headlessGame({
        script: (_f, h) => pilot(h.session, h.engine.world, { seekDepots: false, fire: true }),
        game: { startY: 2800, mode: 'endless', fuel: { capacity: 1e9, startLevel: 1e9 }, depots: { chance: 0 } },
    });
    g.runUntil(h => h.of('stage-clear').length > 0, 60);
    const summary = g.session.summary;
    const b = board();
    const result = b.submit({ initials: 'BOT', score: Math.floor(summary.score), bridgesCleared: summary.bridges, mode: summary.mode });
    assert.equal(result.entry.bridgesCleared, 1);
    assert.equal(result.entry.mode, 'endless');
    assert.equal(result.entry.score, 500);
});
