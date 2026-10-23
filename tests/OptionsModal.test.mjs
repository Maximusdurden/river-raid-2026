import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { Engine } from '../dist/src/core/Engine.js';
import { DEFAULT_KEYBINDS, InputManager, defaultKeybinds } from '../dist/src/core/InputManager.js';
import { SoundEngine } from '../dist/src/audio/SoundEngine.js';
import { GameSession } from '../dist/src/game/GameSession.js';
import { saveGameMode } from '../dist/src/game/GameMode.js';
import { OptionsModal } from '../dist/src/ui/OptionsModal.js';
import { DT, idle } from './helpers.mjs';

class MemoryStorage {
    constructor() { this.data = new Map(); }
    getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
    setItem(key, value) { this.data.set(key, String(value)); }
    removeItem(key) { this.data.delete(key); }
}

/** A real InputManager, SoundEngine (no AudioContext) and Engine behind a real OptionsModal, in jsdom. */
function fixture(t, { storage = new MemoryStorage(), mode = 'campaign', realInput = false } = {}) {
    const dom = new JSDOM(
        '<button id="opener">open</button><div id="stage"><canvas id="c" tabindex="0"></canvas></div><input id="seed" type="text"><button id="other">other</button>',
        { pretendToBeVisual: true },
    );
    const { window } = dom;
    const { document } = window;
    const canvas = document.getElementById('c');
    Object.defineProperty(window.navigator, 'getGamepads', { configurable: true, value: () => [] });
    Object.defineProperty(document, 'hasFocus', { value: () => true });

    const input = new InputManager({ storage });
    // `realInput: 'modal-first'` attaches the input manager AFTER the modal exists, exactly as main.ts does, so the
    // modal's window keydown listener runs first. 'input-first' is the opposite order. Both must behave.
    if (realInput !== 'modal-first') input.attach(canvas);
    const sound = new SoundEngine({ storage, createContext: undefined });
    const session = new GameSession({ mode });
    const state = { mode, opened: [] };
    let script = () => ({});
    let frame = 0;
    const engine = new Engine({
        seed: 5, simulation: session,
        // `realInput` feeds the engine from the genuine InputManager, so a key reaches the modal AND the pause logic.
        input: realInput ? input : { update: () => idle(script(frame++)) },
        renderer: { setWorld() {}, render() {} },
    });
    const modal = new OptionsModal({
        document, input, sound,
        getMode: () => session.mode,
        setMode: m => { session.setMode(m); saveGameMode(storage, m); state.mode = m; },
        holdPause: () => engine.holdPause(),
        returnFocus: canvas,
        onOpenChange: open => state.opened.push(open),
    });
    if (realInput === 'modal-first') input.attach(canvas);
    canvas.focus();
    t.after(() => {
        modal.destroy();
        input.destroy();
        window.close();
    });
    const q = selector => document.querySelector(selector);
    const all = selector => [...document.querySelectorAll(selector)];
    const click = el => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    const key = (code, extra = {}, target = document.activeElement ?? document.body, type = 'keydown') => {
        const event = new window.KeyboardEvent(type, { code, bubbles: true, cancelable: true, composed: true, ...extra });
        target.dispatchEvent(event);
        return event;
    };
    const mouse = (button, type = 'mousedown', target = document.body) => {
        const event = new window.MouseEvent(type, { button, bubbles: true, cancelable: true, composed: true });
        target.dispatchEvent(event);
        return event;
    };
    return {
        window, document, canvas, input, sound, session, engine, modal, storage, state, q, all, click, key, mouse,
        setScript: fn => { script = fn; frame = 0; },
        run: n => { for (let i = 0; i < n; i++) engine.runFrame(DT); },
        row: action => q(`.options-binding[data-action="${action}"]`),
        chips: action => [...q(`.options-binding[data-action="${action}"]`).querySelectorAll('.options-chip')].map(c => c.getAttribute('data-code')),
        button: (role, action) => q(`[data-role="${role}"]${action ? `[data-action="${action}"]` : ''}`),
        status: () => q('.options-status').textContent,
    };
}

// ------------------------------------------------------------- structure

test('the screen is built once, hidden, and labelled as a modal dialog', t => {
    const f = fixture(t);
    assert.equal(f.all('.options-backdrop').length, 1);
    assert.equal(f.q('.options-backdrop').hidden, true);
    const dialog = f.q('[role="dialog"]');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.equal(f.q(`#${dialog.getAttribute('aria-labelledby')}`).textContent, 'OPTIONS');
    assert.equal(f.modal.isOpen, false);
});

test('it has Controls, Audio and Game Mode sections', t => {
    const f = fixture(t);
    assert.deepEqual(f.all('.options-section h3').map(h => h.textContent), ['CONTROLS', 'AUDIO', 'GAME MODE']);
});

test('every action is listed with its current inputs shown as friendly names', t => {
    const f = fixture(t);
    assert.deepEqual(f.all('.options-action').map(e => e.textContent), ['Left', 'Right', 'Boost', 'Brake', 'Fire', 'Pause']);
    const labels = action => [...f.row(action).querySelectorAll('.options-chip')].map(c => c.firstChild.textContent);
    assert.deepEqual(labels('fire'), ['Space', 'J', 'Left Click', 'Enter']);
    assert.deepEqual(labels('moveLeft'), ['Left Arrow', 'A']);
    assert.deepEqual(labels('pause'), ['Esc', 'P']);
});

test('the audio section has the volume slider, mute and the three channel switches', t => {
    const f = fixture(t);
    assert.ok(f.q('[data-role="volume"]'));
    for (const role of ['muted', 'sfx', 'drone', 'warnings']) assert.equal(f.q(`[data-role="${role}"]`).type, 'checkbox', role);
    assert.deepEqual(f.all('.options-section')[1].querySelectorAll('input').length, 5);
});

test('the game-mode section offers Campaign (10 Bridges) and Endless River', t => {
    const f = fixture(t);
    const labels = f.all('[data-role="mode"]').map(r => r.parentElement.querySelector('.options-label').textContent);
    assert.deepEqual(labels, ['Campaign (10 Bridges)', 'Endless River']);
    assert.deepEqual(f.all('[data-role="mode"]').map(r => r.type), ['radio', 'radio']);
});

test('the controls reflect the live state when it opens', t => {
    const f = fixture(t, { mode: 'endless' });
    f.input.rebind('fire', ['KeyF']);
    f.sound.setSfxEnabled(false);
    f.sound.setMasterVolume(0.35);
    f.modal.open();
    assert.deepEqual(f.chips('fire'), ['KeyF']);
    assert.equal(f.q('[data-role="sfx"]').checked, false);
    assert.equal(f.q('[data-role="volume"]').value, '35');
    assert.equal(f.q('.options-value').textContent, '35%');
    assert.equal(f.all('[data-role="mode"]').find(r => r.checked).value, 'endless');
});

// ------------------------------------------------------------- open / close

test('the O key opens it, and again closes it', t => {
    const f = fixture(t);
    f.key('KeyO', {}, f.canvas);
    assert.equal(f.modal.isOpen, true);
    assert.equal(f.q('.options-backdrop').hidden, false);
    f.key('KeyO');
    assert.equal(f.modal.isOpen, false);
    assert.deepEqual(f.state.opened, [true, false]);
});

test('Esc and the Done and X buttons close it', t => {
    const f = fixture(t);
    f.modal.open();
    f.key('Escape');
    assert.equal(f.modal.isOpen, false);
    f.modal.open();
    f.click(f.all('[data-role="close"]').at(-1));
    assert.equal(f.modal.isOpen, false);
    f.modal.open();
    f.click(f.q('.options-close'));
    assert.equal(f.modal.isOpen, false);
});

test('clicking the dimmed backdrop closes it; clicking inside, or dragging onto it, does not', t => {
    const f = fixture(t);
    f.modal.open();
    f.click(f.q('.options-dialog'));
    assert.equal(f.modal.isOpen, true);
    f.q('.options-dialog').dispatchEvent(new f.window.MouseEvent('mousedown', { bubbles: true }));
    f.click(f.q('.options-backdrop'));
    assert.equal(f.modal.isOpen, true, 'a drag that began inside and ended on the backdrop');
    f.mouse(0, 'mousedown', f.q('.options-backdrop'));
    f.click(f.q('.options-backdrop'));
    assert.equal(f.modal.isOpen, false);
});

test('O is ignored while typing in a text field, and with modifiers or key repeat', t => {
    const f = fixture(t);
    const seed = f.document.getElementById('seed');
    seed.focus();
    f.key('KeyO', {}, seed);
    assert.equal(f.modal.isOpen, false, 'a text field owns the key');
    f.canvas.focus();
    f.key('KeyO', { ctrlKey: true });
    f.key('KeyO', { altKey: true });
    f.key('KeyO', { metaKey: true });
    f.key('KeyO', { repeat: true });
    assert.equal(f.modal.isOpen, false);
    f.key('KeyO');
    assert.equal(f.modal.isOpen, true);
});

test('O still closes the screen while a slider or checkbox inside it has focus (they are not text entry)', t => {
    const f = fixture(t);
    f.modal.open();
    f.q('[data-role="volume"]').focus();
    f.key('KeyO');
    assert.equal(f.modal.isOpen, false);
});

test('O is ignored while a rebind is waiting for input', t => {
    const f = fixture(t);
    f.modal.open();
    f.click(f.button('rebind', 'fire'));
    assert.equal(f.modal.isCapturing, true);
    f.key('KeyO');
    assert.equal(f.modal.isOpen, true, 'the capture consumed it: O is refused as reserved, and the screen stays');
    assert.match(f.status(), /reserved for options/);
});

test('opening holds the game paused; closing releases it', t => {
    const f = fixture(t);
    f.run(5);
    const ticks = f.engine.getStats().tickCount;
    f.modal.open();
    assert.equal(f.engine.isPaused, true);
    f.run(10);
    assert.equal(f.engine.getStats().tickCount, ticks, 'the simulation is frozen behind the screen');
    f.modal.close();
    assert.equal(f.engine.isPaused, false);
    f.run(5);
    assert.equal(f.engine.getStats().tickCount, ticks + 5);
});

// Regression (found in a real browser): Esc closes the screen AND is the pause key. The input manager
// latches the press until the next frame, by which time the hold was gone, so the game stayed frozen.
for (const order of ['modal-first', 'input-first']) {
test(`closing with Esc resumes the game instead of leaving it paused (real input, ${order})`, t => {
    const f = fixture(t, { realInput: order });
    f.run(3);
    f.modal.open();
    f.run(3);
    const frozenAt = f.engine.getStats().tickCount;
    f.key('Escape');                       // keydown reaches both the modal and the input manager
    f.key('Escape', {}, undefined, 'keyup');
    assert.equal(f.modal.isOpen, false);
    f.run(5);
    assert.equal(f.engine.isUserPaused, false, 'Esc must not toggle the player\u2019s pause');
    assert.equal(f.engine.isPaused, false);
    assert.equal(f.engine.getStats().tickCount, frozenAt + 5, 'the simulation is running again');
});

test(`closing with the Options key or the Done button also leaves the game running (real input, ${order})`, t => {
    const f = fixture(t, { realInput: order });
    f.modal.open();
    f.key('KeyO');
    f.key('KeyO', {}, undefined, 'keyup');
    f.run(2);
    assert.equal(f.engine.isPaused, false, 'closed with O');
    f.modal.open();
    f.click(f.button('close'));
    f.run(2);
    assert.equal(f.engine.isPaused, false, 'closed with the Close button');
});

test(`the pause key does nothing while the screen is open, and works normally right after it closes (real input, ${order})`, t => {
    const f = fixture(t, { realInput: order });
    f.modal.open();
    f.key('KeyP'); f.key('KeyP', {}, undefined, 'keyup');
    f.run(2);
    f.modal.close();
    f.run(2);
    assert.equal(f.engine.isUserPaused, false, 'a P pressed behind the screen is not saved up for later');
    f.key('KeyP', {}, f.canvas); f.key('KeyP', {}, f.canvas, 'keyup');
    f.run(1);
    assert.equal(f.engine.isUserPaused, true, 'but P still pauses once the screen is closed');
    f.key('Escape', {}, f.canvas); f.key('Escape', {}, f.canvas, 'keyup');
    f.run(1);
    assert.equal(f.engine.isUserPaused, false, 'and Esc still unpauses');
});
}

test('a pause the player made themselves survives opening and closing the screen', t => {
    const f = fixture(t);
    f.setScript(n => (n === 0 ? { pausePressed: true } : {}));
    f.run(2);
    assert.equal(f.engine.isUserPaused, true);
    f.modal.open();
    f.modal.close();
    assert.equal(f.engine.isPaused, true, 'still paused, as the player left it');
});

test('closing returns focus to the game canvas, and a click on the canvas then plays again', t => {
    const f = fixture(t);
    f.document.getElementById('other').focus();
    f.modal.open();
    assert.equal(f.modal.isOpen && f.document.activeElement === f.q('.options-dialog'), true, 'focus moves into the dialog');
    f.modal.close();
    assert.equal(f.document.activeElement, f.canvas);
});

test('without an explicit target focus returns to whatever had it before', t => {
    const dom = new JSDOM('<button id="a">a</button><button id="b">b</button>');
    const { document } = dom.window;
    const storage = new MemoryStorage();
    const input = new InputManager({ storage });
    input.attach(dom.window);
    const modal = new OptionsModal({
        document, input, sound: new SoundEngine({ storage }), getMode: () => 'campaign', setMode: () => {}, holdPause: () => () => {},
    });
    document.getElementById('b').focus();
    modal.open();
    modal.close();
    assert.equal(document.activeElement, document.getElementById('b'));
    modal.destroy();
    input.destroy();
});

test('open and close are idempotent, and a destroyed screen cannot be reopened', t => {
    const f = fixture(t);
    f.modal.open();
    f.modal.open();
    f.modal.close();
    f.modal.close();
    assert.deepEqual(f.state.opened, [true, false], 'one open, one close');
    assert.equal(f.engine.isPaused, false, 'one hold taken, one released');
    f.modal.destroy();
    f.modal.open();
    assert.equal(f.modal.isOpen, false);
    assert.equal(f.all('.options-backdrop').length, 0, 'removed from the page');
    assert.doesNotThrow(() => f.modal.destroy());
});

test('destroying while open releases the pause hold', t => {
    const f = fixture(t);
    f.modal.open();
    f.modal.destroy();
    assert.equal(f.engine.isPaused, false);
});

test('Tab cycles inside the dialog and never escapes to the page behind', t => {
    const f = fixture(t);
    f.modal.open();
    const items = f.all('.options-dialog button:not([disabled]), .options-dialog input:not([disabled])');
    const first = items[0];
    const last = items.at(-1);
    last.focus();
    const forward = f.key('Tab', {}, last);
    assert.equal(forward.defaultPrevented, true);
    assert.equal(f.document.activeElement, first, 'wraps from the last control to the first');
    const back = f.key('Tab', { shiftKey: true }, first);
    assert.equal(back.defaultPrevented, true);
    assert.equal(f.document.activeElement, last, 'and back again');
    f.document.getElementById('other').focus();
    assert.ok(f.q('.options-dialog').contains(f.document.activeElement), 'focus moved elsewhere is pulled back in');
});

// ------------------------------------------------------------------ rebinding

test('Rebind enters capture mode and says so', t => {
    const f = fixture(t);
    f.modal.open();
    f.click(f.button('rebind', 'fire'));
    assert.equal(f.modal.isCapturing, true);
    assert.equal(f.input.isCapturing, true);
    assert.equal(f.button('rebind', 'fire').textContent, 'Press any key or click mouse\u2026');
    assert.equal(f.row('fire').getAttribute('data-capturing'), 'replace');
    assert.match(f.status(), /press a key or click a mouse button/i);
});

test('pressing a key rebinds: the action then has exactly that input', t => {
    const f = fixture(t);
    f.modal.open();
    f.click(f.button('rebind', 'moveLeft'));
    f.key('KeyQ');
    assert.equal(f.modal.isCapturing, false);
    assert.deepEqual(f.input.keybinds.moveLeft, ['KeyQ']);
    assert.deepEqual(f.chips('moveLeft'), ['KeyQ']);
    assert.match(f.status(), /Left: Q\./);
    assert.equal(f.button('rebind', 'moveLeft').textContent, 'Rebind');
});

test('clicking the mouse rebinds to that button (and does not press whatever is under the pointer)', t => {
    const f = fixture(t);
    f.modal.open();
    const clicks = [];
    f.q('.options-dialog').addEventListener('click', e => clicks.push(e.target.getAttribute('data-role')));
    f.click(f.button('rebind', 'fire'));
    clicks.length = 0;
    f.mouse(2, 'mousedown', f.button('rebind', 'brake'));
    f.mouse(2, 'mouseup', f.button('rebind', 'brake'));
    f.click(f.button('rebind', 'brake'));
    assert.deepEqual(clicks, [], 'the click that follows the captured press never reaches the button under it');
    assert.deepEqual(f.input.keybinds.fire, ['Mouse2'], 'right click became Fire');
    assert.match(f.status(), /Fire: Right Click/);
});

test('a left click can be captured as a binding', t => {
    const f = fixture(t);
    f.modal.open();
    f.click(f.button('rebind', 'brake'));
    f.mouse(0, 'mousedown', f.q('.options-footer'));
    assert.deepEqual(f.input.keybinds.brake, ['Mouse0']);
    assert.deepEqual(f.input.keybinds.fire, ['Space', 'KeyJ', 'Enter'], 'Mouse0 moved off Fire');
    assert.match(f.status(), /taken from Fire/);
});

test('Add appends another input instead of replacing', t => {
    const f = fixture(t);
    f.modal.open();
    f.click(f.button('add', 'accelerate'));
    assert.equal(f.row('accelerate').getAttribute('data-capturing'), 'add');
    f.key('KeyT');
    assert.deepEqual(f.input.keybinds.accelerate, ['ArrowUp', 'KeyW', 'KeyT']);
    assert.match(f.status(), /T added/);
});

test('an input already used elsewhere moves to the new action and the other one is told', t => {
    const f = fixture(t);
    f.modal.open();
    f.click(f.button('rebind', 'pause'));
    f.key('Space');
    assert.deepEqual(f.input.keybinds.pause, ['Space']);
    assert.ok(!f.input.keybinds.fire.includes('Space'));
    assert.match(f.status(), /taken from Fire/);
    assert.deepEqual(f.chips('fire'), ['KeyJ', 'Mouse0', 'Enter'], 'the list refreshes');
});

test('stealing an action\u2019s last input is refused, with a clear message, and nothing changes', t => {
    const f = fixture(t);
    f.input.rebind('brake', ['KeyX']);
    f.modal.open();
    f.click(f.button('rebind', 'fire'));
    f.key('KeyX');
    assert.match(f.status(), /only input for Brake/);
    assert.equal(f.q('.options-status').getAttribute('data-kind'), 'error');
    assert.deepEqual(f.input.keybinds.brake, ['KeyX']);
    assert.deepEqual(f.input.keybinds.fire, DEFAULT_KEYBINDS.fire);
});

test('M and O are reserved: they are refused with an explanation', t => {
    const f = fixture(t);
    f.modal.open();
    f.click(f.button('rebind', 'fire'));
    f.key('KeyM');
    assert.match(f.status(), /M is reserved for mute/);
    assert.deepEqual(f.input.keybinds.fire, DEFAULT_KEYBINDS.fire);
    f.click(f.button('rebind', 'fire'));
    f.key('KeyO');
    assert.match(f.status(), /O is reserved for options/);
    assert.equal(f.modal.isOpen, true);
});

test('Esc cancels a rebind without closing the screen or changing anything', t => {
    const f = fixture(t);
    f.modal.open();
    f.click(f.button('rebind', 'fire'));
    f.key('Escape');
    assert.equal(f.modal.isOpen, true, 'the screen stays open');
    assert.equal(f.modal.isCapturing, false);
    assert.equal(f.input.isCapturing, false);
    assert.deepEqual(f.input.keybinds.fire, DEFAULT_KEYBINDS.fire);
    assert.equal(f.status(), 'Cancelled.');
    f.key('Escape');
    assert.equal(f.modal.isOpen, false, 'a second Esc then closes it');
});

test('closing the screen mid-rebind cancels the wait', t => {
    const f = fixture(t);
    f.modal.open();
    f.click(f.button('rebind', 'fire'));
    f.modal.close();
    assert.equal(f.input.isCapturing, false);
    f.key('KeyZ', {}, f.canvas);
    assert.deepEqual(f.input.keybinds.fire, DEFAULT_KEYBINDS.fire);
});

test('starting a second rebind replaces the first; there is only ever one wait', t => {
    const f = fixture(t);
    f.modal.open();
    f.click(f.button('rebind', 'fire'));
    f.click(f.button('rebind', 'brake'));
    assert.equal(f.q('[data-capturing]').getAttribute('data-action'), 'brake');
    f.key('KeyZ');
    assert.deepEqual(f.input.keybinds.brake, ['KeyZ']);
    assert.deepEqual(f.input.keybinds.fire, DEFAULT_KEYBINDS.fire, 'the first wait never completed');
});

test('a chip\u2019s \u00d7 removes one input, but never the last', t => {
    const f = fixture(t);
    f.modal.open();
    f.click(f.q('.options-chip-remove[data-action="fire"][data-code="Enter"]'));
    assert.deepEqual(f.input.keybinds.fire, ['Space', 'KeyJ', 'Mouse0']);
    f.input.rebind('pause', ['KeyP']);
    const last = f.q('.options-chip-remove[data-action="pause"]');
    assert.equal(last.disabled, true, 'the last input cannot be removed');
    f.click(last);
    assert.deepEqual(f.input.keybinds.pause, ['KeyP']);
});

test('Add is disabled once an action has the maximum number of inputs', t => {
    const f = fixture(t);
    f.input.rebind('fire', ['KeyA1', 'KeyB1', 'KeyC1', 'KeyD1', 'KeyE1', 'KeyF1']);
    f.modal.open();
    assert.equal(f.button('add', 'fire').disabled, true);
    assert.equal(f.button('add', 'brake').disabled, false);
});

test('rebinding really changes how the game responds', t => {
    const f = fixture(t);
    f.modal.open();
    f.click(f.button('rebind', 'fire'));
    f.key('KeyF');
    f.modal.close();
    f.canvas.focus();
    f.key('Space', {}, f.canvas);
    assert.equal(f.input.update().fire, false);
    f.key('KeyF', {}, f.canvas);
    assert.equal(f.input.update().firePressed, true);
});

test('Reset Controls to Default restores everything and forgets what was saved', t => {
    const f = fixture(t);
    f.input.rebind('fire', ['KeyF']);
    f.input.rebind('moveLeft', ['KeyQ']);
    f.modal.open();
    assert.deepEqual(f.chips('fire'), ['KeyF']);
    f.click(f.q('[data-role="reset-controls"]'));
    assert.deepEqual(f.input.keybinds, defaultKeybinds());
    assert.deepEqual(f.chips('fire'), ['Space', 'KeyJ', 'Mouse0', 'Enter']);
    assert.equal(f.storage.data.has('riverraid.keybinds'), false);
    assert.equal(f.status(), 'Controls reset to default.');
});

test('Reset also cancels a rebind that was waiting', t => {
    const f = fixture(t);
    f.modal.open();
    f.click(f.button('rebind', 'fire'));
    f.click(f.q('[data-role="reset-controls"]'));
    assert.equal(f.input.isCapturing, false);
    assert.equal(f.modal.isCapturing, false);
});

test('changes made elsewhere (another tab, the console) show up in the open screen', t => {
    const f = fixture(t);
    f.modal.open();
    f.input.rebind('brake', ['KeyX']);
    assert.deepEqual(f.chips('brake'), ['KeyX']);
});

test('keyboard focus survives the list being redrawn after a rebind', t => {
    const f = fixture(t);
    f.modal.open();
    f.click(f.button('rebind', 'fire'));
    f.key('KeyF');
    assert.equal(f.document.activeElement, f.button('rebind', 'fire'), 'focus lands back on the button that was used');
});

// ---------------------------------------------------------------------- audio

test('the volume slider sets the master volume live', t => {
    const f = fixture(t);
    f.modal.open();
    const slider = f.q('[data-role="volume"]');
    slider.value = '25';
    slider.dispatchEvent(new f.window.Event('input', { bubbles: true }));
    assert.equal(f.sound.masterVolume, 0.25);
    assert.equal(f.q('.options-value').textContent, '25%');
    assert.equal(JSON.parse(f.storage.data.get('riverraid.audio_settings')).masterVolume, 0.25);
});

test('each checkbox drives its own channel, and the screen follows outside changes', t => {
    const f = fixture(t);
    f.modal.open();
    const toggle = role => {
        const box = f.q(`[data-role="${role}"]`);
        box.checked = !box.checked;
        box.dispatchEvent(new f.window.Event('change', { bubbles: true }));
    };
    toggle('sfx');
    assert.deepEqual([f.sound.sfxEnabled, f.sound.droneEnabled, f.sound.warningsEnabled, f.sound.muted], [false, true, true, false]);
    toggle('drone');
    toggle('warnings');
    assert.deepEqual([f.sound.sfxEnabled, f.sound.droneEnabled, f.sound.warningsEnabled], [false, false, false]);
    toggle('muted');
    assert.equal(f.sound.muted, true);
    assert.deepEqual(JSON.parse(f.storage.data.get('riverraid.audio_settings')),
        { masterVolume: 0.6, muted: true, sfxEnabled: false, droneEnabled: false, warningsEnabled: false });

    f.sound.setMuted(false);
    f.sound.setSfxEnabled(true);
    assert.equal(f.q('[data-role="muted"]').checked, false, 'the M key toggled mute elsewhere: the box follows');
    assert.equal(f.q('[data-role="sfx"]').checked, true);
});

test('while muted, the channel switches read as inactive', t => {
    const f = fixture(t);
    f.modal.open();
    f.sound.setMuted(true);
    assert.equal(f.q('[data-role="sfx"]').parentElement.hasAttribute('data-dimmed'), true);
    f.sound.setMuted(false);
    assert.equal(f.q('[data-role="sfx"]').parentElement.hasAttribute('data-dimmed'), false);
});

// ------------------------------------------------------------------ game mode

test('choosing Endless River switches the session, remembers it, and the radio follows', t => {
    const f = fixture(t);
    f.modal.open();
    const endless = f.all('[data-role="mode"]').find(r => r.value === 'endless');
    endless.checked = true;
    endless.dispatchEvent(new f.window.Event('change', { bubbles: true }));
    assert.equal(f.session.mode, 'endless');
    assert.equal(f.session.victoryGoal, 0);
    assert.equal(f.storage.data.get('riverraid.game_mode'), 'endless');
    const campaign = f.all('[data-role="mode"]').find(r => r.value === 'campaign');
    campaign.checked = true;
    campaign.dispatchEvent(new f.window.Event('change', { bubbles: true }));
    assert.equal(f.session.mode, 'campaign');
    assert.equal(f.storage.data.get('riverraid.game_mode'), 'campaign');
});

test('the mode radios show the persisted mode when the screen opens', t => {
    const f = fixture(t, { mode: 'endless' });
    f.modal.open();
    assert.equal(f.all('[data-role="mode"]').find(r => r.checked).value, 'endless');
});

// --------------------------------------------------------------------- safety

test('labels are plain text: a hostile key code cannot inject markup', t => {
    const f = fixture(t);
    f.input.rebind('fire', ['KeyF']);
    f.modal.open();
    assert.equal(f.all('.options-dialog script, .options-dialog img').length, 0);
    for (const chip of f.all('.options-chip')) assert.equal(chip.children.length, 1, 'only the remove button');
});

test('the screen never leaves listeners behind after destroy', t => {
    const f = fixture(t);
    f.modal.open();
    f.modal.destroy();
    f.key('KeyO', {}, f.canvas);
    assert.equal(f.modal.isOpen, false);
    f.input.rebind('fire', ['KeyF']);
    f.sound.setSfxEnabled(false);
    assert.equal(f.all('.options-backdrop').length, 0);
});
