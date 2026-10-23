import { STORAGE_KEYS, readItem, writeItem, type KeyValueStorage } from '../core/Storage.js';

/**
 * - `campaign`: destroying `victoryBridges` bridges (10 by default) wins the run.
 * - `endless`: nothing ever wins it. Bridges still score their 500 points and still act as
 *   checkpoints, but the river just keeps going until the last jet is lost.
 */
export type GameMode = 'campaign' | 'endless';

export const GAME_MODES: readonly GameMode[] = ['campaign', 'endless'];

export const DEFAULT_GAME_MODE: GameMode = 'campaign';

export function isGameMode(value: unknown): value is GameMode {
    return value === 'campaign' || value === 'endless';
}

/** Anything that is not exactly a known mode (missing, corrupt, from a future version) is the default. */
export function parseGameMode(text: string | null | undefined): GameMode {
    if (text === null || text === undefined) return DEFAULT_GAME_MODE;
    const trimmed = text.trim();
    if (isGameMode(trimmed)) return trimmed;
    // Tolerate a JSON-encoded string, in case something else wrote the key.
    try {
        const parsed: unknown = JSON.parse(trimmed);
        return isGameMode(parsed) ? parsed : DEFAULT_GAME_MODE;
    } catch {
        return DEFAULT_GAME_MODE;
    }
}

/** The saved mode (`riverraid.game_mode`), or the default. */
export function loadGameMode(storage: KeyValueStorage | null): GameMode {
    return parseGameMode(readItem(storage, STORAGE_KEYS.gameMode));
}

/** Saves the mode. Returns whether it was actually written. */
export function saveGameMode(storage: KeyValueStorage | null, mode: GameMode): boolean {
    return writeItem(storage, STORAGE_KEYS.gameMode, mode);
}

/** Text for the menus and the HUD. */
export const GAME_MODE_LABELS: Readonly<Record<GameMode, string>> = {
    campaign: 'Campaign',
    endless: 'Endless River',
};
