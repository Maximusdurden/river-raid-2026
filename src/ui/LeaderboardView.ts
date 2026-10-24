import { MAX_HIGH_SCORES, type HighScoreEntry } from '../systems/HighScoreSystem.js';

/** The part of `HighScoreBoard` the view reads. */
export interface LeaderboardSource {
    readonly entries: readonly HighScoreEntry[];
    /** Rank of the most recently saved run if it is still on the table. */
    readonly latestRank: number | null;
    subscribe(listener: (entries: readonly HighScoreEntry[]) => void): () => void;
}

export interface LeaderboardViewOptions {
    document: Document;
    board: LeaderboardSource;
    /** Freezes the game while the table is open; returns the release function (`Engine.holdPause`). */
    holdPause(): () => void;
    /** Receives focus when the table closes (the game canvas). */
    returnFocus?: HTMLElement | null;
    /** Where the table is added. Default `document.body`. */
    mount?: HTMLElement;
    /** Asked before the H key opens the table; return false to refuse (another screen is up). */
    canOpen?(): boolean;
    onOpenChange?(open: boolean): void;
}

export const LEADERBOARD_OPEN_CODE = 'KeyH';

const TEXT_ENTRY = 'textarea, [contenteditable]:not([contenteditable="false"]), '
    + 'input:not([type]), input[type="text"], input[type="search"], input[type="email"], '
    + 'input[type="number"], input[type="password"], input[type="url"], input[type="tel"]';

function isTextEntry(target: EventTarget | null): boolean {
    if (!target || !('nodeType' in target) || (target as Node).nodeType !== 1) return false;
    const element = target as HTMLElement;
    return element.isContentEditable || element.closest(TEXT_ENTRY) !== null;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/** 1 -> "1ST", 2 -> "2ND", 11 -> "11TH". */
export function ordinal(rank: number): string {
    const n = Math.abs(Math.trunc(rank));
    const tail = n % 100;
    const suffix = tail >= 11 && tail <= 13 ? 'TH' : ({ 1: 'ST', 2: 'ND', 3: 'RD' } as Record<number, string>)[n % 10] ?? 'TH';
    return `${n}${suffix}`;
}

export const MODE_LABEL = { campaign: 'CAMPAIGN', endless: 'ENDLESS' } as const;

/**
 * The Hall of Fame screen: the top ten on a CRT-green-and-amber table, with the player's latest run
 * blinking. Open it from the "High Scores" button or the H key (not while typing in a text field,
 * with a modifier, or while another screen is up); Esc, H, Done or a click outside closes it.
 * The game is held paused while it is open, and focus returns to the canvas when it closes.
 */
export class LeaderboardView {
    private readonly doc: Document;
    private readonly win: Window | null;
    private readonly opts: LeaderboardViewOptions;
    private readonly root: HTMLElement;
    private readonly dialog: HTMLElement;
    private readonly body: HTMLElement;
    private readonly cleanups: Array<() => void> = [];

    private isShown = false;
    private destroyed = false;
    private releasePause: (() => void) | null = null;
    private previousFocus: HTMLElement | null = null;
    private pressStartedOnBackdrop = false;

    constructor(options: LeaderboardViewOptions) {
        this.opts = options;
        this.doc = options.document;
        this.win = this.doc.defaultView;
        const build = this.build();
        this.root = build.root;
        this.dialog = build.dialog;
        this.body = build.body;
        (options.mount ?? this.doc.body).appendChild(this.root);

        this.listen(this.root, 'click', this.onClick);
        this.listen(this.root, 'mousedown', (event: MouseEvent) => {
            this.pressStartedOnBackdrop = event.target === this.root;
        });
        if (this.win) this.listen(this.win, 'keydown', this.onKeyDown);
        this.listen(this.doc, 'focusin', this.onFocusIn);
        this.cleanups.push(options.board.subscribe(() => this.render()));
        this.render();
    }

    get isOpen(): boolean {
        return this.isShown;
    }

    open(): void {
        if (this.isShown || this.destroyed) return;
        this.isShown = true;
        const active = this.doc.activeElement;
        this.previousFocus = active && 'focus' in active ? active as HTMLElement : null;
        this.releasePause = this.opts.holdPause();
        this.render();
        this.root.hidden = false;
        this.dialog.focus();
        this.opts.onOpenChange?.(true);
    }

    close(): void {
        if (!this.isShown) return;
        this.isShown = false;
        this.root.hidden = true;
        this.releasePause?.();
        this.releasePause = null;
        const target = this.opts.returnFocus ?? this.previousFocus;
        this.previousFocus = null;
        target?.focus();
        this.opts.onOpenChange?.(false);
    }

    toggle(): void {
        if (this.isShown) this.close();
        else this.open();
    }

    destroy(): void {
        if (this.destroyed) return;
        this.close();
        this.destroyed = true;
        for (const cleanup of this.cleanups.splice(0)) cleanup();
        this.root.remove();
    }

    // ------------------------------------------------------------------ building

    private el<K extends keyof HTMLElementTagNameMap>(
        tag: K,
        attributes: Readonly<Record<string, string>> = {},
        text?: string,
    ): HTMLElementTagNameMap[K] {
        const element = this.doc.createElement(tag);
        for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
        if (text !== undefined) element.textContent = text;
        return element;
    }

    private build(): { root: HTMLElement; dialog: HTMLElement; body: HTMLElement } {
        const root = this.el('div', { class: 'hs-backdrop', 'data-ui': '', hidden: '' });
        const dialog = this.el('div', {
            class: 'hs-dialog hs-board', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'hs-board-title', tabindex: '-1',
        });
        root.appendChild(dialog);

        const header = this.el('div', { class: 'hs-board-header' });
        header.appendChild(this.el('h2', { id: 'hs-board-title', class: 'hs-title' }, '\ud83c\udfc6 HIGH SCORES'));
        header.appendChild(this.el('button', { type: 'button', class: 'options-close', 'data-role': 'close', 'aria-label': 'Close high scores' }, '\u2715'));
        dialog.appendChild(header);

        const table = this.el('table', { class: 'hs-table' });
        table.appendChild(this.el('caption', { class: 'hs-sr-only' }, `The ${MAX_HIGH_SCORES} best runs`));
        const head = this.el('thead');
        const headRow = this.el('tr');
        for (const label of ['RANK', 'NAME', 'SCORE', 'BRIDGES', 'MODE', 'DATE']) headRow.appendChild(this.el('th', { scope: 'col' }, label));
        head.appendChild(headRow);
        table.appendChild(head);
        const body = this.el('tbody');
        table.appendChild(body);
        dialog.appendChild(table);

        const footer = this.el('div', { class: 'hs-board-footer' });
        footer.appendChild(this.el('span', { class: 'hs-help' }, 'H or ESC closes. The game is paused while this is open.'));
        footer.appendChild(this.el('button', { type: 'button', class: 'options-button options-primary', 'data-role': 'close' }, 'DONE'));
        dialog.appendChild(footer);
        return { root, dialog, body };
    }

    private listen<T extends Event>(target: EventTarget, type: string, handler: (event: T) => void): void {
        const listener = handler as (event: Event) => void;
        target.addEventListener(type, listener);
        this.cleanups.push(() => target.removeEventListener(type, listener));
    }

    // ----------------------------------------------------------------- rendering

    /** Rebuilds the ten rows: real entries first, then placeholder rows so the table is always the same height. */
    private render(): void {
        const entries = this.opts.board.entries;
        const latest = this.opts.board.latestRank;
        this.body.textContent = '';
        for (let i = 0; i < MAX_HIGH_SCORES; i++) {
            const entry = entries[i];
            const row = this.el('tr', { class: 'hs-row', 'data-rank': String(i + 1) });
            if (!entry) {
                row.setAttribute('data-empty', '');
                row.appendChild(this.el('td', { class: 'hs-rank' }, ordinal(i + 1)));
                for (let c = 0; c < 5; c++) row.appendChild(this.el('td', {}, '---'));
                this.body.appendChild(row);
                continue;
            }
            const isLatest = latest !== null && entry.rank === latest;
            if (isLatest) row.setAttribute('data-latest', '');
            row.appendChild(this.el('td', { class: 'hs-rank' }, ordinal(entry.rank)));
            const name = this.el('td', { class: 'hs-name' }, entry.initials);
            row.appendChild(name);
            row.appendChild(this.el('td', { class: 'hs-score' }, entry.score.toLocaleString('en-US')));
            row.appendChild(this.el('td', {}, String(entry.bridgesCleared)));
            row.appendChild(this.el('td', {}, MODE_LABEL[entry.mode]));
            const date = this.el('td', { class: 'hs-date' }, entry.date);
            if (isLatest) date.appendChild(this.el('span', { class: 'hs-latest-mark' }, ' \u25c0 NEW'));
            row.appendChild(date);
            this.body.appendChild(row);
        }
    }

    // ------------------------------------------------------------------- events

    private readonly onClick = (event: MouseEvent): void => {
        const target = event.target as HTMLElement | null;
        if (target?.closest('[data-role="close"]')) {
            this.close();
        } else if (target === this.root && this.pressStartedOnBackdrop) {
            this.close();
        }
        this.pressStartedOnBackdrop = false;
    };

    private readonly onKeyDown = (event: KeyboardEvent): void => {
        if (this.destroyed) return;
        if (event.code === LEADERBOARD_OPEN_CODE) {
            if (event.repeat || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
            if (isTextEntry(event.target)) return;
            if (!this.isShown && this.opts.canOpen && !this.opts.canOpen()) return;
            event.preventDefault();
            this.toggle();
            return;
        }
        if (!this.isShown) return;
        if (event.code === 'Escape') {
            event.preventDefault();
            this.close();
        } else if (event.code === 'Tab') {
            this.trapFocus(event);
        }
    };

    private trapFocus(event: KeyboardEvent): void {
        const items = [...this.dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
        const first = items[0];
        const last = items[items.length - 1];
        if (!first || !last) {
            event.preventDefault();
            this.dialog.focus();
            return;
        }
        const active = this.doc.activeElement;
        if (!active || !this.dialog.contains(active) || active === this.dialog) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && active === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
        }
    }

    private readonly onFocusIn = (event: FocusEvent): void => {
        if (!this.isShown) return;
        const target = event.target as Node | null;
        if (target && !this.root.contains(target)) this.dialog.focus();
    };
}
