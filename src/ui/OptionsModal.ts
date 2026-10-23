import type { AudioChannelConfig, SoundCue } from '../audio/SoundEngine.js';
import {
    ACTION_LABELS,
    KEYBIND_ACTIONS,
    MAX_KEYS_PER_ACTION,
    assignKey,
    describeKeyCode,
    type KeybindAction,
    type KeybindConfig,
} from '../core/InputManager.js';
import { GAME_MODES, type GameMode } from '../game/GameMode.js';

/** The part of `InputManager` the options screen uses. */
export interface OptionsInputPort {
    readonly keybinds: KeybindConfig;
    setBindings(config: KeybindConfig): void;
    resetDefaultBindings(): void;
    listenNextInput(callback: (code: string) => void): () => void;
    onBindingsChange(listener: (config: Readonly<KeybindConfig>) => void): () => void;
}

/** The part of `SoundEngine` the options screen uses. */
export interface OptionsSoundPort {
    readonly channels: AudioChannelConfig;
    setMasterVolume(volume: number): void;
    setMuted(muted: boolean): void;
    setSfxEnabled(enabled: boolean): void;
    setDroneEnabled(enabled: boolean): void;
    setWarningsEnabled(enabled: boolean): void;
    subscribe(listener: (config: Readonly<AudioChannelConfig>) => void): () => void;
    /** Used for a short confirmation blip when the volume changes. Optional. */
    play?(cue: SoundCue): boolean;
}

export interface OptionsModalOptions {
    document: Document;
    input: OptionsInputPort;
    sound: OptionsSoundPort;
    getMode(): GameMode;
    setMode(mode: GameMode): void;
    /** Freezes the game while the screen is open; returns the release function (`Engine.holdPause`). */
    holdPause(): () => void;
    /** Receives focus when the screen closes (the game canvas). Defaults to whatever had focus before. */
    returnFocus?: HTMLElement | null;
    /** Where the screen is added. Default: `document.body`. */
    mount?: HTMLElement;
    /** Bridges needed to win in campaign, for the label. Default 10. */
    campaignBridges?: number;
    onOpenChange?: (open: boolean) => void;
}

export const OPTIONS_OPEN_CODE = 'KeyO';

type CaptureMode = 'replace' | 'add';
type StatusKind = 'info' | 'ok' | 'error';

interface ActiveCapture {
    readonly action: KeybindAction;
    readonly mode: CaptureMode;
    readonly cancel: () => void;
}

const TEXT_ENTRY = 'textarea, [contenteditable]:not([contenteditable="false"]), '
    + 'input:not([type]), input[type="text"], input[type="search"], input[type="email"], '
    + 'input[type="number"], input[type="password"], input[type="url"], input[type="tel"]';

/** Typing in a text field: shortcut keys must be left alone. Checkboxes, radios and sliders are not text entry. */
function isTextEntry(target: EventTarget | null): boolean {
    if (!target || !('nodeType' in target) || (target as Node).nodeType !== 1) return false;
    const element = target as HTMLElement;
    return element.isContentEditable || element.closest(TEXT_ENTRY) !== null;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * The in-game settings screen: a retro-styled modal with three sections.
 *
 *  - Controls: every action with its current inputs as removable chips, "Rebind" (replace the
 *    inputs with the next key or mouse button pressed), "Add" (append one), and a reset button.
 *    While waiting, the next key press or click anywhere is consumed (so a click binds Left
 *    Click rather than pressing a button); Esc cancels. An input already used by another action
 *    moves here, unless that would leave the other action with nothing; `M` and `O` are
 *    reserved for mute and options.
 *  - Audio: master volume, mute, and switches for effects, the engine drone and the low-fuel alarm.
 *  - Game mode: Campaign (a fixed number of bridges ends in victory) or Endless River.
 *
 * Opening it (the on-screen button, or the O key when not typing in a text field) holds the
 * simulation paused through `holdPause`; closing releases the hold and returns focus to the
 * game. A pause the player made themselves is neither cancelled by opening nor undone by
 * closing. Changes apply and are saved as they are made; there is no Apply button.
 */
export class OptionsModal {
    private readonly doc: Document;
    private readonly win: Window | null;
    private readonly opts: OptionsModalOptions;
    private readonly root: HTMLElement;
    private readonly dialog: HTMLElement;
    private readonly list: HTMLElement;
    private readonly status: HTMLElement;
    private readonly volume: HTMLInputElement;
    private readonly volumeOutput: HTMLElement;
    private readonly checks: Record<'muted' | 'sfx' | 'drone' | 'warnings', HTMLInputElement>;
    private readonly radios: Record<GameMode, HTMLInputElement>;
    private readonly cleanups: Array<() => void> = [];

    private isShown = false;
    private destroyed = false;
    private releasePause: (() => void) | null = null;
    private capture: ActiveCapture | null = null;
    private previousFocus: HTMLElement | null = null;
    private pressStartedOnBackdrop = false;

    constructor(options: OptionsModalOptions) {
        this.opts = options;
        this.doc = options.document;
        this.win = this.doc.defaultView;
        const build = this.build();
        this.root = build.root;
        this.dialog = build.dialog;
        this.list = build.list;
        this.status = build.status;
        this.volume = build.volume;
        this.volumeOutput = build.volumeOutput;
        this.checks = build.checks;
        this.radios = build.radios;

        (options.mount ?? this.doc.body).appendChild(this.root);

        this.listen(this.root, 'click', this.onClick);
        this.listen(this.root, 'mousedown', this.onBackdropPress);
        this.listen(this.root, 'click', this.onBackdropClick);
        this.listen(this.root, 'input', this.onInput);
        this.listen(this.root, 'change', this.onChange);
        if (this.win) this.listen(this.win, 'keydown', this.onKeyDown);
        this.listen(this.doc, 'focusin', this.onFocusIn);
        this.cleanups.push(options.input.onBindingsChange(() => this.renderBindings()));
        this.cleanups.push(options.sound.subscribe(config => this.syncAudio(config)));
        this.syncAll();
    }

    get isOpen(): boolean {
        return this.isShown;
    }

    /** True while the screen is waiting for a key or mouse press to bind. */
    get isCapturing(): boolean {
        return this.capture !== null;
    }

    open(): void {
        if (this.isShown || this.destroyed) return;
        this.isShown = true;
        const active = this.doc.activeElement;
        this.previousFocus = active && 'focus' in active ? active as HTMLElement : null;
        this.releasePause = this.opts.holdPause();
        this.syncAll();
        this.setStatus('', 'info');
        this.root.hidden = false;
        this.dialog.focus();
        this.opts.onOpenChange?.(true);
    }

    close(): void {
        if (!this.isShown) return;
        this.cancelCapture();
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

    /** Closes the screen, releases everything it holds and removes it from the page. */
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

    private build(): {
        root: HTMLElement; dialog: HTMLElement; list: HTMLElement; status: HTMLElement;
        volume: HTMLInputElement; volumeOutput: HTMLElement;
        checks: Record<'muted' | 'sfx' | 'drone' | 'warnings', HTMLInputElement>;
        radios: Record<GameMode, HTMLInputElement>;
    } {
        const root = this.el('div', { class: 'options-backdrop', 'data-ui': '', hidden: '' });
        const dialog = this.el('div', {
            class: 'options-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'options-title', tabindex: '-1',
        });
        root.appendChild(dialog);

        const header = this.el('div', { class: 'options-header' });
        header.appendChild(this.el('h2', { id: 'options-title' }, 'OPTIONS'));
        header.appendChild(this.el('button', { type: 'button', class: 'options-close', 'data-role': 'close', 'aria-label': 'Close options' }, '\u2715'));
        dialog.appendChild(header);

        const body = this.el('div', { class: 'options-body' });
        dialog.appendChild(body);

        // Controls.
        const controls = this.el('section', { class: 'options-section', 'aria-labelledby': 'options-controls' });
        controls.appendChild(this.el('h3', { id: 'options-controls' }, 'CONTROLS'));
        controls.appendChild(this.el('p', { class: 'options-note' },
            'Rebind replaces an action\u2019s inputs; Add gives it another. Keys and mouse buttons both work. Gamepads use fixed buttons.'));
        const list = this.el('ul', { class: 'options-bindings' });
        controls.appendChild(list);
        const status = this.el('p', { class: 'options-status', role: 'status', 'aria-live': 'polite', 'data-kind': 'info' });
        controls.appendChild(status);
        controls.appendChild(this.el('button', { type: 'button', class: 'options-button', 'data-role': 'reset-controls' }, 'Reset Controls to Default'));
        body.appendChild(controls);

        // Audio.
        const audio = this.el('section', { class: 'options-section', 'aria-labelledby': 'options-audio' });
        audio.appendChild(this.el('h3', { id: 'options-audio' }, 'AUDIO'));
        const volumeRow = this.el('label', { class: 'options-row' });
        volumeRow.appendChild(this.el('span', { class: 'options-label' }, 'Master volume'));
        const volume = this.el('input', { type: 'range', min: '0', max: '100', step: '5', 'data-role': 'volume', 'aria-label': 'Master volume' });
        volumeRow.appendChild(volume);
        const volumeOutput = this.el('output', { class: 'options-value' }, '60%');
        volumeRow.appendChild(volumeOutput);
        audio.appendChild(volumeRow);
        const makeCheck = (name: string, label: string, hint: string): HTMLInputElement => {
            const row = this.el('label', { class: 'options-row options-check' });
            const box = this.el('input', { type: 'checkbox', 'data-role': name });
            row.appendChild(box);
            row.appendChild(this.el('span', { class: 'options-label' }, label));
            row.appendChild(this.el('span', { class: 'options-hint' }, hint));
            audio.appendChild(row);
            return box;
        };
        const checks = {
            muted: makeCheck('muted', 'Mute all sound', 'M'),
            sfx: makeCheck('sfx', 'Sound effects', 'weapons, explosions, fanfares, 1UP'),
            drone: makeCheck('drone', 'Engine drone', 'continuous engine sound'),
            warnings: makeCheck('warnings', 'Low-fuel alarm', 'klaxon below 20 fuel'),
        };
        body.appendChild(audio);

        // Game mode.
        const mode = this.el('section', { class: 'options-section', 'aria-labelledby': 'options-mode' });
        mode.appendChild(this.el('h3', { id: 'options-mode' }, 'GAME MODE'));
        const bridges = this.opts.campaignBridges ?? 10;
        const labels: Readonly<Record<GameMode, readonly [string, string]>> = {
            campaign: [`Campaign (${bridges} Bridges)`, `Destroy ${bridges} bridges to win the run.`],
            endless: ['Endless River', 'No victory. Bridges are checkpoints worth 500 points; the river never ends.'],
        };
        const radios = {} as Record<GameMode, HTMLInputElement>;
        for (const value of GAME_MODES) {
            const row = this.el('label', { class: 'options-row options-check' });
            const radio = this.el('input', { type: 'radio', name: 'options-mode', value, 'data-role': 'mode' });
            row.appendChild(radio);
            row.appendChild(this.el('span', { class: 'options-label' }, labels[value][0]));
            row.appendChild(this.el('span', { class: 'options-hint' }, labels[value][1]));
            mode.appendChild(row);
            radios[value] = radio;
        }
        mode.appendChild(this.el('p', { class: 'options-note' }, 'Applies immediately and is remembered.'));
        body.appendChild(mode);

        const footer = this.el('div', { class: 'options-footer' });
        footer.appendChild(this.el('span', { class: 'options-note' }, 'Esc or O closes this screen. The game is paused while it is open.'));
        footer.appendChild(this.el('button', { type: 'button', class: 'options-button options-primary', 'data-role': 'close' }, 'Done'));
        dialog.appendChild(footer);

        return { root, dialog, list, status, volume, volumeOutput, checks, radios };
    }

    private listen<T extends Event>(target: EventTarget, type: string, handler: (event: T) => void): void {
        const listener = handler as (event: Event) => void;
        target.addEventListener(type, listener);
        this.cleanups.push(() => target.removeEventListener(type, listener));
    }

    // ----------------------------------------------------------------- rendering

    private syncAll(): void {
        this.renderBindings();
        this.syncAudio(this.opts.sound.channels);
        this.syncMode();
    }

    private renderBindings(): void {
        const config = this.opts.input.keybinds;
        const focused = this.doc.activeElement;
        const restore = focused && this.list.contains(focused)
            ? { action: focused.getAttribute('data-action'), role: focused.getAttribute('data-role'), code: focused.getAttribute('data-code') }
            : null;
        this.list.textContent = '';
        for (const action of KEYBIND_ACTIONS) {
            const row = this.el('li', { class: 'options-binding', 'data-action': action });
            const capturing = this.capture?.action === action;
            if (capturing) row.setAttribute('data-capturing', this.capture?.mode ?? 'replace');
            row.appendChild(this.el('span', { class: 'options-action' }, ACTION_LABELS[action]));

            const keys = this.el('span', { class: 'options-keys' });
            const codes = config[action];
            for (const code of codes) {
                const chip = this.el('span', { class: 'options-chip', 'data-code': code }, describeKeyCode(code));
                const remove = this.el('button', {
                    type: 'button', class: 'options-chip-remove', 'data-role': 'remove', 'data-action': action, 'data-code': code,
                    'aria-label': `Remove ${describeKeyCode(code)} from ${ACTION_LABELS[action]}`, title: 'Remove',
                }, '\u00d7');
                if (codes.length <= 1) remove.setAttribute('disabled', '');
                chip.appendChild(remove);
                keys.appendChild(chip);
            }
            row.appendChild(keys);

            const rebind = this.el('button', {
                type: 'button', class: 'options-button', 'data-role': 'rebind', 'data-action': action,
                'aria-label': `Rebind ${ACTION_LABELS[action]}`,
            }, capturing && this.capture?.mode === 'replace' ? 'Press any key or click mouse\u2026' : 'Rebind');
            row.appendChild(rebind);
            const add = this.el('button', {
                type: 'button', class: 'options-button', 'data-role': 'add', 'data-action': action,
                'aria-label': `Add an input to ${ACTION_LABELS[action]}`,
            }, capturing && this.capture?.mode === 'add' ? 'Press any key or click mouse\u2026' : 'Add');
            if (codes.length >= MAX_KEYS_PER_ACTION) add.setAttribute('disabled', '');
            row.appendChild(add);
            this.list.appendChild(row);
        }
        if (restore?.action) {
            const selector = `[data-role="${restore.role ?? ''}"][data-action="${restore.action}"]` + (restore.code ? `[data-code="${restore.code}"]` : '');
            const target = this.list.querySelector<HTMLElement>(selector)
                ?? this.list.querySelector<HTMLElement>(`[data-role="rebind"][data-action="${restore.action}"]`);
            target?.focus();
        }
    }

    private syncAudio(config: Readonly<AudioChannelConfig>): void {
        const percent = Math.round(config.masterVolume * 100);
        if (Number(this.volume.value) !== percent) this.volume.value = String(percent);
        this.volumeOutput.textContent = `${percent}%`;
        this.checks.muted.checked = config.muted;
        this.checks.sfx.checked = config.sfxEnabled;
        this.checks.drone.checked = config.droneEnabled;
        this.checks.warnings.checked = config.warningsEnabled;
        // Nothing is audible while muted, so the channel switches read as inactive.
        for (const key of ['sfx', 'drone', 'warnings'] as const) {
            this.checks[key].parentElement?.toggleAttribute('data-dimmed', config.muted);
        }
    }

    private syncMode(): void {
        const mode = this.opts.getMode();
        for (const value of GAME_MODES) this.radios[value].checked = value === mode;
    }

    private setStatus(text: string, kind: StatusKind): void {
        this.status.textContent = text;
        this.status.setAttribute('data-kind', kind);
    }

    // ------------------------------------------------------------------ rebinding

    private beginCapture(action: KeybindAction, mode: CaptureMode): void {
        this.cancelCapture(false);
        const cancel = this.opts.input.listenNextInput(code => this.onCaptured(code));
        this.capture = { action, mode, cancel };
        this.setStatus(`${ACTION_LABELS[action]}: press a key or click a mouse button. Esc cancels.`, 'info');
        this.renderBindings();
    }

    private cancelCapture(announce = true): void {
        const active = this.capture;
        if (!active) return;
        this.capture = null;
        active.cancel();
        if (announce) this.setStatus('Cancelled.', 'info');
        this.renderBindings();
    }

    private onCaptured(code: string): void {
        const active = this.capture;
        if (!active) return;
        this.capture = null;
        if (code === 'Escape') {
            this.setStatus('Cancelled.', 'info');
        } else {
            const change = assignKey(this.opts.input.keybinds, active.action, code, active.mode);
            if (change.error !== null) {
                this.setStatus(change.error, 'error');
            } else {
                this.opts.input.setBindings(change.config);
                const moved = change.stolenFrom.length > 0
                    ? ` (taken from ${change.stolenFrom.map(a => ACTION_LABELS[a]).join(', ')})`
                    : '';
                this.setStatus(`${ACTION_LABELS[active.action]}: ${describeKeyCode(code)}${active.mode === 'add' ? ' added' : ''}${moved}.`, 'ok');
            }
        }
        this.renderBindings();
        this.list.querySelector<HTMLElement>(`[data-role="rebind"][data-action="${active.action}"]`)?.focus();
    }

    private removeInput(action: KeybindAction, code: string): void {
        const config = this.opts.input.keybinds;
        const remaining = config[action].filter(c => c !== code);
        if (remaining.length === 0) {
            this.setStatus(`${ACTION_LABELS[action]} needs at least one input.`, 'error');
            return;
        }
        this.opts.input.setBindings({ ...config, [action]: remaining });
        this.setStatus(`${describeKeyCode(code)} removed from ${ACTION_LABELS[action]}.`, 'ok');
    }

    // ------------------------------------------------------------------- events

    private readonly onClick = (event: MouseEvent): void => {
        const target = event.target as HTMLElement | null;
        const control = target?.closest<HTMLElement>('[data-role]');
        if (!control || !this.root.contains(control)) return;
        const role = control.getAttribute('data-role');
        const action = control.getAttribute('data-action');
        const isAction = (value: string | null): value is KeybindAction => (KEYBIND_ACTIONS as readonly string[]).includes(value ?? '');
        switch (role) {
            case 'close':
                this.close();
                break;
            case 'rebind':
                if (isAction(action)) this.beginCapture(action, 'replace');
                break;
            case 'add':
                if (isAction(action)) this.beginCapture(action, 'add');
                break;
            case 'remove': {
                const code = control.getAttribute('data-code');
                if (isAction(action) && code) this.removeInput(action, code);
                break;
            }
            case 'reset-controls':
                this.cancelCapture(false);
                this.opts.input.resetDefaultBindings();
                this.setStatus('Controls reset to default.', 'ok');
                break;
            default:
                break;
        }
    };

    private readonly onInput = (event: Event): void => {
        const target = event.target as HTMLElement | null;
        if (target === this.volume) {
            this.opts.sound.setMasterVolume(Number(this.volume.value) / 100);
        }
    };

    private readonly onChange = (event: Event): void => {
        const target = event.target as HTMLElement | null;
        const sound = this.opts.sound;
        if (target === this.volume) {
            // A short blip on release, since the game (and so the engine drone) is paused behind this screen.
            sound.play?.('respawn');
        } else if (target === this.checks.muted) {
            sound.setMuted(this.checks.muted.checked);
        } else if (target === this.checks.sfx) {
            sound.setSfxEnabled(this.checks.sfx.checked);
            if (this.checks.sfx.checked) sound.play?.('respawn');
        } else if (target === this.checks.drone) {
            sound.setDroneEnabled(this.checks.drone.checked);
        } else if (target === this.checks.warnings) {
            sound.setWarningsEnabled(this.checks.warnings.checked);
        } else if (target && target.getAttribute('data-role') === 'mode') {
            const value = (target as HTMLInputElement).value;
            if ((GAME_MODES as readonly string[]).includes(value)) {
                this.opts.setMode(value as GameMode);
                this.syncMode();
            }
        }
    };

    /** A press that starts on the dimmed backdrop and ends on it closes; a drag that merely ends there does not. */
    private readonly onBackdropPress = (event: MouseEvent): void => {
        this.pressStartedOnBackdrop = event.target === this.root;
    };

    private readonly onKeyDown = (event: KeyboardEvent): void => {
        if (this.destroyed || this.capture) return; // a pending rebind has already consumed the key
        if (event.code === OPTIONS_OPEN_CODE) {
            if (event.repeat || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
            if (isTextEntry(event.target)) return;
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
        const items = [...this.dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(item => !item.closest('[hidden]'));
        if (items.length === 0) {
            event.preventDefault();
            this.dialog.focus();
            return;
        }
        const first = items[0] as HTMLElement;
        const last = items[items.length - 1] as HTMLElement;
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

    /** Focus never leaves the open screen (for instance via a script or a screen reader). */
    private readonly onFocusIn = (event: FocusEvent): void => {
        if (!this.isShown || this.capture) return;
        const target = event.target as Node | null;
        if (target && !this.root.contains(target)) this.dialog.focus();
    };

    private readonly onBackdropClick = (event: MouseEvent): void => {
        if (event.target === this.root && this.pressStartedOnBackdrop) this.close();
        this.pressStartedOnBackdrop = false;
    };
}
