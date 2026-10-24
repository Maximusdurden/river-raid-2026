import { STORAGE_KEYS, readItem, writeItem, type KeyValueStorage } from '../core/Storage.js';
import { isGameMode, type GameMode } from '../game/GameMode.js';

/**
 * The Hall of Fame: the ten best runs, kept in `localStorage['riverraid.highscores']`.
 *
 * The rules, which are all pure functions so they can be tested without a browser:
 *  - Entries are ordered by score, best first. A tie keeps the older entry ahead, so a new score
 *    that equals an existing one ranks just below it (and equalling 10th place does not get you on).
 *  - A score qualifies if it is above zero and would land in the top ten.
 *  - It "beats the record" only if it is strictly above the current number one.
 *  - Initials are three characters from `INITIALS_ALPHABET` (A-Z, 0-9, dash, dot).
 *  - Nothing read back from storage is trusted: bad entries are repaired or dropped, the order is
 *    re-established, and anything beyond ten is pruned.
 *  - A first launch (or unreadable data) starts from a classic arcade table of five names.
 */

export const MAX_HIGH_SCORES = 10;
export const INITIALS_LENGTH = 3;
/** Cycling order for the initials picker. */
export const INITIALS_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-';

export interface HighScoreEntry {
    /** 1 for the best run. Always equals the entry's position in the table. */
    rank: number;
    /** Exactly three characters from `INITIALS_ALPHABET`. */
    initials: string;
    score: number;
    bridgesCleared: number;
    mode: GameMode;
    /** Local date, YYYY-MM-DD. */
    date: string;
}

/** What a run supplies when it asks for a place; the board adds the date. */
export interface HighScoreCandidate {
    initials: string;
    score: number;
    bridgesCleared: number;
    mode: GameMode;
    date: string;
}

type EntryData = Omit<HighScoreEntry, 'rank'>;

const SEED_DATE = '2026-01-01';

/** The table a fresh install starts with. */
export function defaultHighScores(): HighScoreEntry[] {
    const seeds: readonly EntryData[] = [
        { initials: 'ACE', score: 18500, bridgesCleared: 10, mode: 'campaign', date: SEED_DATE },
        { initials: 'MAX', score: 14200, bridgesCleared: 8, mode: 'endless', date: SEED_DATE },
        { initials: 'RAI', score: 11800, bridgesCleared: 7, mode: 'endless', date: SEED_DATE },
        { initials: 'DEX', score: 9400, bridgesCleared: 5, mode: 'endless', date: SEED_DATE },
        { initials: 'PIL', score: 7200, bridgesCleared: 4, mode: 'campaign', date: SEED_DATE },
    ];
    return seeds.map((entry, index) => ({ rank: index + 1, ...entry }));
}

// ------------------------------------------------------------------ fields

export function isInitialsChar(char: string): boolean {
    return char.length === 1 && INITIALS_ALPHABET.includes(char);
}

/** True for exactly three characters, all from the alphabet. */
export function isValidInitials(value: unknown): value is string {
    return typeof value === 'string' && value.length === INITIALS_LENGTH && [...value].every(isInitialsChar);
}

/**
 * Upper-cases, drops anything outside the alphabet, cuts to three characters and pads short input
 * with dots, so the result always satisfies `isValidInitials`. Nothing usable at all gives '...'.
 */
export function normalizeInitials(raw: unknown): string {
    const text = typeof raw === 'string' ? raw.toUpperCase() : '';
    const kept = [...text].filter(isInitialsChar).slice(0, INITIALS_LENGTH).join('');
    return kept.padEnd(INITIALS_LENGTH, '.');
}

/** Local calendar date as YYYY-MM-DD (not UTC: a score at 11pm belongs to that evening). */
export function formatDate(date: Date): string {
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function isValidDate(value: unknown): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number) as [number, number, number];
    const probe = new Date(Date.UTC(year, month - 1, day));
    return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function wholeNumber(value: unknown, max: number): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    return Math.min(max, Math.floor(value));
}

/** One stored entry, repaired, or null if it cannot be made sensible. Rank is not part of it. */
export function sanitizeEntry(raw: unknown): EntryData | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    const score = wholeNumber(r.score, Number.MAX_SAFE_INTEGER);
    if (score === null) return null;
    if (typeof r.initials !== 'string') return null;
    // At least one usable character must be in there, or the name is not repairable.
    if (![...r.initials.toUpperCase()].some(isInitialsChar)) return null;
    return {
        initials: normalizeInitials(r.initials),
        score,
        bridgesCleared: wholeNumber(r.bridgesCleared, 9999) ?? 0,
        mode: isGameMode(r.mode) ? r.mode : 'campaign',
        date: isValidDate(r.date) ? r.date : SEED_DATE,
    };
}

// ------------------------------------------------------------------ ordering

/** Best first, ties keeping their given order, at most ten, ranks renumbered from 1. Returns new objects. */
export function rankEntries(entries: readonly EntryData[]): HighScoreEntry[] {
    return entries
        .map((entry, index) => ({ entry, index }))
        .sort((a, b) => b.entry.score - a.entry.score || a.index - b.index)
        .slice(0, MAX_HIGH_SCORES)
        .map(({ entry }, index) => ({ ...entry, rank: index + 1 }));
}

/**
 * The rank (1 = best) a score would take, with ties ranking below existing equal scores; null if it
 * would not make the table (zero, not a number, or not above 10th place in a full table).
 */
export function rankForScore(entries: readonly HighScoreEntry[], score: number): number | null {
    if (typeof score !== 'number' || !Number.isFinite(score)) return null;
    const whole = Math.floor(score);
    if (whole <= 0) return null; // zero, negative, or a fraction that rounds down to nothing
    let index = entries.findIndex(entry => entry.score < whole);
    if (index < 0) index = entries.length;
    return index < MAX_HIGH_SCORES ? index + 1 : null;
}

export function qualifiesForHighScore(entries: readonly HighScoreEntry[], score: number): boolean {
    return rankForScore(entries, score) !== null;
}

/** True if `score` is strictly above today's number one. An empty table is beaten by any positive score. */
export function beatsRecordScore(entries: readonly HighScoreEntry[], score: number): boolean {
    if (typeof score !== 'number' || !Number.isFinite(score) || Math.floor(score) <= 0) return false;
    const top = entries[0];
    return top === undefined || Math.floor(score) > top.score;
}

export interface InsertResult {
    /** The new table (new objects; the input is untouched). */
    readonly entries: HighScoreEntry[];
    /** The rank the candidate took, or null if it did not make the table. */
    readonly rank: number | null;
}

/** Puts a candidate in its place, pruning to ten. Returns the table unchanged (as copies) if it does not qualify. */
export function insertHighScore(entries: readonly HighScoreEntry[], candidate: HighScoreCandidate): InsertResult {
    const cleaned = sanitizeEntry(candidate);
    const rank = cleaned ? rankForScore(entries, cleaned.score) : null;
    if (!cleaned || rank === null) return { entries: entries.map(entry => ({ ...entry })), rank: null };
    const data: EntryData[] = entries.map(({ rank: _rank, ...rest }) => rest);
    data.splice(rank - 1, 0, cleaned);
    return { entries: rankEntries(data), rank };
}

// ------------------------------------------------------------------ storage

/** Reads a stored table. Null means there was nothing usable (missing, corrupt, or no valid entries). */
export function parseHighScores(text: string | null): HighScoreEntry[] | null {
    if (text === null) return null;
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return null;
    }
    if (!Array.isArray(raw)) return null;
    const entries: EntryData[] = [];
    for (const item of raw) {
        const entry = sanitizeEntry(item);
        if (entry) entries.push(entry);
    }
    return entries.length > 0 ? rankEntries(entries) : null;
}

export function serializeHighScores(entries: readonly HighScoreEntry[]): string {
    return JSON.stringify(entries.map(({ rank, initials, score, bridgesCleared, mode, date }) => ({ rank, initials, score, bridgesCleared, mode, date })));
}

// ------------------------------------------------------------------ the board

export interface HighScoreBoardOptions {
    /** Where the table lives. `undefined` = the page's localStorage, `null` = nowhere. */
    storage?: KeyValueStorage | null;
    /** The clock, for the date on a new entry. Default: the real time. */
    now?: () => Date;
}

export interface SubmitResult {
    readonly entry: HighScoreEntry;
    readonly rank: number;
    /** It beat the previous number one. */
    readonly isRecord: boolean;
}

export type HighScoreListener = (entries: readonly HighScoreEntry[]) => void;

/**
 * The live table: loads it, answers "does this score qualify?", takes new scores, saves after every
 * change and tells listeners. It remembers the most recent submission so a view can mark it.
 */
export class HighScoreBoard {
    private table: HighScoreEntry[];
    private readonly storage: KeyValueStorage | null;
    private readonly now: () => Date;
    private readonly listeners = new Set<HighScoreListener>();
    private latestKey: string | null = null;

    constructor(options: HighScoreBoardOptions = {}) {
        this.storage = options.storage === undefined ? defaultStorageSafe() : options.storage;
        this.now = options.now ?? (() => new Date());
        const stored = parseHighScores(readItem(this.storage, STORAGE_KEYS.highScores));
        this.table = stored ?? defaultHighScores();
        if (!stored) this.save(); // the first launch writes the classic table down
    }

    /** The table, best first. A copy: change it only through `submit` and `reset`. */
    get entries(): readonly HighScoreEntry[] {
        return this.table.map(entry => ({ ...entry }));
    }

    /** The best score on the table (0 if it is somehow empty). */
    get record(): number {
        return this.table[0]?.score ?? 0;
    }

    rankFor(score: number): number | null {
        return rankForScore(this.table, score);
    }

    qualifies(score: number): boolean {
        return qualifiesForHighScore(this.table, score);
    }

    beatsRecord(score: number): boolean {
        return beatsRecordScore(this.table, score);
    }

    /**
     * Adds a run if it qualifies. Returns where it landed, or null if it did not make the table.
     * The date is today's, from the board's clock.
     */
    submit(run: { initials: string; score: number; bridgesCleared: number; mode: GameMode }): SubmitResult | null {
        const isRecord = this.beatsRecord(run.score);
        const candidate: HighScoreCandidate = {
            initials: normalizeInitials(run.initials),
            score: run.score,
            bridgesCleared: run.bridgesCleared,
            mode: run.mode,
            date: formatDate(this.now()),
        };
        const result = insertHighScore(this.table, candidate);
        if (result.rank === null) return null;
        this.table = result.entries;
        const entry = this.table[result.rank - 1];
        if (!entry) return null;
        this.latestKey = entryKey(entry);
        this.save();
        this.notify();
        return { entry: { ...entry }, rank: result.rank, isRecord };
    }

    /** The rank of the most recently submitted run if it is still on the table, else null. */
    get latestRank(): number | null {
        if (this.latestKey === null) return null;
        for (let i = this.table.length - 1; i >= 0; i--) {
            const entry = this.table[i];
            if (entry && entryKey(entry) === this.latestKey) return entry.rank;
        }
        return null;
    }

    /** Back to the classic five-name table, forgetting the latest run. */
    reset(): void {
        this.table = defaultHighScores();
        this.latestKey = null;
        this.save();
        this.notify();
    }

    subscribe(listener: HighScoreListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private save(): void {
        writeItem(this.storage, STORAGE_KEYS.highScores, serializeHighScores(this.table));
    }

    private notify(): void {
        const snapshot = this.entries;
        for (const listener of this.listeners) listener(snapshot);
    }
}

function entryKey(entry: HighScoreEntry): string {
    return `${entry.initials}|${entry.score}|${entry.bridgesCleared}|${entry.mode}|${entry.date}`;
}

function defaultStorageSafe(): KeyValueStorage | null {
    try {
        const candidate = (globalThis as { localStorage?: KeyValueStorage }).localStorage;
        return candidate ?? null;
    } catch {
        return null;
    }
}
