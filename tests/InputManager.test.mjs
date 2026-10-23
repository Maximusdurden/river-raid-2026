import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { InputManager } from '../dist/InputManager.js';

function fixture(t, options) {
    const dom = new JSDOM('<canvas></canvas><input><div contenteditable="true"></div>', { pretendToBeVisual: true });
    const { window } = dom;
    const canvas = window.document.querySelector('canvas');
    let pads = [];
    Object.defineProperty(window.navigator, 'getGamepads', { configurable: true, value: () => pads });
    Object.defineProperty(window.document, 'hasFocus', { value: () => true });
    const input = new InputManager(options);
    input.attach(canvas);
    canvas.focus();
    t.after(() => { input.destroy(); window.close(); });
    return {
        input, window, canvas,
        setPads: value => { pads = value; },
        key(code, type = 'keydown', extra = {}, target = canvas) {
            const event = new window.KeyboardEvent(type, { code, bubbles: true, cancelable: true, ...extra });
            target.dispatchEvent(event);
            return event;
        },
    };
}

function pad({ index = 0, axes = [0, 0], buttons = [], mapping = 'standard', connected = true } = {}) {
    return {
        index, axes, mapping, connected,
        buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: buttons.includes(i), value: buttons.includes(i) ? 1 : 0 })),
    };
}

test('keyboard movement aliases, cancellation and scrolling', t => {
    const f = fixture(t);
    for (const code of ['ArrowLeft', 'KeyA', 'ArrowRight', 'KeyD', 'ArrowUp', 'KeyW', 'ArrowDown', 'KeyS']) {
        const event = f.key(code);
        const state = f.input.update();
        assert.equal(state.moveX, ['ArrowLeft', 'KeyA'].includes(code) ? -1 : ['ArrowRight', 'KeyD'].includes(code) ? 1 : 0);
        assert.equal(state.moveY, ['ArrowUp', 'KeyW'].includes(code) ? 1 : ['ArrowDown', 'KeyS'].includes(code) ? -1 : 0);
        assert.equal(event.defaultPrevented, code.startsWith('Arrow'));
        f.key(code, 'keyup');
        f.input.update();
    }
    f.key('KeyA'); f.key('KeyD'); f.key('KeyW'); f.key('KeyS');
    assert.equal(f.input.update().moveX, 0);
    assert.equal(f.input.update().moveY, 0);
    assert.equal(f.key('Space').defaultPrevented, true);
});

test('fire and pause edges last one frame, aliases and repeat do not retrigger', t => {
    const f = fixture(t);
    f.key('Space'); f.key('Escape');
    assert.equal(f.input.update().firePressed, true);
    assert.equal(f.input.update().firePressed, false);
    f.key('Space', 'keydown', { repeat: true }); f.key('KeyJ'); f.key('KeyP');
    const held = f.input.update();
    assert.equal(held.fire, true);
    assert.equal(held.firePressed, false);
    assert.equal(held.pausePressed, false);
    f.key('Space', 'keyup'); f.key('KeyJ', 'keyup');
    f.key('Escape', 'keyup'); f.key('KeyP', 'keyup');
    f.input.update();
    f.key('KeyJ'); f.key('KeyP');
    const pressed = f.input.update();
    assert.equal(pressed.firePressed, true);
    assert.equal(pressed.pausePressed, true);
    assert.equal(f.input.update().pausePressed, false);
});

test('quick keyboard taps between frames are retained once', t => {
    const f = fixture(t);
    f.key('Space'); f.key('Space', 'keyup');
    f.key('Escape'); f.key('Escape', 'keyup');
    const tap = f.input.update();
    assert.equal(tap.fire, false);
    assert.equal(tap.firePressed, true);
    assert.equal(tap.pausePressed, true);
    assert.equal(f.input.update().firePressed, false);
    assert.equal(f.input.update().pausePressed, false);
});

test('axial deadzone, scaling, inversion, clamping, invalid axes', t => {
    const f = fixture(t);
    for (const value of [0, 0.1, -0.15, 0.15, NaN, Infinity]) {
        f.setPads([pad({ axes: [value, value] })]);
        assert.equal(f.input.update().moveX, 0);
        assert.equal(f.input.update().moveY, 0);
    }
    f.setPads([pad({ axes: [0.575, -0.575] })]);
    const half = f.input.update();
    assert.ok(Math.abs(half.moveX - 0.5) < 1e-12);
    assert.ok(Math.abs(half.moveY - 0.5) < 1e-12);
    f.setPads([pad({ axes: [-2, 2] })]);
    assert.equal(f.input.update().moveX, -1);
    assert.equal(f.input.update().moveY, -1);
});

test('configurable deadzone and invalid configuration', t => {
    const f = fixture(t, { deadzone: 0.5 });
    f.setPads([pad({ axes: [0.75, 0] })]);
    assert.equal(f.input.update().moveX, 0.5);
    for (const deadzone of [-1, 1, NaN, Infinity]) assert.throws(() => new InputManager({ deadzone }), RangeError);
    for (const activityThreshold of [0, -1, 2, NaN]) assert.throws(() => new InputManager({ activityThreshold }), RangeError);
});

test('D-pad overrides stick per axis and opposing buttons cancel', t => {
    const f = fixture(t);
    for (const [button, x, y] of [[12, 0, 1], [13, 0, -1], [14, -1, 0], [15, 1, 0]]) {
        f.setPads([pad({ buttons: [button] })]);
        const state = f.input.update();
        assert.equal(state.moveX, x); assert.equal(state.moveY, y);
    }
    f.setPads([pad({ axes: [1, -1], buttons: [12, 13, 14, 15] })]);
    assert.equal(f.input.update().moveX, 0);
    assert.equal(f.input.update().moveY, 0);
});

test('all gamepad fire buttons and pause have single-frame edges', t => {
    const f = fixture(t);
    for (const button of [0, 5, 7]) {
        f.setPads([pad({ buttons: [button, 9] })]);
        const pressed = f.input.update();
        assert.equal(pressed.fire, true); assert.equal(pressed.firePressed, true); assert.equal(pressed.pausePressed, true);
        const held = f.input.update();
        assert.equal(held.firePressed, false); assert.equal(held.pausePressed, false);
        f.setPads([pad()]); f.input.update();
    }
});

test('latest activity wins without held input or analog jitter stealing ownership', t => {
    const f = fixture(t);
    f.setPads([pad({ axes: [0.6, 0] })]);
    assert.equal(f.input.update().activeDevice, 'gamepad');
    f.key('KeyA');
    assert.equal(f.input.update().activeDevice, 'keyboard');
    f.setPads([pad({ axes: [0.601, 0] })]);
    assert.equal(f.input.update().activeDevice, 'keyboard');
    f.setPads([pad({ axes: [0.8, 0] })]);
    assert.equal(f.input.update().activeDevice, 'gamepad');
    f.key('KeyA', 'keydown', { repeat: true });
    assert.equal(f.input.update().activeDevice, 'gamepad');
    f.setPads([pad()]);
    assert.equal(f.input.update().moveX, -1);
    f.key('KeyA', 'keyup');
    assert.equal(f.input.update().moveX, 0);
});

test('simultaneous activity is deterministically resolved at the gamepad poll', t => {
    const f = fixture(t);
    f.key('KeyA'); f.setPads([pad({ axes: [1, 0] })]);
    const state = f.input.update();
    assert.equal(state.activeDevice, 'gamepad'); assert.equal(state.moveX, 1);
});

test('cross-device action handoff does not fabricate an edge', t => {
    const f = fixture(t);
    f.key('Space'); f.key('Escape'); f.input.update();
    f.setPads([pad({ buttons: [0, 9] })]);
    f.key('Space', 'keyup'); f.key('Escape', 'keyup');
    const handoff = f.input.update();
    assert.equal(handoff.fire, true); assert.equal(handoff.firePressed, false); assert.equal(handoff.pausePressed, false);
    f.key('KeyJ'); f.key('KeyP'); f.setPads([pad()]);
    assert.equal(f.input.update().firePressed, false);
    assert.equal(f.input.update().pausePressed, false);
});

test('multiple pads, sparse indices, disconnection and unsupported mappings', t => {
    const f = fixture(t);
    f.setPads([null, pad({ index: 1, axes: [-1, 0] }), null, pad({ index: 3, buttons: [0] })]);
    assert.equal(f.input.update().moveX, -1);
    assert.equal(f.input.update().fire, true);
    f.setPads([null, pad({ index: 1, connected: false }), pad({ index: 2, mapping: '', buttons: [0] })]);
    const disconnected = f.input.update();
    assert.equal(disconnected.fire, false); assert.equal(disconnected.moveX, 0);
    f.setPads([pad({ index: 3, buttons: [0] })]);
    assert.equal(f.input.update().firePressed, true);
});

test('missing or blocked Gamepad API preserves keyboard functionality', t => {
    const f = fixture(t);
    for (const value of [undefined, () => { throw new Error('SecurityError'); }]) {
        Object.defineProperty(f.window.navigator, 'getGamepads', { configurable: true, value });
        f.key('KeyW'); assert.equal(f.input.update().moveY, 1);
    }
});

test('focus loss, blur and hidden documents clear stuck controls', t => {
    const f = fixture(t);
    f.key('Space'); f.input.update();
    f.window.dispatchEvent(new f.window.Event('blur'));
    assert.equal(f.input.update().fire, false);
    f.window.dispatchEvent(new f.window.Event('focus'));
    assert.equal(f.input.update().fire, false);
    f.key('Space');
    Object.defineProperty(f.window.document, 'hidden', { configurable: true, value: true });
    f.window.document.dispatchEvent(new f.window.Event('visibilitychange'));
    assert.equal(f.input.update().firePressed, false);
    Object.defineProperty(f.window.document, 'hidden', { configurable: true, value: false });
    f.key('KeyD');
    f.window.document.querySelector('input').focus();
    f.canvas.focus();
    assert.equal(f.input.update().moveX, 0);
});

test('inactive canvas and editable fields do not capture input or scrolling', t => {
    const f = fixture(t);
    const field = f.window.document.querySelector('input');
    field.focus();
    assert.equal(f.key('Space', 'keydown', {}, field).defaultPrevented, false);
    f.setPads([pad({ buttons: [0] })]);
    assert.equal(f.input.update().fire, false);
    f.input.attach(f.window);
    f.key('KeyW', 'keydown', {}, field);
    assert.equal(f.input.update().moveY, 0);
    // Window capture does not manage tabindex on the formerly attached canvas.
    f.canvas.setAttribute('tabindex', '0');
    f.canvas.focus();
    assert.equal(f.key('ArrowUp').defaultPrevented, true);
    assert.equal(f.input.update().moveY, 1);
});

test('shortcuts and IME are left alone; pointer activates canvas', t => {
    const f = fixture(t);
    for (const extra of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }]) {
        assert.equal(f.key('Space', 'keydown', extra).defaultPrevented, false);
        assert.equal(f.input.update().fire, false);
    }
    f.window.document.querySelector('input').focus();
    f.canvas.dispatchEvent(new f.window.Event('pointerdown', { bubbles: true }));
    assert.equal(f.window.document.activeElement, f.canvas);
});

test('destroy, repeated attach and reattach are safe and preserve tabindex', t => {
    const f = fixture(t);
    assert.equal(f.canvas.getAttribute('tabindex'), '0');
    f.input.attach(f.canvas); f.canvas.focus();
    f.key('Space'); assert.equal(f.input.update().firePressed, true);
    const oldSnapshot = f.input.update();
    f.input.destroy(); f.input.destroy();
    assert.equal(f.canvas.hasAttribute('tabindex'), false);
    assert.equal(f.key('ArrowUp').defaultPrevented, false);
    assert.equal(f.input.update().fire, false);
    assert.equal(oldSnapshot.fire, true);
    f.canvas.setAttribute('tabindex', '-1');
    f.input.attach(f.canvas); f.canvas.focus();
    f.key('KeyJ'); assert.equal(f.input.update().firePressed, true);
    f.input.destroy();
    assert.equal(f.canvas.getAttribute('tabindex'), '-1');
});

test('all event listeners are removed on destroy', t => {
    const f = fixture(t);
    f.input.destroy();
    // Track each listener exactly (target, type, phase, function), so a capture-phase and a
    // bubble-phase listener of the same type cannot hide each other, and a removal that
    // names the wrong phase (which the DOM silently ignores) shows up as a leak.
    const listeners = new Map();
    const phase = options => (typeof options === 'boolean' ? options : Boolean(options?.capture));
    const ids = new Map();
    const idOf = fn => ids.get(fn) ?? ids.set(fn, ids.size).get(fn);
    for (const [label, target] of [['window', f.window], ['document', f.window.document], ['canvas', f.canvas]]) {
        const add = target.addEventListener.bind(target);
        const remove = target.removeEventListener.bind(target);
        target.addEventListener = (type, callback, options) => {
            listeners.set(`${label}:${type}:${phase(options) ? 'capture' : 'bubble'}:${idOf(callback)}`, true);
            add(type, callback, options);
        };
        target.removeEventListener = (type, callback, options) => {
            listeners.delete(`${label}:${type}:${phase(options) ? 'capture' : 'bubble'}:${idOf(callback)}`);
            remove(type, callback, options);
        };
    }
    f.input.attach(f.canvas);
    const attached = [...listeners.keys()].map(key => key.split(':').slice(0, 3).join(':')).sort();
    assert.deepEqual(attached, [
        'canvas:contextmenu:bubble', 'canvas:focusout:bubble', 'canvas:mousedown:bubble', 'canvas:pointerdown:bubble',
        'document:focusin:bubble', 'document:visibilitychange:bubble',
        'window:auxclick:capture', 'window:blur:bubble', 'window:click:capture', 'window:contextmenu:capture',
        'window:focus:bubble', 'window:keydown:bubble', 'window:keydown:capture', 'window:keyup:bubble',
        'window:mousedown:capture', 'window:mouseup:bubble',
    ]);
    f.input.destroy();
    assert.equal(listeners.size, 0, `leaked: ${[...listeners.keys()].join(', ')}`);

    // Window mode puts the mouse listeners on the window instead of an element.
    f.input.attach(f.window);
    const windowMode = [...listeners.keys()].filter(key => key.startsWith('window:mousedown') || key.startsWith('window:contextmenu'));
    assert.equal(windowMode.length, 4, 'capture and normal listeners for both events');
    f.input.destroy();
    assert.equal(listeners.size, 0, `leaked: ${[...listeners.keys()].join(', ')}`);
});

test('idle and disconnected pads do not overwrite latest-device metadata', t => {
    const f = fixture(t);
    f.key('KeyW'); f.input.update(); f.key('KeyW', 'keyup');
    f.setPads([pad({ buttons: [0] })]);
    assert.equal(f.input.update().activeDevice, 'gamepad');
    f.setPads([]);
    assert.equal(f.input.update().activeDevice, 'gamepad');
    f.window.document.querySelector('input').focus();
    f.input.update(); f.canvas.focus();
    assert.equal(f.input.update().activeDevice, 'gamepad');
});