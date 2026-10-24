import { STORAGE_KEYS, readItem, removeItem, resolveStorage, writeItem, type KeyValueStorage } from './Storage.js';

/** One immutable-by-convention snapshot per call to update(). */
export interface InputState {
    moveX: number;
    /** Positive = accelerate (up); negative = brake (down). */
    moveY: number;
    fire: boolean;
    firePressed: boolean;
    pausePressed: boolean;
    activeDevice: 'keyboard' | 'gamepad';
}

export interface InputManagerOptions {
    /** Axial stick deadzone in [0, 1). Default: 0.15. */
    deadzone?: number;
    /** Normalized stick change needed to claim activity. Default: 0.02. */
    activityThreshold?: number;
    /**
     * Where custom keybinds are saved (`riverraid.keybinds`). Omit to use the page's
     * `localStorage`; pass `null` to neither load nor save.
     */
    storage?: KeyValueStorage | null;
}

// ------------------------------------------------------------------- key bindings

/**
 * Which physical inputs trigger each gameplay action. Codes are `KeyboardEvent.code`
 * values (`KeyA`, `Space`, `ArrowLeft`...) or the synthetic mouse codes `Mouse0` (left),
 * `Mouse1` (middle) and `Mouse2` (right), plus `Mouse3` / `Mouse4` for the side buttons.
 * Any listed code triggers the action. Serialisable as plain JSON.
 */
export interface KeybindConfig {
    moveLeft: string[];
    moveRight: string[];
    /** Boost: raises the throttle. */
    accelerate: string[];
    /** Brake: lowers the throttle. */
    brake: string[];
    fire: string[];
    pause: string[];
}

export type KeybindAction = keyof KeybindConfig;

export const KEYBIND_ACTIONS: readonly KeybindAction[] = ['moveLeft', 'moveRight', 'accelerate', 'brake', 'fire', 'pause'];

export const DEFAULT_KEYBINDS: Readonly<{ readonly [A in KeybindAction]: readonly string[] }> = {
    moveLeft: ['ArrowLeft', 'KeyA'],
    moveRight: ['ArrowRight', 'KeyD'],
    accelerate: ['ArrowUp', 'KeyW'],
    brake: ['ArrowDown', 'KeyS'],
    fire: ['Space', 'KeyJ', 'Mouse0', 'Enter'],
    pause: ['Escape', 'KeyP'],
};

/** Short names for the settings screen, in display order. */
export const ACTION_LABELS: Readonly<Record<KeybindAction, string>> = {
    moveLeft: 'Left',
    moveRight: 'Right',
    accelerate: 'Boost',
    brake: 'Brake',
    fire: 'Fire',
    pause: 'Pause',
};

/** Hard-wired page shortcuts: they can never be bound to an action. */
export const RESERVED_CODES: Readonly<Record<string, string>> = { KeyM: 'mute', KeyO: 'options', KeyH: 'high scores' };

/** Most inputs one action may have. */
export const MAX_KEYS_PER_ACTION = 6;

const CODE_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const MOUSE_PATTERN = /^Mouse[0-4]$/;

export function isValidKeyCode(code: unknown): code is string {
    return typeof code === 'string' && CODE_PATTERN.test(code);
}

export function isMouseCode(code: string): boolean {
    return MOUSE_PATTERN.test(code);
}

/** `MouseEvent.button` -> synthetic code (0 = Mouse0 ... 4 = Mouse4); null for anything else. */
export function mouseCode(button: number): string | null {
    return Number.isInteger(button) && button >= 0 && button <= 4 ? `Mouse${button}` : null;
}

export function cloneKeybinds(config: Readonly<{ readonly [A in KeybindAction]: readonly string[] }>): KeybindConfig {
    return {
        moveLeft: [...config.moveLeft],
        moveRight: [...config.moveRight],
        accelerate: [...config.accelerate],
        brake: [...config.brake],
        fire: [...config.fire],
        pause: [...config.pause],
    };
}

export function defaultKeybinds(): KeybindConfig {
    return cloneKeybinds(DEFAULT_KEYBINDS);
}

/**
 * Turns anything (usually parsed JSON) into a usable config. It never throws: each action
 * keeps its valid, de-duplicated, non-reserved codes (at most `MAX_KEYS_PER_ACTION`), and
 * falls back to its default if nothing valid is left. So one corrupt entry cannot take
 * the other actions' bindings down with it, and an action can never end up with no input.
 */
export function sanitizeKeybinds(raw: unknown): KeybindConfig {
    const result = defaultKeybinds();
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return result;
    const record = raw as Record<string, unknown>;
    for (const action of KEYBIND_ACTIONS) {
        const value = record[action];
        if (!Array.isArray(value)) continue;
        const codes: string[] = [];
        for (const entry of value) {
            if (isValidKeyCode(entry) && !(entry in RESERVED_CODES) && !codes.includes(entry)) codes.push(entry);
            if (codes.length >= MAX_KEYS_PER_ACTION) break;
        }
        if (codes.length > 0) result[action] = codes;
    }
    return result;
}

/** Parses saved JSON text. Missing, malformed or hostile text gives the defaults. */
export function parseKeybinds(text: string | null | undefined): KeybindConfig {
    if (!text) return defaultKeybinds();
    try {
        return sanitizeKeybinds(JSON.parse(text) as unknown);
    } catch {
        return defaultKeybinds();
    }
}

export function serializeKeybinds(config: Readonly<{ readonly [A in KeybindAction]: readonly string[] }>): string {
    return JSON.stringify(cloneKeybinds(config));
}

/** The actions (other than `except`) that already use `code`. */
export function findKeyConflicts(
    config: Readonly<{ readonly [A in KeybindAction]: readonly string[] }>,
    code: string,
    except?: KeybindAction,
): KeybindAction[] {
    return KEYBIND_ACTIONS.filter(action => action !== except && config[action].includes(code));
}

export interface BindingChange {
    /** The new config; the input config unchanged when `error` is set. */
    readonly config: KeybindConfig;
    /** Why the change was refused, in words fit for the settings screen. */
    readonly error: string | null;
    /** Other actions that lost this input because it moved here. */
    readonly stolenFrom: readonly KeybindAction[];
}

/**
 * Gives `code` to `action`, the way a settings screen should:
 *  - `replace`: the action's inputs become just `[code]`; `add`: `code` joins them.
 *  - An input used by another action moves here and is removed from the other one,
 *    unless that would leave the other action with nothing (then the change is refused).
 *  - Reserved page shortcuts and invalid codes are refused.
 */
export function assignKey(
    config: Readonly<{ readonly [A in KeybindAction]: readonly string[] }>,
    action: KeybindAction,
    code: string,
    mode: 'replace' | 'add',
): BindingChange {
    const unchanged = cloneKeybinds(config);
    const refuse = (error: string): BindingChange => ({ config: unchanged, error, stolenFrom: [] });
    if (!isValidKeyCode(code)) return refuse('That input is not supported.');
    const reason = RESERVED_CODES[code];
    if (reason !== undefined) return refuse(`${describeKeyCode(code)} is reserved for ${reason}.`);
    if (mode === 'add' && config[action].includes(code)) return refuse(`${describeKeyCode(code)} is already used for ${ACTION_LABELS[action]}.`);
    if (mode === 'add' && config[action].length >= MAX_KEYS_PER_ACTION) return refuse(`${ACTION_LABELS[action]} already has ${MAX_KEYS_PER_ACTION} inputs.`);

    const next = cloneKeybinds(config);
    const stolen: KeybindAction[] = [];
    for (const other of findKeyConflicts(config, code, action)) {
        const remaining = next[other].filter(c => c !== code);
        if (remaining.length === 0) {
            return refuse(`${describeKeyCode(code)} is the only input for ${ACTION_LABELS[other]}. Give ${ACTION_LABELS[other]} another input first.`);
        }
        next[other] = remaining;
        stolen.push(other);
    }
    next[action] = mode === 'replace' ? [code] : [...next[action], code];
    return { config: next, error: null, stolenFrom: stolen };
}

const CODE_NAMES: Readonly<Record<string, string>> = {
    Space: 'Space', Enter: 'Enter', NumpadEnter: 'Numpad Enter', Escape: 'Esc', Tab: 'Tab', Backspace: 'Backspace',
    Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'Page Up', PageDown: 'Page Down',
    ArrowLeft: 'Left Arrow', ArrowRight: 'Right Arrow', ArrowUp: 'Up Arrow', ArrowDown: 'Down Arrow',
    ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl',
    AltLeft: 'Left Alt', AltRight: 'Right Alt', MetaLeft: 'Left Meta', MetaRight: 'Right Meta',
    CapsLock: 'Caps Lock', ContextMenu: 'Menu', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[',
    BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: '\'', Comma: ',', Period: '.', Slash: '/',
    NumpadAdd: 'Numpad +', NumpadSubtract: 'Numpad -', NumpadMultiply: 'Numpad *', NumpadDivide: 'Numpad /',
    NumpadDecimal: 'Numpad .',
    Mouse0: 'Left Click', Mouse1: 'Middle Click', Mouse2: 'Right Click', Mouse3: 'Mouse Back', Mouse4: 'Mouse Forward',
};

/** A human-readable name for an input code: `Mouse0` -> "Left Click", `KeyA` -> "A", `ArrowLeft` -> "Left Arrow". */
export function describeKeyCode(code: string): string {
    const named = CODE_NAMES[code];
    if (named !== undefined) return named;
    const letter = /^Key([A-Z])$/.exec(code);
    if (letter?.[1]) return letter[1];
    const digit = /^Digit([0-9])$/.exec(code);
    if (digit?.[1]) return digit[1];
    const pad = /^Numpad([0-9])$/.exec(code);
    if (pad?.[1]) return `Numpad ${pad[1]}`;
    if (/^F\d{1,2}$/.test(code)) return code;
    return code.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

interface Controls {
    moveX: number;
    moveY: number;
    fire: boolean;
    pause: boolean;
}

interface PadHistory {
    controls: Controls;
    activity: number;
}

const SCROLL_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space']);
/** How long after a captured click the follow-up `click` / `contextmenu` is still swallowed. */
const SWALLOW_MS = 1000;

function neutral(): Controls {
    return { moveX: 0, moveY: 0, fire: false, pause: false };
}

function hasInput(controls: Controls): boolean {
    return controls.moveX !== 0 || controls.moveY !== 0 || controls.fire || controls.pause;
}

function hasMovement(controls: Controls): boolean {
    return controls.moveX !== 0 || controls.moveY !== 0;
}

/**
 * Standalone DOM/Gamepad adapter. Call update() exactly once per animation frame,
 * including paused frames, and share its snapshot with all game systems.
 *
 * attach(canvas) captures input only while that element or a non-editable child
 * has focus; clicking the element focuses it. attach() / attach(window) captures
 * page-wide input except in editable controls and (for the mouse) other page controls.
 * Hidden/unfocused pages are neutral.
 *
 * Keys and mouse buttons are treated alike: both are "codes" held in one set and matched
 * against the (rebindable, persisted) `KeybindConfig`. Mouse presses use the synthetic codes
 * `Mouse0` / `Mouse1` / `Mouse2`. Releases are listened for on the window, so letting go
 * outside the canvas never leaves a button stuck. `activeDevice` reports 'keyboard' for
 * the mouse too.
 *
 * `listenNextInput()` serves a settings screen: while it is waiting, the next key press or
 * mouse press is captured before the game, the page or any control can see it, and the
 * follow-up `keyup` / `click` / `contextmenu` that would otherwise activate the control
 * under the pointer is swallowed too.
 *
 * Latest meaningful activity wins metadata and movement priority. Unchanged held
 * controls and keyboard auto-repeat never steal ownership back. When the preferred
 * device has no movement, the other device can steer. Actions are OR-combined
 * before edge detection. Standard-mapped controllers are supported; custom/unknown
 * mappings are intentionally ignored rather than guessing their button layout.
 */
export class InputManager {
    private readonly deadzone: number;
    private readonly activityThreshold: number;
    private readonly keys = new Set<string>();
    private readonly pads = new Map<number, PadHistory>();
    private host: Window | null = null;
    private document: Document | null = null;
    private element: HTMLElement | null = null;
    private addedTabIndex = false;
    private focused = true;
    private sequence = 0;
    private keyboardActivity = 0;
    private gamepadActivity = 0;
    private activeDevice: InputState['activeDevice'] = 'keyboard';
    private previousFire = false;
    private previousPause = false;
    private lastPadFire = false;
    private lastPadPause = false;
    private pendingFire = false;
    private pendingPause = false;

    private readonly storage: KeyValueStorage | null;
    private bindings: KeybindConfig;
    /** Every code bound to some action: the only ones the game reacts to. */
    private relevant = new Set<string>();
    private readonly bindingListeners = new Set<(config: Readonly<KeybindConfig>) => void>();
    private readonly captures = new Set<(code: string) => void>();
    private readonly swallowKeyUps = new Set<string>();
    private swallowClickUntil = 0;
    private swallowContextMenuUntil = 0;

    constructor(options: InputManagerOptions = {}) {
        this.deadzone = options.deadzone ?? 0.15;
        this.activityThreshold = options.activityThreshold ?? 0.02;
        if (!Number.isFinite(this.deadzone) || this.deadzone < 0 || this.deadzone >= 1) {
            throw new RangeError('deadzone must be finite and in [0, 1).');
        }
        if (!Number.isFinite(this.activityThreshold)
            || this.activityThreshold <= 0 || this.activityThreshold > 1) {
            throw new RangeError('activityThreshold must be finite and in (0, 1].');
        }
        this.storage = resolveStorage(options.storage);
        this.bindings = parseKeybinds(readItem(this.storage, STORAGE_KEYS.keybinds));
        this.refreshRelevant();
    }

    // ------------------------------------------------------------------ bindings

    /** A copy of the current bindings. */
    get keybinds(): KeybindConfig {
        return cloneKeybinds(this.bindings);
    }

    /**
     * Replaces the inputs for one action and saves. Throws `RangeError` for an unknown
     * action, an empty list (an action must always be reachable), an invalid code, a reserved
     * code (`KeyM` mute, `KeyO` options) or too many inputs. Duplicates are dropped. An input
     * also used by another action stays there too: use `assignKey()` to move it instead.
     */
    rebind(action: KeybindAction, keys: string[]): void {
        if (!KEYBIND_ACTIONS.includes(action)) throw new RangeError(`Unknown action "${String(action)}".`);
        this.commit({ ...this.bindings, [action]: this.validateKeys(action, keys) });
    }

    /** Replaces every binding at once (validated like `rebind`) and saves once. */
    setBindings(config: KeybindConfig): void {
        const next = {} as KeybindConfig;
        for (const action of KEYBIND_ACTIONS) next[action] = this.validateKeys(action, config[action]);
        this.commit(next);
    }

    /** Restores the default bindings and forgets the saved ones. */
    resetDefaultBindings(): void {
        this.bindings = defaultKeybinds();
        this.afterBindingsChanged();
        removeItem(this.storage, STORAGE_KEYS.keybinds);
    }

    /** Calls `listener` after every change to the bindings. Returns an unsubscribe function. */
    onBindingsChange(listener: (config: Readonly<KeybindConfig>) => void): () => void {
        this.bindingListeners.add(listener);
        return () => {
            this.bindingListeners.delete(listener);
        };
    }

    /**
     * Waits for the next key press or mouse press anywhere in the window and passes its code
     * to `callback` once (`KeyA`, `Space`, `Mouse0`...). Key repeats are ignored. The press is
     * consumed: the game, the page and the control under the pointer never see it. Returns a
     * function that cancels the wait (safe to call after it has fired). Requires `attach()`.
     */
    listenNextInput(callback: (code: string) => void): () => void {
        if (!this.host) throw new Error('InputManager.listenNextInput() requires attach() first.');
        this.clearControls(); // anything held now would be stuck once the game stops hearing it
        this.captures.add(callback);
        return () => {
            this.captures.delete(callback);
        };
    }

    /** True while at least one `listenNextInput` wait is pending. */
    get isCapturing(): boolean {
        return this.captures.size > 0;
    }

    private validateKeys(action: KeybindAction, keys: readonly string[]): string[] {
        if (!Array.isArray(keys)) throw new RangeError(`${action}: keys must be an array.`);
        const cleaned: string[] = [];
        for (const key of keys) {
            if (!isValidKeyCode(key)) throw new RangeError(`${action}: "${String(key)}" is not a valid key code.`);
            const reason = RESERVED_CODES[key];
            if (reason !== undefined) throw new RangeError(`${action}: ${key} is reserved for ${reason}.`);
            if (!cleaned.includes(key)) cleaned.push(key);
        }
        if (cleaned.length === 0) throw new RangeError(`${action}: at least one key is required.`);
        if (cleaned.length > MAX_KEYS_PER_ACTION) throw new RangeError(`${action}: at most ${MAX_KEYS_PER_ACTION} keys.`);
        return cleaned;
    }

    private commit(next: KeybindConfig): void {
        this.bindings = cloneKeybinds(next);
        this.afterBindingsChanged();
        writeItem(this.storage, STORAGE_KEYS.keybinds, serializeKeybinds(this.bindings));
    }

    private afterBindingsChanged(): void {
        this.refreshRelevant();
        // A key that was held under the old bindings may no longer be released by the new ones.
        this.clearControls();
        const snapshot = cloneKeybinds(this.bindings);
        for (const listener of this.bindingListeners) listener(snapshot);
    }

    private refreshRelevant(): void {
        this.relevant = new Set(KEYBIND_ACTIONS.flatMap(action => this.bindings[action]));
    }

    /** Idempotent; reattaching first removes all listeners from the old target. */
    attach(targetElement?: HTMLElement | Window): void {
        this.destroy();
        const target = targetElement ?? (typeof window !== 'undefined' ? window : undefined);
        if (!target) {
            throw new Error('InputManager.attach() requires a browser Window or HTMLElement.');
        }
        const element = 'ownerDocument' in target ? target : null;
        const host = element ? element.ownerDocument.defaultView : target as Window;
        if (!host) {
            throw new Error('The target element must belong to a document with a Window.');
        }
        this.host = host;
        this.document = host.document;
        this.element = element;
        this.focused = host.document.hasFocus();

        // Preserve existing tabindex, including an explicitly supplied -1.
        if (element && !element.hasAttribute('tabindex') && element.tabIndex < 0) {
            element.setAttribute('tabindex', '0');
            this.addedTabIndex = true;
        }
        host.addEventListener('keydown', this.onKeyDown, { passive: false });
        host.addEventListener('keyup', this.onKeyUp, { passive: false });
        host.addEventListener('blur', this.onBlur);
        host.addEventListener('focus', this.onFocus);
        // A button released anywhere ends the press, even outside the canvas.
        host.addEventListener('mouseup', this.onMouseUp);
        // Capture phase: a pending listenNextInput() sees the press before anything else.
        host.addEventListener('keydown', this.onCaptureKeyDown, { capture: true, passive: false });
        host.addEventListener('mousedown', this.onCaptureMouseDown, { capture: true, passive: false });
        host.addEventListener('click', this.onCaptureClick, { capture: true, passive: false });
        host.addEventListener('auxclick', this.onCaptureClick, { capture: true, passive: false });
        host.addEventListener('contextmenu', this.onCaptureContextMenu, { capture: true, passive: false });
        host.document.addEventListener('visibilitychange', this.onVisibilityChange);
        host.document.addEventListener('focusin', this.onFocusIn);
        if (element) {
            element.addEventListener('mousedown', this.onMouseDown, { passive: false });
            element.addEventListener('contextmenu', this.onContextMenu, { passive: false });
        } else {
            host.addEventListener('mousedown', this.onMouseDown, { passive: false });
            host.addEventListener('contextmenu', this.onContextMenu, { passive: false });
        }
        element?.addEventListener('pointerdown', this.onPointerDown);
        element?.addEventListener('focusout', this.onFocusOut);
    }

    /** Safe before attach, after destroy, and when the Gamepad API is unavailable. */
    update(): InputState {
        if (!this.isActive()) {
            this.clearControls();
            return this.snapshot(neutral(), false, false);
        }

        const keyboard = this.keyboardControls();
        let padMovement = neutral();
        let movementActivity = -1;
        let padFire = false;
        let padPause = false;
        const connected = new Set<number>();

        for (const pad of this.pollGamepads()) {
            if (!pad || !pad.connected || pad.mapping !== 'standard') continue;
            connected.add(pad.index);
            const controls = this.readPad(pad);
            const history = this.pads.get(pad.index);
            let activity = history?.activity ?? 0;
            if (hasInput(controls) && (!history || this.meaningfullyChanged(history.controls, controls))) {
                activity = ++this.sequence;
                this.gamepadActivity = activity;
                this.pads.set(pad.index, { controls, activity });
            } else if (!history || !hasInput(controls)) {
                this.pads.set(pad.index, { controls, activity });
            }
            // Keep the last meaningful sample as the baseline: slow changes accumulate.
            if (hasMovement(controls) && activity > movementActivity) {
                padMovement = controls;
                movementActivity = activity;
            }
            padFire ||= controls.fire;
            padPause ||= controls.pause;
        }
        for (const index of this.pads.keys()) {
            if (!connected.has(index)) this.pads.delete(index);
        }

        if (this.gamepadActivity > this.keyboardActivity) this.activeDevice = 'gamepad';
        else if (this.keyboardActivity > this.gamepadActivity) this.activeDevice = 'keyboard';

        const preferred = this.activeDevice === 'keyboard' ? keyboard : padMovement;
        const fallback = this.activeDevice === 'keyboard' ? padMovement : keyboard;
        const movement = hasMovement(preferred) ? preferred : fallback;
        const fire = keyboard.fire || padFire;
        const pause = keyboard.pause || padPause;
        const firePressed = this.pendingFire || (fire && !this.previousFire);
        const pausePressed = this.pendingPause || (pause && !this.previousPause);
        this.previousFire = fire;
        this.previousPause = pause;
        this.lastPadFire = padFire;
        this.lastPadPause = padPause;
        this.pendingFire = false;
        this.pendingPause = false;
        return this.snapshot({ ...movement, fire }, firePressed, pausePressed);
    }

    /** Removes every listener and held/edge state. The instance can be reattached. */
    destroy(): void {
        const host = this.host;
        host?.removeEventListener('keydown', this.onKeyDown);
        host?.removeEventListener('keyup', this.onKeyUp);
        host?.removeEventListener('blur', this.onBlur);
        host?.removeEventListener('focus', this.onFocus);
        host?.removeEventListener('mouseup', this.onMouseUp);
        host?.removeEventListener('keydown', this.onCaptureKeyDown, { capture: true });
        host?.removeEventListener('mousedown', this.onCaptureMouseDown, { capture: true });
        host?.removeEventListener('click', this.onCaptureClick, { capture: true });
        host?.removeEventListener('auxclick', this.onCaptureClick, { capture: true });
        host?.removeEventListener('contextmenu', this.onCaptureContextMenu, { capture: true });
        if (this.element) {
            this.element.removeEventListener('mousedown', this.onMouseDown);
            this.element.removeEventListener('contextmenu', this.onContextMenu);
        } else {
            host?.removeEventListener('mousedown', this.onMouseDown);
            host?.removeEventListener('contextmenu', this.onContextMenu);
        }
        this.document?.removeEventListener('visibilitychange', this.onVisibilityChange);
        this.document?.removeEventListener('focusin', this.onFocusIn);
        this.element?.removeEventListener('pointerdown', this.onPointerDown);
        this.element?.removeEventListener('focusout', this.onFocusOut);
        this.captures.clear();
        this.swallowKeyUps.clear();
        this.swallowClickUntil = 0;
        this.swallowContextMenuUntil = 0;
        if (this.addedTabIndex && this.element?.getAttribute('tabindex') === '0') {
            this.element.removeAttribute('tabindex');
        }
        this.host = null;
        this.document = null;
        this.element = null;
        this.addedTabIndex = false;
        this.sequence = 0;
        this.keyboardActivity = 0;
        this.gamepadActivity = 0;
        this.activeDevice = 'keyboard';
        this.clearControls();
    }

    private snapshot(controls: Controls, firePressed: boolean, pausePressed: boolean): InputState {
        return {
            moveX: controls.moveX,
            moveY: controls.moveY,
            fire: controls.fire,
            firePressed,
            pausePressed,
            activeDevice: this.activeDevice,
        };
    }

    private held(codes: readonly string[]): boolean {
        return codes.some(code => this.keys.has(code));
    }

    private keyboardControls(): Controls {
        const b = this.bindings;
        return {
            moveX: Number(this.held(b.moveRight)) - Number(this.held(b.moveLeft)),
            moveY: Number(this.held(b.accelerate)) - Number(this.held(b.brake)),
            fire: this.held(b.fire),
            pause: this.held(b.pause),
        };
    }

    private axis(value: number | undefined): number {
        if (value === undefined || !Number.isFinite(value)) return 0;
        const clamped = Math.max(-1, Math.min(1, value));
        const magnitude = Math.abs(clamped);
        if (magnitude <= this.deadzone) return 0;
        return Math.sign(clamped) * (magnitude - this.deadzone) / (1 - this.deadzone);
    }

    private readPad(pad: Gamepad): Controls {
        const button = (index: number): boolean => {
            const value = pad.buttons[index];
            return value !== undefined && (value.pressed || value.value > 0.5);
        };
        // D-pad overrides the corresponding stick axis, including opposing buttons.
        const horizontal = button(14) || button(15);
        const vertical = button(12) || button(13);
        const stickY = this.axis(pad.axes[1]);
        return {
            moveX: horizontal ? Number(button(15)) - Number(button(14)) : this.axis(pad.axes[0]),
            moveY: vertical ? Number(button(12)) - Number(button(13)) : (stickY === 0 ? 0 : -stickY),
            fire: button(0) || button(5) || button(7),
            pause: button(9),
        };
    }

    private pollGamepads(): readonly (Gamepad | null)[] {
        try {
            return this.host?.navigator.getGamepads?.() ?? [];
        } catch {
            // Permissions Policy / embedded documents can throw SecurityError.
            return [];
        }
    }

    private meaningfullyChanged(previous: Controls, next: Controls): boolean {
        return previous.fire !== next.fire || previous.pause !== next.pause
            || (previous.moveX === 0) !== (next.moveX === 0)
            || (previous.moveY === 0) !== (next.moveY === 0)
            || Math.sign(previous.moveX) !== Math.sign(next.moveX)
            || Math.sign(previous.moveY) !== Math.sign(next.moveY)
            || Math.abs(previous.moveX - next.moveX) >= this.activityThreshold
            || Math.abs(previous.moveY - next.moveY) >= this.activityThreshold;
    }

    private isEditable(target: EventTarget | null): boolean {
        // Avoid instanceof: elements can belong to a different browsing context.
        if (!target || !('nodeType' in target) || target.nodeType !== 1) return false;
        const element = target as HTMLElement;
        return element.isContentEditable || element.closest(
            'input, textarea, select, [role="textbox"], [contenteditable]:not([contenteditable="false"])',
        ) !== null;
    }

    /** Page controls whose clicks must never count as gameplay (only matters when attached to the window). */
    private isInteractive(target: EventTarget | null): boolean {
        if (!target || !('nodeType' in target) || target.nodeType !== 1) return false;
        return (target as HTMLElement).closest(
            'button, a, input, select, textarea, label, summary, [role="button"], [role="dialog"], [data-ui]',
        ) !== null;
    }

    private isActive(): boolean {
        if (!this.host || !this.document || !this.focused || this.document.hidden) return false;
        const active = this.document.activeElement;
        return !this.isEditable(active) && (!this.element || (active !== null && this.element.contains(active)));
    }

    private clearControls(): void {
        this.keys.clear();
        this.pads.clear();
        this.previousFire = false;
        this.previousPause = false;
        this.lastPadFire = false;
        this.lastPadPause = false;
        this.pendingFire = false;
        this.pendingPause = false;
    }

    /** A code (key or mouse button) goes down. Shared by the keyboard and the mouse. */
    private press(code: string): void {
        if (this.keys.has(code)) return;
        const before = this.keyboardControls();
        this.keys.add(code);
        const after = this.keyboardControls();
        if (after.fire && !before.fire && !this.lastPadFire) this.pendingFire = true;
        if (after.pause && !before.pause && !this.lastPadPause) this.pendingPause = true;
        if (hasInput(after)) this.keyboardActivity = ++this.sequence;
    }

    private release(code: string): void {
        const removed = this.keys.delete(code);
        if (removed && hasInput(this.keyboardControls())) this.keyboardActivity = ++this.sequence;
    }

    private readonly onKeyDown = (event: KeyboardEvent): void => {
        if (!this.relevant.has(event.code) || !this.isActive() || event.composedPath().some(target => this.isEditable(target))) return;
        // Leave OS/browser shortcuts and IME composition alone.
        if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
        if (SCROLL_KEYS.has(event.code)) event.preventDefault();
        if (event.repeat) return;
        this.press(event.code);
    };

    private readonly onKeyUp = (event: KeyboardEvent): void => {
        // The key that was just captured for a binding: do not let its release activate a control.
        if (this.swallowKeyUps.delete(event.code)) event.preventDefault();
        if (SCROLL_KEYS.has(event.code) && this.keys.has(event.code) && this.isActive()) event.preventDefault();
        this.release(event.code);
    };

    private readonly onMouseDown = (event: MouseEvent): void => {
        const code = mouseCode(event.button);
        if (code === null || !this.relevant.has(code) || !this.isActive()) return;
        if (!this.element && this.isInteractive(event.target)) return; // window mode: UI clicks are not shots
        if (event.composedPath().some(target => this.isEditable(target))) return;
        // No text selection or drag ghost, and no middle-click autoscroll, while playing.
        event.preventDefault();
        this.press(code);
    };

    private readonly onMouseUp = (event: MouseEvent): void => {
        const code = mouseCode(event.button);
        if (code !== null) this.release(code);
    };

    /** Suppresses the browser's context menu while the right button is a game control. */
    private readonly onContextMenu = (event: Event): void => {
        if (!this.relevant.has('Mouse2')) return;
        const target = event.target;
        if (this.element) {
            if (!(target && 'nodeType' in target && this.element.contains(target as Node))) return;
        } else if (this.isInteractive(target) || this.isEditable(target)) {
            return;
        }
        event.preventDefault();
    };

    // -------------------------------------------------- capturing the next input

    /** Hands a captured code to every waiting listener (each is called once). */
    private completeCapture(code: string): void {
        const waiting = [...this.captures];
        this.captures.clear();
        for (const callback of waiting) callback(code);
    }

    private readonly onCaptureKeyDown = (event: KeyboardEvent): void => {
        if (this.captures.size === 0 || event.isComposing) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.repeat) return; // a key already held when the wait began is not "the next press"
        this.swallowKeyUps.add(event.code);
        this.completeCapture(event.code);
    };

    private readonly onCaptureMouseDown = (event: MouseEvent): void => {
        if (this.captures.size === 0) return;
        const code = mouseCode(event.button);
        if (code === null) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        // The click (and for the right button, the context menu) that follows must not reach
        // whatever is under the pointer.
        this.swallowClickUntil = Date.now() + SWALLOW_MS;
        if (code === 'Mouse2') this.swallowContextMenuUntil = Date.now() + SWALLOW_MS;
        this.completeCapture(code);
    };

    private readonly onCaptureClick = (event: Event): void => {
        if (Date.now() >= this.swallowClickUntil) return;
        this.swallowClickUntil = 0;
        event.preventDefault();
        event.stopImmediatePropagation();
    };

    private readonly onCaptureContextMenu = (event: Event): void => {
        if (this.captures.size > 0 || Date.now() < this.swallowContextMenuUntil) event.preventDefault();
    };

    private readonly onBlur = (): void => {
        this.focused = false;
        this.clearControls();
        this.swallowKeyUps.clear();
    };

    private readonly onFocus = (): void => { this.focused = true; };

    private readonly onVisibilityChange = (): void => {
        if (this.document?.hidden) this.clearControls();
    };

    private readonly onFocusIn = (): void => {
        if (!this.isActive()) this.clearControls();
    };

    private readonly onFocusOut = (event: FocusEvent): void => {
        const next = event.relatedTarget;
        if (!next || !('nodeType' in next) || !this.element?.contains(next as Node) || this.isEditable(next)) {
            this.clearControls();
        }
    };

    private readonly onPointerDown = (event: PointerEvent): void => {
        if (!event.composedPath().some(target => this.isEditable(target))) {
            this.element?.focus({ preventScroll: true });
        }
    };
}