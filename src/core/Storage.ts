/**
 * Safe access to persistent settings.
 *
 * `localStorage` can be missing (Node, tests), throw on access (sandboxed iframes, some
 * privacy modes) or throw on write (quota). None of that may break the game: settings
 * simply stop persisting. Every helper here swallows those failures.
 */

/** The subset of the Web Storage API the game uses. `localStorage` satisfies it. */
export interface KeyValueStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

/** Every key the game writes, in one place. */
export const STORAGE_KEYS = {
    keybinds: 'riverraid.keybinds',
    audio: 'riverraid.audio_settings',
    gameMode: 'riverraid.game_mode',
    /** Phase 4 stored these two separately; they are read once to carry settings over. */
    legacyMuted: 'riverraid.muted',
    legacyVolume: 'riverraid.volume',
} as const;

/** The page's `localStorage`, or null if there is none or it cannot be touched. */
export function defaultStorage(): KeyValueStorage | null {
    try {
        const candidate = (globalThis as { localStorage?: KeyValueStorage }).localStorage;
        return candidate ?? null;
    } catch {
        return null;
    }
}

/**
 * Resolves a constructor option: `undefined` means "use the page's localStorage",
 * `null` means "do not persist at all", anything else is used as given.
 */
export function resolveStorage(option: KeyValueStorage | null | undefined): KeyValueStorage | null {
    return option === undefined ? defaultStorage() : option;
}

export function readItem(storage: KeyValueStorage | null, key: string): string | null {
    if (!storage) return null;
    try {
        return storage.getItem(key);
    } catch {
        return null;
    }
}

export function writeItem(storage: KeyValueStorage | null, key: string, value: string): boolean {
    if (!storage) return false;
    try {
        storage.setItem(key, value);
        return true;
    } catch {
        return false;
    }
}

export function removeItem(storage: KeyValueStorage | null, key: string): boolean {
    if (!storage) return false;
    try {
        storage.removeItem(key);
        return true;
    } catch {
        return false;
    }
}
