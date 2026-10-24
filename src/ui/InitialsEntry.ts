import type { SoundCue } from '../audio/SoundEngine.js';
import { INITIALS_ALPHABET, INITIALS_LENGTH, isInitialsChar, normalizeInitials } from '../systems/HighScoreSystem.js';

/** What the screen needs to know about the run that earned a place. */
export interface InitialsRequest {
    readonly score: number;
    /** The rank the score will take (1 = best). */
    readonly rank: number;
    /** It beat the all-time record: the screen celebrates harder. */
    readonly isRecord: boolean;
}

export interface InitialsEntryOptions {
    document: Document;
    /** Called once with the three initials when the player saves. The screen has already closed. */
    onSubmit(initials: string): void;
    /** Sound hook: `menu-tick` when a letter cycles, `menu-select` per slot, `score-saved` on saving. */
    play?(cue: SoundCue): unknown;
    /** Receives focus when the screen closes (the game canvas). */
    returnFocus?: HTMLElement | null;
    /** Where the screen is added. Default `document.body`. */
    mount?: HTMLElement;
    onOpenChange?(open: boolean): void;
    /** Gamepads to poll. Default: `navigator.getGamepads()`. */
    getGamepads?(): ArrayLike<Gamepad | null>;
    /** Milliseconds clock, for the grace period and stick auto-repeat. Default `performance.now()`. */
    now?(): number;
    /** How the three slots start. Default `AAA`. */
    startInitials?: string;
}

/** Standard-mapping gamepad buttons. */
const PAD_BUTTON = { up: 12, down: 13, left: 14, right: 15, confirm: 0, back: 1, start: 9 } as const;
const STICK_THRESHOLD = 0.6;
/** Held stick / D-pad: first repeat after this long, then at this interval (milliseconds). */
const PAD_REPEAT_DELAY = 380;
const PAD_REPEAT_RATE = 120;
/**
 * A fresh screen ignores the confirm keys for this long. A player who dies holding Fire (or Enter)
 * must not have the screen confirm a slot, or save, before they have even read it.
 */
export const CONFIRM_GRACE_MS = 450;

type PadAction = 'left' | 'right' | 'up' | 'down' | 'confirm' | 'back' | 'start';
const PAD_REPEATS: ReadonlySet<PadAction> = new Set<PadAction>(['left', 'right', 'up', 'down']);

const FOCUSABLE = 'button:not([disabled]), input:not([disabled])';

/**
 * The arcade initials screen: three slots, each cycling through A-Z, 0-9, dot and dash.
 *
 *  - Keyboard: Left/Right (or Backspace) move between slots, Up/Down cycle the letter, typing a
 *    character sets the slot and moves on, Space/Enter confirms the slot, and confirming the third
 *    saves. Letters win over movement keys, so A and D type rather than steer.
 *  - Mouse: click a slot to select it, the triangles to cycle, OK to confirm the slot, DONE to save.
 *  - Gamepad: D-pad or left stick to move and cycle, A to confirm, B to go back, Start to save.
 *  - Touch / on-screen keyboards: the slots are real text inputs, so typing works there too.
 *
 * The slots are text inputs, which is also what makes the page's shortcuts (M, O, H) stand down
 * while typing. The game is NOT paused behind this screen, so the celebration on the canvas keeps
 * animating; the host keeps the run from restarting while it is open.
 */
export class InitialsEntry {
    private readonly doc: Document;
    private readonly win: Window | null;
    private readonly opts: InitialsEntryOptions;
    private readonly root: HTMLElement;
    private readonly dialog: HTMLElement;
    private readonly title: HTMLElement;
    private readonly subtitle: HTMLElement;
    private readonly live: HTMLElement;
    private readonly slotInputs: HTMLInputElement[] = [];
    private readonly cleanups: Array<() => void> = [];
    private readonly chars: string[] = [];
    private readonly heldKeys = new Set<string>();
    private readonly padState = new Map<PadAction, number>();
    private readonly now: () => number;

    private index = 0;
    private isShown = false;
    private destroyed = false;
    private openedAt = 0;
    private padTimer: number | null = null;
    private previousFocus: HTMLElement | null = null;

    constructor(options: InitialsEntryOptions) {
        this.opts = options;
        this.doc = options.document;
        this.win = this.doc.defaultView;
        this.now = options.now ?? ((): number => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
        const build = this.build();
        this.root = build.root;
        this.dialog = build.dialog;
        this.title = build.title;
        this.subtitle = build.subtitle;
        this.live = build.live;
        (options.mount ?? this.doc.body).appendChild(this.root);

        this.listen(this.root, 'click', this.onClick);
        this.listen(this.root, 'keydown', this.onKeyDown);
        this.listen(this.root, 'keyup', this.onKeyUp);
        this.listen(this.root, 'input', this.onInput);
        this.listen(this.root, 'focusin', this.onFocusIn);
        this.listen(this.doc, 'focusin', this.onDocumentFocusIn);
        this.setInitials(options.startInitials ?? 'AAA');
    }

    get isOpen(): boolean {
        return this.isShown;
    }

    /** The three characters as they stand. */
    get initials(): string {
        return this.chars.join('');
    }

    /** The slot (0-2) that will receive the next letter. */
    get slot(): number {
        return this.index;
    }

    /** Shows the screen for a qualifying run. The slots keep what they had, so repeat players start from their last name. */
    open(request: InitialsRequest): void {
        if (this.destroyed) return;
        if (!this.isShown) {
            const active = this.doc.activeElement;
            this.previousFocus = active && 'focus' in active ? active as HTMLElement : null;
        }
        this.isShown = true;
        this.openedAt = this.now();
        this.heldKeys.clear();
        this.index = 0;
        const record = request.isRecord;
        this.dialog.setAttribute('data-tier', record ? 'record' : 'score');
        this.title.textContent = record ? '\u2605 NEW ALL-TIME RECORD! \u2605' : 'NEW HIGH SCORE!';
        this.subtitle.textContent = `SCORE ${Math.floor(request.score).toLocaleString('en-US')}  \u00b7  RANK #${request.rank}`;
        this.root.hidden = false;
        this.render();
        this.focusSlot();
        this.primePads();
        this.startPadPolling();
        this.opts.onOpenChange?.(true);
    }

    /** Closes without saving. */
    close(): void {
        if (!this.isShown) return;
        this.isShown = false;
        this.root.hidden = true;
        this.stopPadPolling();
        const target = this.opts.returnFocus ?? this.previousFocus;
        this.previousFocus = null;
        target?.focus();
        this.opts.onOpenChange?.(false);
    }

    destroy(): void {
        if (this.destroyed) return;
        this.close();
        this.destroyed = true;
        for (const cleanup of this.cleanups.splice(0)) cleanup();
        this.root.remove();
    }

    // ------------------------------------------------------- the picker itself

    /** Sets all three characters (anything unusable becomes a dot) and selects the first slot. */
    setInitials(value: string): void {
        const text = normalizeInitials(value);
        for (let i = 0; i < INITIALS_LENGTH; i++) this.chars[i] = text.charAt(i);
        this.index = 0;
        this.render();
    }

    /** Selects a slot (clamped to 0-2). */
    selectSlot(slot: number): void {
        this.index = Math.max(0, Math.min(INITIALS_LENGTH - 1, Math.trunc(Number.isFinite(slot) ? slot : 0)));
        this.render();
        if (this.isShown) this.focusSlot();
    }

    /** Moves the selection one slot left or right, stopping at the ends. */
    move(delta: -1 | 1): void {
        const next = Math.max(0, Math.min(INITIALS_LENGTH - 1, this.index + delta));
        if (next === this.index) return;
        this.selectSlot(next);
    }

    /** Steps the selected slot through the alphabet (+1 = next character, -1 = previous), wrapping round. */
    cycle(delta: -1 | 1): void {
        const at = INITIALS_ALPHABET.indexOf(this.chars[this.index] ?? 'A');
        const size = INITIALS_ALPHABET.length;
        this.chars[this.index] = INITIALS_ALPHABET.charAt((((at < 0 ? 0 : at) + delta) % size + size) % size);
        this.render();
        this.opts.play?.('menu-tick');
    }

    /** Puts a character in the selected slot and moves to the next. Returns false if it is not allowed. */
    typeChar(char: string): boolean {
        const upper = char.toUpperCase();
        if (!isInitialsChar(upper)) return false;
        this.chars[this.index] = upper;
        this.opts.play?.('menu-select');
        if (this.index < INITIALS_LENGTH - 1) this.index++;
        this.render();
        if (this.isShown) this.focusSlot();
        return true;
    }

    /** One step back: to the previous slot, ready to overwrite it. Does nothing on the first slot. */
    back(): void {
        if (this.index === 0) return;
        this.opts.play?.('menu-tick');
        this.selectSlot(this.index - 1);
    }

    /** Confirms the selected slot: moves to the next, and on the last one saves. */
    confirmSlot(): void {
        if (this.index < INITIALS_LENGTH - 1) {
            this.opts.play?.('menu-select');
            this.selectSlot(this.index + 1);
        } else {
            this.save();
        }
    }

    /** Saves the initials as they stand and closes. Does nothing if the screen is not open. */
    save(): void {
        if (!this.isShown) return;
        const initials = normalizeInitials(this.initials);
        this.opts.play?.('score-saved');
        this.close();
        this.opts.onSubmit(initials);
    }

    // ------------------------------------------------------------------ gamepad

    /** Treats whatever is already held when the screen opens as "not pressed yet", until it is let go. */
    private primePads(): void {
        this.padState.clear();
        for (const action of this.readPadActions()) this.padState.set(action, Infinity);
    }

    private startPadPolling(): void {
        this.stopPadPolling();
        if (this.win) this.padTimer = this.win.setInterval(() => this.pollGamepads(), 40);
    }

    private stopPadPolling(): void {
        if (this.padTimer !== null && this.win) this.win.clearInterval(this.padTimer);
        this.padTimer = null;
    }

    private readPadActions(): Set<PadAction> {
        const down = new Set<PadAction>();
        let pads: ArrayLike<Gamepad | null> = [];
        try {
            pads = this.opts.getGamepads
                ? this.opts.getGamepads()
                : (this.win?.navigator.getGamepads?.() ?? []);
        } catch {
            pads = [];
        }
        for (let i = 0; i < pads.length; i++) {
            const pad = pads[i];
            if (!pad || !pad.connected) continue;
            const pressed = (index: number): boolean => pad.buttons[index]?.pressed === true;
            const x = pad.axes[0] ?? 0;
            const y = pad.axes[1] ?? 0;
            if (pressed(PAD_BUTTON.left) || x < -STICK_THRESHOLD) down.add('left');
            if (pressed(PAD_BUTTON.right) || x > STICK_THRESHOLD) down.add('right');
            if (pressed(PAD_BUTTON.up) || y < -STICK_THRESHOLD) down.add('up');
            if (pressed(PAD_BUTTON.down) || y > STICK_THRESHOLD) down.add('down');
            if (pressed(PAD_BUTTON.confirm)) down.add('confirm');
            if (pressed(PAD_BUTTON.back)) down.add('back');
            if (pressed(PAD_BUTTON.start)) down.add('start');
        }
        return down;
    }

    /**
     * Reads the gamepads once and acts on new presses: a direction repeats while held, buttons do not.
     * Called on a timer while the screen is open; public so a test can drive it with a fake clock.
     */
    pollGamepads(at: number = this.now()): void {
        if (!this.isShown) return;
        const down = this.readPadActions();
        for (const action of [...this.padState.keys()]) if (!down.has(action)) this.padState.delete(action);
        for (const action of down) {
            const nextRepeat = this.padState.get(action);
            if (nextRepeat === undefined) {
                this.padState.set(action, PAD_REPEATS.has(action) ? at + PAD_REPEAT_DELAY : Infinity);
                this.applyPad(action, at);
            } else if (at >= nextRepeat) {
                this.padState.set(action, at + PAD_REPEAT_RATE);
                this.applyPad(action, at);
            }
        }
    }

    private applyPad(action: PadAction, at: number): void {
        switch (action) {
            case 'left': this.move(-1); break;
            case 'right': this.move(1); break;
            case 'up': this.cycle(1); break;
            case 'down': this.cycle(-1); break;
            case 'back': this.back(); break;
            case 'confirm':
                if (at - this.openedAt >= CONFIRM_GRACE_MS) this.confirmSlot();
                break;
            case 'start':
                if (at - this.openedAt >= CONFIRM_GRACE_MS) this.save();
                break;
        }
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

    private build(): { root: HTMLElement; dialog: HTMLElement; title: HTMLElement; subtitle: HTMLElement; live: HTMLElement } {
        const root = this.el('div', { class: 'hs-backdrop', 'data-ui': '', hidden: '' });
        const dialog = this.el('div', {
            class: 'hs-dialog hs-initials', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'hs-initials-title', tabindex: '-1', 'data-tier': 'score',
        });
        root.appendChild(dialog);
        const title = this.el('h2', { id: 'hs-initials-title', class: 'hs-title' }, 'NEW HIGH SCORE!');
        dialog.appendChild(title);
        const subtitle = this.el('p', { class: 'hs-subtitle' });
        dialog.appendChild(subtitle);
        dialog.appendChild(this.el('p', { class: 'hs-prompt' }, 'ENTER YOUR INITIALS'));

        const slots = this.el('div', { class: 'hs-slots', role: 'group', 'aria-label': 'Initials' });
        for (let i = 0; i < INITIALS_LENGTH; i++) {
            const cell = this.el('div', { class: 'hs-slot-cell' });
            cell.appendChild(this.el('button', {
                type: 'button', class: 'hs-step', 'data-role': 'up', 'data-slot': String(i), 'aria-label': `Next character for letter ${i + 1}`,
            }, '\u25b2'));
            const input = this.el('input', {
                type: 'text', class: 'hs-slot', maxlength: '1', 'data-slot': String(i), autocomplete: 'off', autocapitalize: 'characters',
                spellcheck: 'false', inputmode: 'text', 'aria-label': `Initial ${i + 1} of ${INITIALS_LENGTH}`,
            });
            this.slotInputs.push(input);
            cell.appendChild(input);
            cell.appendChild(this.el('button', {
                type: 'button', class: 'hs-step', 'data-role': 'down', 'data-slot': String(i), 'aria-label': `Previous character for letter ${i + 1}`,
            }, '\u25bc'));
            slots.appendChild(cell);
        }
        dialog.appendChild(slots);

        const live = this.el('p', { class: 'hs-live', role: 'status', 'aria-live': 'polite' });
        dialog.appendChild(live);

        const actions = this.el('div', { class: 'hs-actions' });
        actions.appendChild(this.el('button', { type: 'button', class: 'options-button', 'data-role': 'confirm' }, 'OK \u25b8'));
        actions.appendChild(this.el('button', { type: 'button', class: 'options-button options-primary', 'data-role': 'done' }, 'DONE'));
        dialog.appendChild(actions);

        dialog.appendChild(this.el('p', { class: 'hs-help' },
            '\u2190 \u2192 move   \u2191 \u2193 change   type letters   SPACE / ENTER ok   BACKSPACE back   GAMEPAD: D-PAD, A ok, B back, START done'));
        return { root, dialog, title, subtitle, live };
    }

    private listen<T extends Event>(target: EventTarget, type: string, handler: (event: T) => void): void {
        const listener = handler as (event: Event) => void;
        target.addEventListener(type, listener);
        this.cleanups.push(() => target.removeEventListener(type, listener));
    }

    private render(): void {
        this.slotInputs.forEach((input, i) => {
            const char = this.chars[i] ?? 'A';
            if (input.value !== char) input.value = char;
            if (i === this.index) input.setAttribute('data-active', '');
            else input.removeAttribute('data-active');
        });
        this.live.textContent = `Letter ${this.index + 1} of ${INITIALS_LENGTH}: ${this.chars[this.index] ?? ''}. Initials ${this.initials}.`;
    }

    private focusSlot(): void {
        const input = this.slotInputs[this.index];
        if (!input) return;
        input.focus({ preventScroll: true });
        input.select();
    }

    // ------------------------------------------------------------------- events

    private slotOf(element: Element | null): number | null {
        const raw = element?.getAttribute('data-slot');
        if (raw === null || raw === undefined) return null;
        const slot = Number(raw);
        return Number.isInteger(slot) && slot >= 0 && slot < INITIALS_LENGTH ? slot : null;
    }

    private readonly onClick = (event: MouseEvent): void => {
        const control = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-role]');
        if (!control || !this.root.contains(control)) return;
        const slot = this.slotOf(control);
        switch (control.getAttribute('data-role')) {
            case 'up':
                if (slot !== null) {
                    this.index = slot;
                    this.cycle(1);
                    this.focusSlot();
                }
                break;
            case 'down':
                if (slot !== null) {
                    this.index = slot;
                    this.cycle(-1);
                    this.focusSlot();
                }
                break;
            case 'confirm':
                this.confirmSlot();
                break;
            case 'done':
                this.save();
                break;
            default:
                break;
        }
    };

    /** Picking a slot with the mouse or Tab makes it the one that receives letters. */
    private readonly onFocusIn = (event: FocusEvent): void => {
        const target = event.target as HTMLElement | null;
        if (target?.classList.contains('hs-slot')) {
            const slot = this.slotOf(target);
            if (slot !== null && slot !== this.index) {
                this.index = slot;
                this.render();
            }
        }
    };

    /** Focus never leaves the screen while it is open. */
    private readonly onDocumentFocusIn = (event: FocusEvent): void => {
        if (!this.isShown) return;
        const target = event.target as Node | null;
        if (target && !this.root.contains(target)) this.focusSlot();
    };

    /** On-screen keyboards report text through `input`, not through useful key events. */
    private readonly onInput = (event: Event): void => {
        const input = event.target as HTMLInputElement | null;
        if (!input || !input.classList.contains('hs-slot')) return;
        const slot = this.slotOf(input);
        if (slot !== null) this.index = slot;
        const typed = [...input.value.toUpperCase()].filter(isInitialsChar).pop();
        input.value = this.chars[this.index] ?? 'A';
        if (typed !== undefined) this.typeChar(typed);
        else this.render();
    };

    private readonly onKeyDown = (event: KeyboardEvent): void => {
        if (!this.isShown || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
        const key = event.key;
        if (key === 'Tab') {
            this.trapFocus(event);
            return;
        }
        const arrow = key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown';
        if (event.repeat) {
            // A key already held when the screen opened, or a held letter, must not act. Only an arrow
            // that was pressed after the screen opened may auto-repeat.
            if (arrow && this.heldKeys.has(key)) this.actOnKey(event, key);
            else if (this.handles(key)) event.preventDefault();
            return;
        }
        this.heldKeys.add(key);
        this.actOnKey(event, key);
    };

    private readonly onKeyUp = (event: KeyboardEvent): void => {
        this.heldKeys.delete(event.key);
    };

    /** True for every key this screen reacts to, so the browser does not also act on it. */
    private handles(key: string): boolean {
        return key.startsWith('Arrow') || key === 'Enter' || key === ' ' || key === 'Backspace' || key === 'Delete' || key === 'Escape' || key.length === 1;
    }

    private actOnKey(event: KeyboardEvent, key: string): void {
        const onButton = (event.target as HTMLElement | null)?.closest('button') != null;
        switch (key) {
            case 'ArrowLeft': event.preventDefault(); this.move(-1); break;
            case 'ArrowRight': event.preventDefault(); this.move(1); break;
            case 'ArrowUp': event.preventDefault(); this.cycle(1); break;
            case 'ArrowDown': event.preventDefault(); this.cycle(-1); break;
            case 'Backspace':
            case 'Delete':
                event.preventDefault();
                this.back();
                break;
            case 'Escape':
                event.preventDefault(); // there is no way out but to enter something
                break;
            case 'Enter':
            case ' ':
                if (onButton) return; // let the focused button's own click do it
                event.preventDefault();
                if (this.now() - this.openedAt >= CONFIRM_GRACE_MS) this.confirmSlot();
                break;
            default:
                if (key.length === 1) {
                    event.preventDefault();
                    this.typeChar(key);
                }
                break;
        }
    }

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
        if (event.shiftKey && (active === first || !this.dialog.contains(active))) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && (active === last || !this.dialog.contains(active))) {
            event.preventDefault();
            first.focus();
        }
    }
}
