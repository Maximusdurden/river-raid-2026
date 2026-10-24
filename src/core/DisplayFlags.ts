/**
 * Which developer overlays are on at startup.
 *
 * Both are OFF by default, on every fresh load and every reload, so players never see debug text or
 * hitbox outlines. They exist for development and can be turned on in two ways, neither of which is
 * remembered between sessions: the "Hitboxes" / "Debug" checkboxes in the page header, or a dev flag
 * in the URL (`?debug=1`, `?hitboxes=1`, or `?dev=1` for both).
 */
export interface DisplayFlags {
    /** Outline every hitbox and draw the guide lines. */
    showHitboxes: boolean;
    /** The performance and state text over the playfield. */
    showDebugOverlay: boolean;
}

export const DEFAULT_DISPLAY_FLAGS: Readonly<DisplayFlags> = {
    showHitboxes: false,
    showDebugOverlay: false,
};

const TRUTHY: ReadonlySet<string> = new Set(['1', 'true', 'yes', 'on']);

/** True only for an explicit on-value (1, true, yes, on, in any case). A bare `?debug` or anything else is off. */
export function parseFlag(value: string | null): boolean {
    return value !== null && TRUTHY.has(value.trim().toLowerCase());
}

/** The flags for a page URL's query string (with or without the leading `?`). */
export function resolveDisplayFlags(search: string): DisplayFlags {
    const params = new URLSearchParams(search);
    const dev = parseFlag(params.get('dev'));
    return {
        showHitboxes: dev || parseFlag(params.get('hitboxes')),
        showDebugOverlay: dev || parseFlag(params.get('debug')),
    };
}
