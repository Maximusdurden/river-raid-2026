import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import {
    ACTION_LABELS, DEFAULT_KEYBINDS, InputManager, KEYBIND_ACTIONS, MAX_KEYS_PER_ACTION, assignKey, cloneKeybinds,
    defaultKeybinds, describeKeyCode, findKeyConflicts, isMouseCode, isValidKeyCode, mouseCode, parseKeybinds,
    sanitizeKeybinds, serializeKeybinds,
} from '../dist/src/core/InputManager.js';

/** An in-memory stand-in for localStorage that can fail on demand. */
class MemoryStorage {
    constructor(initial = {}) {
        this.data = new Map(Object.entries(initial));
        this.failReads = false;
        this.failWrites = false;
        this.writes = 0;
    }

    getItem(key) {
        if (this.failReads) throw new Error('SecurityError');
        return this.data.has(key) ? this.data.get(key) : null;
    }

    setItem(key, value) {
        if (this.failWrites) throw new Error('QuotaExceededError');
        this.writes++;
        this.data.set(key, String(value));
    }

    removeItem(key) {
        this.data.delete(key);
    }
}
const KEY = 'riverraid.keybinds';

function fixture(t, { storage = new MemoryStorage(), attach = 'canvas', html } = {}) {
    const dom = new JSDOM(html ?? '<canvas tabindex="0"></canvas><button id="b">ui</button><input id="field">', { pretendToBeVisual: true });
    const { window } = dom;
    const canvas = window.document.querySelector('canvas');
    Object.defineProperty(window.navigator, 'getGamepads', { configurable: true, value: () => [] });
    Object.defineProperty(window.document, 'hasFocus', { value: () => true });
    const input = new InputManager({ storage });
    input.attach(attach === 'canvas' ? canvas : window);
    canvas.focus();
    t.after(() => {
        input.destroy();
        window.close();
    });
    const fire = (target, type, init = {}) => {
        const Ctor = type.startsWith('key') ? window.KeyboardEvent : window.MouseEvent;
        const event = new Ctor(type, { bubbles: true, cancelable: true, composed: true, ...init });
        target.dispatchEvent(event);
        return event;
    };
    return {
        input, storage, window, canvas, document: window.document, fire,
        key: (code, type = 'keydown', extra = {}, target = canvas) => fire(target, type, { code, ...extra }),
        mouse: (button, type = 'mousedown', target = canvas, extra = {}) => fire(target, type, { button, ...extra }),
    };
}

// ------------------------------------------------------------ pure helpers

test('the default bindings are exactly the specified ones', () => {
    assert.deepEqual({ ...DEFAULT_KEYBINDS }, {
        moveLeft: ['ArrowLeft', 'KeyA'],
        moveRight: ['ArrowRight', 'KeyD'],
        accelerate: ['ArrowUp', 'KeyW'],
        brake: ['ArrowDown', 'KeyS'],
        fire: ['Space', 'KeyJ', 'Mouse0', 'Enter'],
        pause: ['Escape', 'KeyP'],
    });
    assert.deepEqual(KEYBIND_ACTIONS, ['moveLeft', 'moveRight', 'accelerate', 'brake', 'fire', 'pause']);
});

test('defaultKeybinds returns independent copies', () => {
    const a = defaultKeybinds();
    a.fire.push('KeyZ');
    assert.deepEqual(defaultKeybinds().fire, ['Space', 'KeyJ', 'Mouse0', 'Enter']);
    assert.deepEqual([...DEFAULT_KEYBINDS.fire], ['Space', 'KeyJ', 'Mouse0', 'Enter']);
});

test('mouse buttons normalise to Mouse0..Mouse4 and nothing else', () => {
    assert.deepEqual([0, 1, 2, 3, 4].map(mouseCode), ['Mouse0', 'Mouse1', 'Mouse2', 'Mouse3', 'Mouse4']);
    for (const bad of [-1, 5, 1.5, NaN, Infinity, undefined]) assert.equal(mouseCode(bad), null);
    assert.ok(isMouseCode('Mouse0') && isMouseCode('Mouse4'));
    assert.ok(!isMouseCode('Mouse5') && !isMouseCode('KeyM') && !isMouseCode('mouse0'));
});

test('key-code validation accepts real codes and rejects junk', () => {
    for (const ok of ['KeyA', 'Space', 'ArrowLeft', 'Mouse0', 'Digit1', 'Numpad0', 'F12', 'ShiftLeft']) assert.ok(isValidKeyCode(ok), ok);
    for (const bad of ['', 'a b', '<script>', '__proto__x y', 'Key-A', '0Key', 5, null, undefined, {}, [], 'x'.repeat(40)]) assert.equal(isValidKeyCode(bad), false, String(bad));
});

test('describeKeyCode gives friendly labels, including the mouse', () => {
    const cases = {
        Mouse0: 'Left Click', Mouse1: 'Middle Click', Mouse2: 'Right Click', Mouse3: 'Mouse Back', Mouse4: 'Mouse Forward',
        Space: 'Space', Enter: 'Enter', Escape: 'Esc', KeyA: 'A', KeyJ: 'J', Digit5: '5', Numpad3: 'Numpad 3',
        ArrowLeft: 'Left Arrow', ArrowUp: 'Up Arrow', ShiftLeft: 'Left Shift', F11: 'F11', Comma: ',',
        IntlBackslash: 'Intl Backslash', BrowserBack: 'Browser Back',
    };
    for (const [code, label] of Object.entries(cases)) assert.equal(describeKeyCode(code), label, code);
});

test('every default code has a label that is not just the raw code', () => {
    for (const code of Object.values(DEFAULT_KEYBINDS).flat()) assert.ok(describeKeyCode(code).length > 0);
    assert.equal(describeKeyCode('Mouse0'), 'Left Click');
    assert.deepEqual(Object.keys(ACTION_LABELS).sort(), [...KEYBIND_ACTIONS].sort());
});

// ------------------------------------------------------ serialisation / corruption

test('bindings round-trip through JSON exactly', () => {
    const config = { ...defaultKeybinds(), fire: ['Mouse2', 'KeyF'], moveLeft: ['KeyQ'] };
    assert.deepEqual(parseKeybinds(serializeKeybinds(config)), config);
    assert.deepEqual(JSON.parse(serializeKeybinds(config)).fire, ['Mouse2', 'KeyF']);
});

test('corrupt, missing or hostile saved data falls back to the defaults', () => {
    const defaults = defaultKeybinds();
    for (const bad of [null, undefined, '', 'not json', '{', '[]', 'null', '123', '"x"', 'true', '{"fire": "Space"}']) {
        assert.deepEqual(parseKeybinds(bad), defaults, String(bad));
    }
    assert.deepEqual(parseKeybinds('{"__proto__": {"fire": ["KeyZ"]}}'), defaults);
    assert.equal(({}).fire, undefined, 'prototype pollution is not possible');
});

test('one corrupt action does not take the others down with it', () => {
    const config = parseKeybinds(JSON.stringify({ fire: ['KeyF'], moveLeft: 'oops', moveRight: [1, 2], brake: [], accelerate: ['KeyU', '<x>', 'KeyU'] }));
    assert.deepEqual(config.fire, ['KeyF']);
    assert.deepEqual(config.moveLeft, DEFAULT_KEYBINDS.moveLeft);
    assert.deepEqual(config.moveRight, DEFAULT_KEYBINDS.moveRight);
    assert.deepEqual(config.brake, DEFAULT_KEYBINDS.brake);
    assert.deepEqual(config.accelerate, ['KeyU'], 'invalid entries dropped, duplicates collapsed');
    assert.deepEqual(config.pause, DEFAULT_KEYBINDS.pause);
});

test('sanitising drops reserved shortcuts and caps the list length', () => {
    const many = Array.from({ length: 20 }, (_, i) => `Key${String.fromCharCode(65 + i)}`).filter(c => c !== 'KeyM' && c !== 'KeyO');
    const config = sanitizeKeybinds({ fire: ['KeyM', 'KeyO', 'KeyF', ...many] });
    assert.ok(!config.fire.includes('KeyM') && !config.fire.includes('KeyO'));
    assert.equal(config.fire.length, MAX_KEYS_PER_ACTION);
    assert.equal(config.fire[0], 'KeyF');
    assert.deepEqual(sanitizeKeybinds({ fire: ['KeyM'] }).fire, DEFAULT_KEYBINDS.fire, 'nothing valid left: default');
});

// -------------------------------------------------------------- assignKey

test('assignKey replaces or adds', () => {
    const base = defaultKeybinds();
    const replaced = assignKey(base, 'brake', 'KeyX', 'replace');
    assert.equal(replaced.error, null);
    assert.deepEqual(replaced.config.brake, ['KeyX']);
    const added = assignKey(base, 'brake', 'KeyX', 'add');
    assert.deepEqual(added.config.brake, ['ArrowDown', 'KeyS', 'KeyX']);
    assert.deepEqual(base.brake, ['ArrowDown', 'KeyS'], 'the input config is never mutated');
});

test('assignKey moves an input from the action that had it', () => {
    const change = assignKey(defaultKeybinds(), 'pause', 'Space', 'add');
    assert.equal(change.error, null);
    assert.deepEqual(change.stolenFrom, ['fire']);
    assert.ok(change.config.pause.includes('Space'));
    assert.ok(!change.config.fire.includes('Space'));
    assert.deepEqual(change.config.fire, ['KeyJ', 'Mouse0', 'Enter']);
    const total = (config, code) => KEYBIND_ACTIONS.filter(a => config[a].includes(code)).length;
    assert.equal(total(change.config, 'Space'), 1, 'now bound to exactly one action');
});

test('assignKey refuses to leave another action with nothing', () => {
    const config = { ...defaultKeybinds(), brake: ['KeyX'] };
    const change = assignKey(config, 'fire', 'KeyX', 'add');
    assert.match(change.error, /only input for Brake/);
    assert.deepEqual(change.config, config, 'unchanged');
    assert.deepEqual(change.stolenFrom, []);
});

test('assignKey refuses reserved and invalid codes with a readable reason', () => {
    const base = defaultKeybinds();
    assert.match(assignKey(base, 'fire', 'KeyM', 'replace').error, /reserved for mute/);
    assert.match(assignKey(base, 'fire', 'KeyO', 'add').error, /reserved for options/);
    assert.match(assignKey(base, 'fire', '', 'add').error, /not supported/);
    assert.match(assignKey(base, 'fire', '<b>', 'add').error, /not supported/);
    assert.match(assignKey(base, 'fire', 'Space', 'add').error, /already used for Fire/);
    const full = { ...base, fire: ['KeyA1', 'KeyB1', 'KeyC1', 'KeyD1', 'KeyE1', 'KeyF1'].map(c => c) };
    assert.match(assignKey(full, 'fire', 'KeyZ', 'add').error, /already has 6/);
    assert.equal(assignKey(full, 'fire', 'KeyZ', 'replace').error, null, 'replacing is still fine');
});

test('findKeyConflicts lists other actions using a code', () => {
    const base = defaultKeybinds();
    assert.deepEqual(findKeyConflicts(base, 'Space'), ['fire']);
    assert.deepEqual(findKeyConflicts(base, 'Space', 'fire'), []);
    assert.deepEqual(findKeyConflicts(base, 'KeyZ'), []);
});

// ---------------------------------------------------------- runtime: rebind API

test('a fresh manager has the default bindings', t => {
    const f = fixture(t);
    assert.deepEqual(f.input.keybinds, defaultKeybinds());
    assert.equal(f.storage.writes, 0, 'nothing is written just for starting up');
});

test('rebind changes what a key does, immediately', t => {
    const f = fixture(t);
    f.input.rebind('fire', ['KeyF']);
    f.key('Space');
    assert.equal(f.input.update().fire, false, 'the old key is dead');
    f.key('KeyF');
    const state = f.input.update();
    assert.equal(state.fire, true);
    assert.equal(state.firePressed, true);
    assert.deepEqual(f.input.keybinds.fire, ['KeyF']);
});

test('every action can be rebound and reads through to the input state', t => {
    const f = fixture(t);
    f.input.rebind('moveLeft', ['KeyQ']);
    f.input.rebind('moveRight', ['KeyE']);
    f.input.rebind('accelerate', ['KeyR']);
    f.input.rebind('brake', ['KeyF']);
    f.input.rebind('pause', ['KeyZ']);
    f.key('KeyQ');
    assert.equal(f.input.update().moveX, -1);
    f.key('KeyQ', 'keyup'); f.key('KeyE');
    assert.equal(f.input.update().moveX, 1);
    f.key('KeyE', 'keyup'); f.key('KeyR');
    assert.equal(f.input.update().moveY, 1, 'accelerate');
    f.key('KeyR', 'keyup'); f.key('KeyF');
    assert.equal(f.input.update().moveY, -1, 'brake');
    f.key('KeyF', 'keyup'); f.key('KeyZ');
    assert.equal(f.input.update().pausePressed, true);
    f.key('ArrowLeft'); f.key('KeyA');
    assert.equal(f.input.update().moveX, 0, 'the old movement keys do nothing');
});

test('several inputs per action all work, and releasing one while holding another keeps the action held', t => {
    const f = fixture(t);
    f.key('Space'); f.key('KeyJ');
    assert.equal(f.input.update().fire, true);
    f.key('Space', 'keyup');
    assert.equal(f.input.update().fire, true, 'KeyJ still holds it');
    f.key('KeyJ', 'keyup');
    assert.equal(f.input.update().fire, false);
});

test('Enter is a default fire key', t => {
    const f = fixture(t);
    f.key('Enter');
    const state = f.input.update();
    assert.deepEqual([state.fire, state.firePressed], [true, true]);
});

test('rebind validates its input and leaves the bindings untouched on failure', t => {
    const f = fixture(t);
    const before = f.input.keybinds;
    for (const [action, keys] of [
        ['nope', ['KeyA']], ['fire', []], ['fire', ['<x>']], ['fire', ['KeyM']], ['fire', ['KeyO']],
        ['fire', 'KeyA'], ['fire', [5]], ['fire', Array.from({ length: 7 }, (_, i) => `KeyF${i}`)],
    ]) {
        assert.throws(() => f.input.rebind(action, keys), RangeError, `${action} ${JSON.stringify(keys)}`);
    }
    assert.deepEqual(f.input.keybinds, before);
    assert.equal(f.storage.writes, 0);
});

test('rebind collapses duplicates and returns a defensive copy via keybinds', t => {
    const f = fixture(t);
    f.input.rebind('fire', ['KeyF', 'KeyF', 'KeyG']);
    assert.deepEqual(f.input.keybinds.fire, ['KeyF', 'KeyG']);
    const copy = f.input.keybinds;
    copy.fire.push('KeyZ');
    assert.deepEqual(f.input.keybinds.fire, ['KeyF', 'KeyG']);
});

test('setBindings replaces everything atomically: one bad action means no change at all', t => {
    const f = fixture(t);
    const config = { ...defaultKeybinds(), fire: ['KeyF'], pause: ['KeyM'] };
    assert.throws(() => f.input.setBindings(config), RangeError);
    assert.deepEqual(f.input.keybinds, defaultKeybinds());
    f.input.setBindings({ ...defaultKeybinds(), fire: ['KeyF'] });
    assert.deepEqual(f.input.keybinds.fire, ['KeyF']);
    assert.equal(f.storage.writes, 1, 'one write for the whole change');
});

test('rebinding releases anything held, so no key can stay stuck down', t => {
    const f = fixture(t);
    f.key('Space');
    assert.equal(f.input.update().fire, true);
    f.input.rebind('fire', ['KeyF']);
    assert.equal(f.input.update().fire, false);
    f.key('Space', 'keyup');
    assert.equal(f.input.update().fire, false);
});

test('resetDefaultBindings restores the defaults and forgets the saved ones', t => {
    const f = fixture(t);
    f.input.rebind('fire', ['KeyF']);
    assert.ok(f.storage.data.has(KEY));
    f.input.resetDefaultBindings();
    assert.deepEqual(f.input.keybinds, defaultKeybinds());
    assert.equal(f.storage.data.has(KEY), false);
    f.key('Space');
    assert.equal(f.input.update().fire, true);
});

test('onBindingsChange fires for rebind, setBindings and reset, and can unsubscribe', t => {
    const f = fixture(t);
    const seen = [];
    const off = f.input.onBindingsChange(config => seen.push(config.fire.join('+')));
    f.input.rebind('fire', ['KeyF']);
    f.input.setBindings({ ...defaultKeybinds(), fire: ['KeyG'] });
    f.input.resetDefaultBindings();
    assert.deepEqual(seen, ['KeyF', 'KeyG', 'Space+KeyJ+Mouse0+Enter']);
    off();
    f.input.rebind('fire', ['KeyH']);
    assert.equal(seen.length, 3);
});

// --------------------------------------------------------------- persistence

test('changes are saved as JSON under riverraid.keybinds', t => {
    const f = fixture(t);
    f.input.rebind('fire', ['KeyF', 'Mouse2']);
    assert.deepEqual(JSON.parse(f.storage.data.get(KEY)).fire, ['KeyF', 'Mouse2']);
    assert.equal(f.storage.writes, 1);
});

test('saved bindings are restored by a new manager', t => {
    const storage = new MemoryStorage();
    fixture(t, { storage }).input.rebind('fire', ['KeyF']);
    const second = fixture(t, { storage });
    assert.deepEqual(second.input.keybinds.fire, ['KeyF']);
    second.key('KeyF');
    assert.equal(second.input.update().fire, true);
});

test('corrupt saved bindings fall back to the defaults without throwing', t => {
    for (const bad of ['not json', '{"fire":', '[]', 'null', '{"fire":[5]}']) {
        const f = fixture(t, { storage: new MemoryStorage({ [KEY]: bad }) });
        assert.deepEqual(f.input.keybinds, defaultKeybinds(), bad);
    }
});

test('storage that throws on read or write never breaks the game', t => {
    const storage = new MemoryStorage();
    storage.failReads = true;
    storage.failWrites = true;
    const f = fixture(t, { storage });
    assert.deepEqual(f.input.keybinds, defaultKeybinds());
    assert.doesNotThrow(() => f.input.rebind('fire', ['KeyF']));
    assert.deepEqual(f.input.keybinds.fire, ['KeyF'], 'the change still applies for this session');
    assert.doesNotThrow(() => f.input.resetDefaultBindings());
});

test('storage: null disables persistence entirely', t => {
    const f = fixture(t, { storage: null });
    f.input.rebind('fire', ['KeyF']);
    assert.deepEqual(f.input.keybinds.fire, ['KeyF']);
    const g = fixture(t, { storage: null });
    assert.deepEqual(g.input.keybinds, defaultKeybinds());
});

// -------------------------------------------------------------------- mouse

test('left click fires: Mouse0 sets fire and firePressed for exactly one frame', t => {
    const f = fixture(t);
    f.mouse(0);
    const down = f.input.update();
    assert.deepEqual([down.fire, down.firePressed], [true, true]);
    const held = f.input.update();
    assert.deepEqual([held.fire, held.firePressed], [true, false]);
    f.mouse(0, 'mouseup');
    assert.equal(f.input.update().fire, false);
});

test('a quick click between frames still fires once', t => {
    const f = fixture(t);
    f.mouse(0);
    f.mouse(0, 'mouseup');
    const tap = f.input.update();
    assert.deepEqual([tap.fire, tap.firePressed], [false, true]);
    assert.equal(f.input.update().firePressed, false);
});

test('only bound buttons act: middle and right click do nothing by default', t => {
    const f = fixture(t);
    f.mouse(1); f.mouse(2);
    const state = f.input.update();
    assert.deepEqual([state.fire, state.moveX, state.moveY, state.pausePressed], [false, 0, 0, false]);
});

test('every mouse button can be bound to any action', t => {
    const f = fixture(t);
    f.input.rebind('pause', ['Mouse1']);
    f.input.rebind('accelerate', ['Mouse3']);
    f.mouse(1);
    assert.equal(f.input.update().pausePressed, true);
    f.mouse(3);
    assert.equal(f.input.update().moveY, 1);
    f.input.rebind('moveLeft', ['Mouse4']);
    f.mouse(4);
    assert.equal(f.input.update().moveX, -1);
});

test('the mouse counts as keyboard-side input for device arbitration', t => {
    const f = fixture(t);
    f.mouse(0);
    assert.equal(f.input.update().activeDevice, 'keyboard');
});

test('releasing the button outside the canvas still ends the press', t => {
    const f = fixture(t);
    f.mouse(0);
    assert.equal(f.input.update().fire, true);
    f.mouse(0, 'mouseup', f.document.body);
    assert.equal(f.input.update().fire, false);
});

test('mouse presses are prevented from selecting text or dragging, only while playing', t => {
    const f = fixture(t);
    assert.equal(f.mouse(0).defaultPrevented, true);
    assert.equal(f.mouse(1).defaultPrevented, false, 'an unbound button is left to the browser');
});

test('mouse and keyboard fire are combined before edge detection (no double edge)', t => {
    const f = fixture(t);
    f.key('Space');
    assert.equal(f.input.update().firePressed, true);
    f.mouse(0);
    const both = f.input.update();
    assert.deepEqual([both.fire, both.firePressed], [true, false], 'already firing: a second source adds no new press');
    f.key('Space', 'keyup');
    assert.equal(f.input.update().fire, true, 'the mouse still holds it');
});

test('the canvas must be focused: with focus elsewhere a click is not a shot', t => {
    const f = fixture(t);
    f.document.getElementById('field').focus();
    f.mouse(0);
    assert.equal(f.input.update().fire, false);
});

test('in window mode, clicks on buttons and links never fire; clicks on the page do', t => {
    const f = fixture(t, { attach: 'window' });
    f.canvas.focus();
    f.mouse(0, 'mousedown', f.document.getElementById('b'));
    assert.equal(f.input.update().fire, false, 'a UI button');
    f.mouse(0, 'mouseup', f.document.getElementById('b'));
    f.mouse(0, 'mousedown', f.document.body);
    assert.equal(f.input.update().fire, true, 'the bare page');
});

test('window mode also ignores clicks inside a dialog marked data-ui', t => {
    const f = fixture(t, { attach: 'window', html: '<canvas tabindex="0"></canvas><div data-ui><span id="s">x</span></div>' });
    f.canvas.focus();
    f.mouse(0, 'mousedown', f.document.getElementById('s'));
    assert.equal(f.input.update().fire, false);
});

// ------------------------------------------------------------- context menu

test('the context menu is suppressed on the canvas only when Mouse2 is bound to something', t => {
    const f = fixture(t);
    assert.equal(f.fire(f.canvas, 'contextmenu').defaultPrevented, false, 'Mouse2 is unbound by default: the menu works');
    f.input.rebind('brake', ['Mouse2']);
    assert.equal(f.fire(f.canvas, 'contextmenu').defaultPrevented, true);
    f.input.rebind('brake', ['KeyS']);
    assert.equal(f.fire(f.canvas, 'contextmenu').defaultPrevented, false, 'and comes back when it is unbound again');
});

test('the context menu is left alone outside the canvas', t => {
    const f = fixture(t);
    f.input.rebind('fire', ['Mouse2']);
    assert.equal(f.fire(f.document.getElementById('field'), 'contextmenu').defaultPrevented, false);
    assert.equal(f.fire(f.document.body, 'contextmenu').defaultPrevented, false);
    assert.equal(f.fire(f.canvas, 'contextmenu').defaultPrevented, true);
});

test('right click as fire works end to end', t => {
    const f = fixture(t);
    f.input.rebind('fire', ['Mouse2']);
    f.mouse(2);
    assert.equal(f.input.update().firePressed, true);
    f.mouse(2, 'mouseup');
    assert.equal(f.input.update().fire, false);
});

test('in window mode the context menu is only suppressed away from controls', t => {
    const f = fixture(t, { attach: 'window' });
    f.input.rebind('fire', ['Mouse2']);
    assert.equal(f.fire(f.canvas, 'contextmenu').defaultPrevented, true);
    assert.equal(f.fire(f.document.getElementById('b'), 'contextmenu').defaultPrevented, false);
    assert.equal(f.fire(f.document.getElementById('field'), 'contextmenu').defaultPrevented, false);
});

// ------------------------------------------------------------ listenNextInput

test('listenNextInput delivers the next key code once and stops listening', t => {
    const f = fixture(t);
    const seen = [];
    f.input.listenNextInput(code => seen.push(code));
    f.key('KeyX');
    f.key('KeyY');
    assert.deepEqual(seen, ['KeyX']);
    assert.equal(f.input.isCapturing, false);
});

test('listenNextInput delivers mouse codes too', t => {
    const f = fixture(t);
    const seen = [];
    f.input.listenNextInput(code => seen.push(code));
    f.mouse(2);
    assert.deepEqual(seen, ['Mouse2']);
    const again = [];
    f.input.listenNextInput(code => again.push(code));
    f.mouse(0);
    assert.deepEqual(again, ['Mouse0']);
});

test('the captured press is consumed: it never reaches the game or the page', t => {
    const f = fixture(t);
    const pageSaw = [];
    f.document.addEventListener('keydown', e => pageSaw.push(e.code));
    f.document.addEventListener('mousedown', e => pageSaw.push(`m${e.button}`));
    f.input.listenNextInput(() => {});
    const key = f.key('Space');
    assert.equal(key.defaultPrevented, true);
    f.input.listenNextInput(() => {});
    f.mouse(0);
    assert.deepEqual(pageSaw, [], 'no other listener saw either press');
    assert.equal(f.input.update().fire, false, 'and the jet did not fire');
});

test('a key the game normally reacts to is captured instead of played', t => {
    const f = fixture(t);
    f.input.listenNextInput(() => {});
    f.key('ArrowLeft');
    assert.equal(f.input.update().moveX, 0);
});

test('listenNextInput also captures reserved keys, so the caller can explain why they are refused', t => {
    const f = fixture(t);
    const seen = [];
    f.input.listenNextInput(code => seen.push(code));
    f.key('KeyM');
    assert.deepEqual(seen, ['KeyM']);
});

test('the unbind function cancels the wait and is safe to call again', t => {
    const f = fixture(t);
    const seen = [];
    const cancel = f.input.listenNextInput(code => seen.push(code));
    assert.equal(f.input.isCapturing, true);
    cancel();
    assert.equal(f.input.isCapturing, false);
    f.key('KeyX');
    assert.deepEqual(seen, []);
    assert.doesNotThrow(() => cancel());
    f.key('KeyX', 'keyup');
    f.key('Space');
    assert.equal(f.input.update().fire, true, 'normal play resumes at once');
});

test('cancelling after the capture already fired is harmless', t => {
    const f = fixture(t);
    const seen = [];
    const cancel = f.input.listenNextInput(code => seen.push(code));
    f.key('KeyX');
    cancel();
    assert.deepEqual(seen, ['KeyX']);
});

test('key repeat is not "the next press", but the first real press after it is', t => {
    const f = fixture(t);
    const seen = [];
    f.input.listenNextInput(code => seen.push(code));
    f.key('KeyH', 'keydown', { repeat: true });
    assert.deepEqual(seen, [], 'a key already held when the wait began');
    f.key('KeyJ');
    assert.deepEqual(seen, ['KeyJ']);
});

test('listeners that register together all hear the same single press', t => {
    const f = fixture(t);
    const a = [];
    const b = [];
    f.input.listenNextInput(code => a.push(code));
    f.input.listenNextInput(code => b.push(code));
    f.key('KeyX');
    assert.deepEqual([a, b], [['KeyX'], ['KeyX']]);
});

test('the key-up and click after a captured press are swallowed; later ones are not', t => {
    const f = fixture(t);
    f.input.listenNextInput(() => {});
    f.key('KeyX');
    assert.equal(f.key('KeyX', 'keyup').defaultPrevented, true, 'the release of the captured key');
    assert.equal(f.key('KeyX', 'keyup').defaultPrevented, false, 'but only that once');

    f.input.listenNextInput(() => {});
    f.mouse(0);
    f.mouse(0, 'mouseup');
    const clickSeen = [];
    f.document.getElementById('b').addEventListener('click', () => clickSeen.push('b'));
    f.fire(f.document.getElementById('b'), 'click');
    assert.deepEqual(clickSeen, [], 'the click that follows a captured mouse press never reaches the control under it');
    f.fire(f.document.getElementById('b'), 'click');
    assert.deepEqual(clickSeen, ['b'], 'the next click is normal');
});

test('capturing the right button also swallows its context menu', t => {
    const f = fixture(t);
    f.input.listenNextInput(() => {});
    f.mouse(2);
    assert.equal(f.fire(f.canvas, 'contextmenu').defaultPrevented, true);
});

test('capture ignores IME composition', t => {
    const f = fixture(t);
    const seen = [];
    f.input.listenNextInput(code => seen.push(code));
    f.key('KeyX', 'keydown', { isComposing: true });
    assert.deepEqual(seen, []);
    f.key('KeyY');
    assert.deepEqual(seen, ['KeyY']);
});

test('capture needs an attached manager', () => {
    const input = new InputManager({ storage: null });
    assert.throws(() => input.listenNextInput(() => {}), /attach/);
});

test('destroy cancels pending captures', t => {
    const f = fixture(t);
    const seen = [];
    f.input.listenNextInput(code => seen.push(code));
    f.input.destroy();
    assert.equal(f.input.isCapturing, false);
    f.key('KeyX');
    assert.deepEqual(seen, []);
});

test('typing in a text field still works while a capture is pending only if the window listener sees it first', t => {
    const f = fixture(t);
    const seen = [];
    f.input.listenNextInput(code => seen.push(code));
    f.key('KeyQ', 'keydown', {}, f.document.getElementById('field'));
    assert.deepEqual(seen, ['KeyQ'], 'a pending rebind captures from anywhere, including a focused field');
});

// ------------------------------------------------- the prior behaviours still hold

test('arrow keys and Space still scroll-lock, and unbound keys are ignored entirely', t => {
    const f = fixture(t);
    assert.equal(f.key('ArrowUp').defaultPrevented, true);
    assert.equal(f.key('Space').defaultPrevented, true);
    assert.equal(f.key('KeyZ').defaultPrevented, false);
    // Space is only protected while it is a game control: once unbound the page gets it back.
    f.input.rebind('fire', ['KeyZ']);
    assert.equal(f.key('Space').defaultPrevented, false);
    assert.equal(f.key('KeyZ').defaultPrevented, false, 'a letter has no default scroll behaviour to block');
    f.input.rebind('fire', ['KeyZ', 'Space']);
    assert.equal(f.key('Space').defaultPrevented, true);
});
