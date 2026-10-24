import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { DEFAULT_AUDIO_CHANNELS } from '../dist/src/audio/SoundEngine.js';
import { InputManager, RESERVED_CODES, assignKey, defaultKeybinds, sanitizeKeybinds } from '../dist/src/core/InputManager.js';
import { Engine } from '../dist/src/core/Engine.js';
import { HighScoreBoard } from '../dist/src/systems/HighScoreSystem.js';
import { CONFIRM_GRACE_MS, InitialsEntry } from '../dist/src/ui/InitialsEntry.js';
import { LeaderboardView, MODE_LABEL, ordinal } from '../dist/src/ui/LeaderboardView.js';
import { OptionsModal } from '../dist/src/ui/OptionsModal.js';
import { DT, headlessGame, idle } from './helpers.mjs';

class MemoryStorage {
    constructor() { this.data = new Map(); }
    getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
    setItem(key, value) { this.data.set(key, String(value)); }
    removeItem(key) { this.data.delete(key); }
}

const PAGE = '<button id="opener">open</button><div id="stage"><canvas id="c" tabindex="0"></canvas></div><input id="seed" type="text"><button id="other">other</button>';

function page(t) {
    const dom = new JSDOM(PAGE, { pretendToBeVisual: true });
    const { window } = dom;
    Object.defineProperty(window.navigator, 'getGamepads', { configurable: true, value: () => [] });
    Object.defineProperty(window.document, 'hasFocus', { value: () => true });
    t.after(() => window.close());
    const { document } = window;
    const key = (k, extra = {}, { target = document.activeElement ?? document.body, type = 'keydown' } = {}) => {
        const event = new window.KeyboardEvent(type, { key: k, code: extra.code ?? '', bubbles: true, cancelable: true, composed: true, ...extra });
        target.dispatchEvent(event);
        return event;
    };
    const tap = (k, extra = {}, options = {}) => {
        const down = key(k, extra, options);
        key(k, extra, { ...options, type: 'keyup' });
        return down;
    };
    const click = el => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    return { window, document, canvas: document.getElementById('c'), key, tap, click, q: s => document.querySelector(s), all: s => [...document.querySelectorAll(s)] };
}

// ================================================================= initials entry

function pad({ buttons = [], axes = [0, 0] } = {}) {
    const list = Array.from({ length: 17 }, () => ({ pressed: false }));
    for (const b of buttons) list[b] = { pressed: true };
    return { connected: true, buttons: list, axes };
}
const DPAD = { up: 12, down: 13, left: 14, right: 15, a: 0, b: 1, start: 9 };

function entryFixture(t, { start } = {}) {
    const p = page(t);
    let clock = 10_000;
    let pads = [];
    const played = [];
    const submitted = [];
    const opened = [];
    const entry = new InitialsEntry({
        document: p.document, returnFocus: p.canvas, startInitials: start,
        play: cue => played.push(cue), onSubmit: text => submitted.push(text), onOpenChange: open => opened.push(open),
        getGamepads: () => pads, now: () => clock,
    });
    t.after(() => entry.destroy());
    p.canvas.focus();
    const open = (request = { score: 12345, rank: 3, isRecord: false }) => {
        entry.open(request);
        return entry;
    };
    return {
        ...p, entry, open, played, submitted, opened,
        wait: ms => { clock += ms; },
        afterGrace: () => { clock += CONFIRM_GRACE_MS + 50; },
        setPads: next => { pads = next; },
        slots: () => p.all('.hs-slot').map(i => i.value),
        active: () => p.all('.hs-slot').findIndex(i => i.hasAttribute('data-active')),
        button: (role, slot) => p.q(`[data-role="${role}"]${slot === undefined ? '' : `[data-slot="${slot}"]`}`),
        poll: () => entry.pollGamepads(clock),
    };
}

test('the initials screen is built hidden, as a labelled modal dialog with three single-character text slots', t => {
    const f = entryFixture(t);
    assert.equal(f.q('.hs-backdrop').hidden, true);
    assert.equal(f.entry.isOpen, false);
    const dialog = f.q('[role="dialog"]');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.equal(f.q(`#${dialog.getAttribute('aria-labelledby')}`).textContent, 'NEW HIGH SCORE!');
    const slots = f.all('input.hs-slot');
    assert.equal(slots.length, 3);
    for (const [i, slot] of slots.entries()) {
        assert.equal(slot.type, 'text', 'a text input, so the page\'s M / O / H shortcuts stand down while typing');
        assert.equal(slot.maxLength, 1);
        assert.equal(slot.getAttribute('aria-label'), `Initial ${i + 1} of 3`);
        assert.equal(slot.getAttribute('autocomplete'), 'off');
    }
    assert.deepEqual(f.slots(), ['A', 'A', 'A']);
    assert.ok(f.q('.hs-live'), 'screen readers hear the changes');
});

test('opening shows the screen, names the score and rank, focuses the first slot and starts on AAA', t => {
    const f = entryFixture(t);
    f.open({ score: 12345, rank: 3, isRecord: false });
    assert.equal(f.entry.isOpen, true);
    assert.equal(f.q('.hs-backdrop').hidden, false);
    assert.equal(f.q('.hs-title').textContent, 'NEW HIGH SCORE!');
    assert.equal(f.q('.hs-subtitle').textContent, 'SCORE 12,345  \u00b7  RANK #3');
    assert.equal(f.q('.hs-dialog').getAttribute('data-tier'), 'score');
    assert.equal(f.document.activeElement, f.all('.hs-slot')[0]);
    assert.equal(f.entry.initials, 'AAA');
    assert.equal(f.entry.slot, 0);
    assert.deepEqual(f.opened, [true]);
});

test('beating the all-time record changes the heading and the tier', t => {
    const f = entryFixture(t);
    f.open({ score: 99999, rank: 1, isRecord: true });
    assert.equal(f.q('.hs-title').textContent, '\u2605 NEW ALL-TIME RECORD! \u2605');
    assert.equal(f.q('.hs-dialog').getAttribute('data-tier'), 'record');
    assert.equal(f.q('.hs-subtitle').textContent, 'SCORE 99,999  \u00b7  RANK #1');
    f.entry.close();
    f.open({ score: 5, rank: 9, isRecord: false });
    assert.equal(f.q('.hs-dialog').getAttribute('data-tier'), 'score', 'and back again');
});

test('TYPING: a letter fills the slot and moves to the next; lower case is fine; A and D type, they do not steer', t => {
    const f = entryFixture(t);
    f.open();
    f.tap('d');
    assert.deepEqual([f.slots(), f.active()], [['D', 'A', 'A'], 1]);
    f.tap('a');
    assert.deepEqual([f.slots(), f.active()], [['D', 'A', 'A'], 2], 'typing A put an A in slot 2 and moved on');
    f.tap('Z');
    assert.deepEqual(f.slots(), ['D', 'A', 'Z']);
    assert.equal(f.active(), 2, 'the last slot stays selected: typing three letters does not save');
    assert.deepEqual(f.submitted, []);
    assert.equal(f.entry.isOpen, true);
});

test('TYPING: digits, dot and dash are allowed; anything else is refused and does not move', t => {
    const f = entryFixture(t);
    f.open();
    f.tap('7');
    f.tap('.');
    f.tap('-');
    assert.deepEqual(f.slots(), ['7', '.', '-']);
    f.entry.selectSlot(0);
    for (const bad of ['!', '@', '#', '*', '?', '\u00e9', '\u00df']) f.tap(bad);
    assert.deepEqual([f.slots(), f.active()], [['7', '.', '-'], 0], 'junk is ignored');
    assert.equal(f.entry.typeChar('!'), false);
    assert.equal(f.entry.typeChar('q'), true);
});

test('ARROWS: Up and Down cycle the letter through the whole alphabet, wrapping at both ends', t => {
    const f = entryFixture(t);
    f.open();
    f.tap('ArrowUp');
    assert.equal(f.slots()[0], 'B');
    f.tap('ArrowDown');
    f.tap('ArrowDown');
    assert.equal(f.slots()[0], '-', 'A, then down wraps round to the last character');
    f.tap('ArrowUp');
    assert.equal(f.slots()[0], 'A', 'and up wraps to the first');
    f.entry.setInitials('Z..');
    f.tap('ArrowUp');
    assert.equal(f.slots()[0], '0', 'Z is followed by 0');
    f.tap('ArrowDown');
    assert.equal(f.slots()[0], 'Z');
    const seen = new Set();
    for (let i = 0; i < 38; i++) {
        seen.add(f.slots()[0]);
        f.tap('ArrowUp');
    }
    assert.equal(seen.size, 38, 'every one of the 38 characters is reachable');
    assert.equal(f.slots()[0], 'Z', 'and a full lap comes back to where it began');
});

test('ARROWS: Left and Right move between slots and stop at the ends', t => {
    const f = entryFixture(t);
    f.open();
    f.tap('ArrowLeft');
    assert.equal(f.active(), 0);
    f.tap('ArrowRight');
    f.tap('ArrowRight');
    f.tap('ArrowRight');
    assert.equal(f.active(), 2);
    f.tap('ArrowLeft');
    assert.equal(f.active(), 1);
    f.tap('ArrowUp');
    assert.deepEqual(f.slots(), ['A', 'B', 'A'], 'the letter changed is the one that is selected');
});

test('BACKSPACE: steps back one slot, ready to overwrite, and stops at the first', t => {
    const f = entryFixture(t);
    f.open();
    f.tap('x');
    f.tap('y');
    assert.equal(f.active(), 2);
    f.tap('Backspace');
    assert.equal(f.active(), 1);
    f.tap('q');
    assert.deepEqual(f.slots(), ['X', 'Q', 'A'], 'the slot was overwritten');
    f.tap('Backspace');
    f.tap('Backspace');
    f.tap('Backspace');
    assert.equal(f.active(), 0);
    assert.equal(f.entry.isOpen, true, 'Backspace never closes or saves');
});

test('CONFIRM: Enter or Space confirms a slot, and confirming the third saves, closes and returns focus to the game', t => {
    const f = entryFixture(t);
    f.open();
    f.entry.setInitials('ZED');
    f.afterGrace();
    f.tap('Enter');
    assert.equal(f.active(), 1);
    f.tap(' ');
    assert.equal(f.active(), 2);
    assert.deepEqual(f.submitted, [], 'not saved until the third is confirmed');
    f.tap('Enter');
    assert.deepEqual(f.submitted, ['ZED']);
    assert.equal(f.entry.isOpen, false);
    assert.equal(f.q('.hs-backdrop').hidden, true);
    assert.equal(f.document.activeElement, f.canvas);
    assert.deepEqual(f.opened, [true, false]);
});

test('GRACE: a player who dies holding Fire cannot confirm or save by accident in the first moments', t => {
    const f = entryFixture(t);
    f.open();
    f.wait(CONFIRM_GRACE_MS - 50);
    const e = f.tap('Enter');
    f.tap(' ');
    assert.equal(e.defaultPrevented, true, 'the key is still swallowed');
    assert.equal(f.active(), 0, 'nothing was confirmed');
    f.wait(100);
    f.tap('Enter');
    assert.equal(f.active(), 1, 'a moment later it works');
    // The grace restarts every time the screen opens.
    f.entry.close();
    f.open();
    f.tap('Enter');
    assert.equal(f.active(), 0);
});

test('HELD KEYS: a key held down when the screen opens (auto-repeat) never types, cycles or confirms', t => {
    const f = entryFixture(t);
    f.open();
    f.afterGrace();
    for (const k of ['a', 'ArrowUp', 'ArrowRight', 'Enter', ' ', 'Backspace']) f.key(k, { repeat: true });
    assert.deepEqual([f.slots(), f.active(), f.submitted], [['A', 'A', 'A'], 0, []]);
});

test('HELD KEYS: an arrow pressed after the screen opened does auto-repeat, so the letter can be scrolled fast', t => {
    const f = entryFixture(t);
    f.open();
    f.key('ArrowUp');
    for (let i = 0; i < 5; i++) f.key('ArrowUp', { repeat: true });
    assert.equal(f.slots()[0], 'G', 'one press and five repeats: six steps from A');
    f.key('ArrowUp', {}, { type: 'keyup' });
    f.key('ArrowUp', { repeat: true });
    assert.equal(f.slots()[0], 'G', 'once released, a stray repeat does nothing');
    // A held letter does not type again and again.
    f.key('k');
    f.key('k', { repeat: true });
    f.key('k', { repeat: true });
    assert.deepEqual([f.slots(), f.active()], [['K', 'A', 'A'], 1], 'one K typed, and the repeats typed nothing more');
});

test('Escape does nothing: there is no way out of the screen but to enter something', t => {
    const f = entryFixture(t);
    f.open();
    const e = f.tap('Escape');
    assert.equal(e.defaultPrevented, true);
    assert.equal(f.entry.isOpen, true);
    assert.deepEqual(f.submitted, []);
});

test('shortcuts with Ctrl, Alt or Meta are left to the browser and never type', t => {
    const f = entryFixture(t);
    f.open();
    for (const mod of ['ctrlKey', 'altKey', 'metaKey']) {
        const e = f.tap('a', { [mod]: true });
        assert.equal(e.defaultPrevented, false, mod);
    }
    assert.equal(f.active(), 0);
});

test('typed keys are swallowed so the text field never also edits itself', t => {
    const f = entryFixture(t);
    f.open();
    assert.equal(f.key('q').defaultPrevented, true);
    assert.equal(f.key('ArrowUp').defaultPrevented, true);
    assert.equal(f.key('ArrowLeft').defaultPrevented, true);
    assert.equal(f.key('F5').defaultPrevented, false, 'F-keys and the like are left alone');
});

test('MOUSE: the triangles cycle a slot (selecting it), OK confirms a slot, DONE saves right away', t => {
    const f = entryFixture(t);
    f.open();
    f.click(f.button('up', 2));
    assert.deepEqual([f.slots(), f.active()], [['A', 'A', 'B'], 2], 'the triangle picks its slot as well');
    f.click(f.button('down', 0));
    assert.deepEqual([f.slots(), f.active()], [['-', 'A', 'B'], 0]);
    f.click(f.button('confirm'));
    assert.equal(f.active(), 1, 'OK moves on');
    f.click(f.button('done'));
    assert.deepEqual(f.submitted, ['-AB']);
    assert.equal(f.entry.isOpen, false);
    assert.ok(f.played.includes('score-saved'));
});

test('MOUSE: OK on the third slot saves, just like confirming it from the keyboard', t => {
    const f = entryFixture(t);
    f.open();
    f.entry.selectSlot(2);
    f.click(f.button('confirm'));
    assert.deepEqual(f.submitted, ['AAA']);
});

test('MOUSE: focusing or clicking a slot selects it', t => {
    const f = entryFixture(t);
    f.open();
    f.all('.hs-slot')[2].focus();
    assert.equal(f.active(), 2);
    f.tap('m');
    assert.deepEqual(f.slots(), ['A', 'A', 'M']);
});

test('ON-SCREEN KEYBOARDS: text arriving through the input event is taken, one character at a time', t => {
    const f = entryFixture(t);
    f.open();
    const slot = f.all('.hs-slot')[0];
    slot.value = 'q';
    slot.dispatchEvent(new f.window.Event('input', { bubbles: true }));
    assert.deepEqual([f.slots(), f.active()], [['Q', 'A', 'A'], 1]);
    const second = f.all('.hs-slot')[1];
    second.value = 'AB';
    second.dispatchEvent(new f.window.Event('input', { bubbles: true }));
    assert.equal(f.slots()[1], 'B', 'the newest character wins');
    const third = f.all('.hs-slot')[2];
    third.value = '!';
    third.dispatchEvent(new f.window.Event('input', { bubbles: true }));
    assert.equal(f.slots()[2], 'A', 'junk is refused and the old letter restored');
});

test('GAMEPAD: the D-pad moves and cycles, A confirms, B goes back, Start saves', t => {
    const f = entryFixture(t);
    f.open();
    f.afterGrace();
    f.setPads([pad()]);
    f.poll();
    f.setPads([pad({ buttons: [DPAD.up] })]);
    f.poll();
    assert.equal(f.slots()[0], 'B');
    f.setPads([pad()]);
    f.poll();
    f.setPads([pad({ buttons: [DPAD.right] })]);
    f.poll();
    assert.equal(f.active(), 1);
    f.setPads([pad()]);
    f.poll();
    f.setPads([pad({ buttons: [DPAD.down] })]);
    f.poll();
    assert.equal(f.slots()[1], '-');
    f.setPads([pad()]);
    f.poll();
    f.setPads([pad({ buttons: [DPAD.a] })]);
    f.poll();
    assert.equal(f.active(), 2, 'A confirms the slot');
    f.setPads([pad()]);
    f.poll();
    f.setPads([pad({ buttons: [DPAD.b] })]);
    f.poll();
    assert.equal(f.active(), 1, 'B goes back');
    f.setPads([pad()]);
    f.poll();
    f.setPads([pad({ buttons: [DPAD.start] })]);
    f.poll();
    assert.deepEqual(f.submitted, ['B-A'], 'Start saves what is there');
});

test('GAMEPAD: the left stick works like the D-pad, past a dead zone', t => {
    const f = entryFixture(t);
    f.open();
    f.afterGrace();
    f.setPads([pad({ axes: [0.3, -0.4] })]);
    f.poll();
    assert.deepEqual([f.active(), f.slots()[0]], [0, 'A'], 'a light touch does nothing');
    f.setPads([pad({ axes: [0.9, 0] })]);
    f.poll();
    assert.equal(f.active(), 1);
    f.setPads([pad({ axes: [0, -0.95] })]);
    f.poll();
    assert.equal(f.slots()[1], 'B', 'stick up is the next letter');
    f.setPads([pad({ axes: [0, 0.95] })]);
    f.poll();
    assert.equal(f.slots()[1], 'A', 'stick down is the previous');
    f.setPads([pad({ axes: [-0.9, 0] })]);
    f.poll();
    assert.equal(f.active(), 0);
});

test('GAMEPAD: holding a direction repeats it after a pause, then steadily; a button never repeats', t => {
    const f = entryFixture(t);
    f.open();
    f.afterGrace();
    f.setPads([pad({ buttons: [DPAD.up] })]);
    f.poll();
    assert.equal(f.slots()[0], 'B');
    f.wait(200);
    f.poll();
    assert.equal(f.slots()[0], 'B', 'still inside the first delay');
    f.wait(200);
    f.poll();
    assert.equal(f.slots()[0], 'C', 'then it repeats');
    f.wait(130);
    f.poll();
    f.wait(130);
    f.poll();
    assert.equal(f.slots()[0], 'E', 'and keeps going');
    f.setPads([pad({ buttons: [DPAD.a] })]);
    f.poll();
    assert.equal(f.active(), 1);
    f.wait(2000);
    f.poll();
    f.poll();
    assert.equal(f.active(), 1, 'a held A does not confirm again');
});

test('GAMEPAD: a button already held when the screen opens is ignored until it is let go', t => {
    const f = entryFixture(t);
    f.setPads([pad({ buttons: [DPAD.a, DPAD.up] })]);
    f.open();
    f.afterGrace();
    f.poll();
    f.wait(2000);
    f.poll();
    assert.deepEqual([f.active(), f.slots()[0]], [0, 'A'], 'the fire button held while dying does nothing');
    f.setPads([pad()]);
    f.poll();
    f.setPads([pad({ buttons: [DPAD.a] })]);
    f.poll();
    assert.equal(f.active(), 1, 'a fresh press does');
});

test('GAMEPAD: A and Start also wait out the grace period; disconnected or missing pads are harmless', t => {
    const f = entryFixture(t);
    f.open();
    f.setPads([pad({ buttons: [DPAD.a] })]);
    f.poll();
    assert.equal(f.active(), 0, 'inside the grace');
    f.setPads([pad()]);
    f.poll();
    f.setPads([pad({ buttons: [DPAD.start] })]);
    f.poll();
    assert.deepEqual(f.submitted, []);
    f.setPads([{ ...pad({ buttons: [DPAD.up] }), connected: false }, null]);
    assert.doesNotThrow(() => f.poll());
    f.entry.close();
    assert.doesNotThrow(() => f.entry.pollGamepads(), 'polling a closed screen does nothing');
});

test('the picker has an API too: set, move, cycle, type, back, confirm, save', t => {
    const f = entryFixture(t, { start: 'mnk' });
    assert.equal(f.entry.initials, 'MNK', 'a starting name is tidied');
    f.entry.setInitials('x');
    assert.equal(f.entry.initials, 'X..');
    f.entry.setInitials(undefined);
    assert.equal(f.entry.initials, '...');
    f.entry.selectSlot(99);
    assert.equal(f.entry.slot, 2);
    f.entry.selectSlot(-5);
    assert.equal(f.entry.slot, 0);
    f.entry.selectSlot(NaN);
    assert.equal(f.entry.slot, 0);
    f.entry.save();
    assert.deepEqual(f.submitted, [], 'saving a closed screen does nothing');
});

test('sounds: a tick for each letter cycled, a select for each letter typed or slot confirmed, a chime on saving', t => {
    const f = entryFixture(t);
    f.open();
    f.afterGrace();
    f.tap('ArrowUp');
    f.tap('ArrowDown');
    assert.deepEqual(f.played, ['menu-tick', 'menu-tick']);
    f.played.length = 0;
    f.tap('a');
    assert.deepEqual(f.played, ['menu-select']);
    f.played.length = 0;
    f.tap('Enter');
    assert.deepEqual(f.played, ['menu-select']);
    f.played.length = 0;
    f.tap('Enter');
    assert.deepEqual(f.played, ['score-saved']);
});

test('focus is kept inside the screen: Tab wraps, and focus pushed outside is pulled back', t => {
    const f = entryFixture(t);
    f.open();
    const focusables = f.all('.hs-dialog button, .hs-dialog input');
    focusables.at(-1).focus();
    f.key('Tab');
    assert.equal(f.document.activeElement, focusables[0], 'forwards past the last wraps to the first');
    focusables[0].focus();
    f.key('Tab', { shiftKey: true });
    assert.equal(f.document.activeElement, focusables.at(-1), 'backwards past the first wraps to the last');
    f.document.getElementById('other').focus();
    assert.ok(f.q('.hs-backdrop').contains(f.document.activeElement), 'an outside element cannot keep focus');
});

test('while it is open the page\'s own shortcuts (O, H) stand down for the typed letters', t => {
    const f = entryFixture(t);
    const board = new HighScoreBoard({ storage: new MemoryStorage() });
    const view = new LeaderboardView({ document: f.document, board, holdPause: () => () => {}, canOpen: () => !f.entry.isOpen });
    const options = fixtureOptions(f, { canOpen: () => !f.entry.isOpen });
    t.after(() => { view.destroy(); options.destroy(); });
    f.open();
    f.tap('h');
    f.tap('o');
    assert.equal(view.isOpen, false, 'typing H must not open the high scores');
    assert.equal(options.isOpen, false, 'typing O must not open the options');
    assert.deepEqual(f.slots().slice(0, 2), ['H', 'O'], 'they were typed instead');
    // Even from a button inside the screen, where the text-field rule alone would not help:
    f.document.querySelector('[data-role="up"]').focus();
    f.tap('h', { code: 'KeyH' });
    f.tap('o', { code: 'KeyO' });
    assert.equal(view.isOpen, false);
    assert.equal(options.isOpen, false);
});

test('destroying the screen removes it from the page and its listeners from the document', t => {
    const f = entryFixture(t);
    f.open();
    f.entry.destroy();
    assert.equal(f.q('.hs-backdrop'), null);
    assert.equal(f.entry.isOpen, false);
    assert.doesNotThrow(() => f.entry.open({ score: 1, rank: 1, isRecord: false }));
    assert.equal(f.q('.hs-backdrop'), null, 'a destroyed screen stays gone');
    f.entry.destroy();
});

// ================================================================= leaderboard view

function viewFixture(t, { canOpen, board = new HighScoreBoard({ storage: new MemoryStorage(), now: () => new Date(2026, 9, 23) }) } = {}) {
    const p = page(t);
    const holds = { active: 0, total: 0 };
    const opened = [];
    const view = new LeaderboardView({
        document: p.document, board, returnFocus: p.canvas, canOpen,
        holdPause: () => { holds.active++; holds.total++; let released = false; return () => { if (!released) { released = true; holds.active--; } }; },
        onOpenChange: open => opened.push(open),
    });
    t.after(() => view.destroy());
    p.canvas.focus();
    return { ...p, view, board, holds, opened, rows: () => p.all('.hs-row'), cells: row => [...row.children].map(c => c.textContent) };
}

test('the table is built hidden, with the six columns and ten rows', t => {
    const f = viewFixture(t);
    assert.equal(f.q('.hs-backdrop').hidden, true);
    assert.equal(f.q('[role="dialog"]').getAttribute('aria-modal'), 'true');
    assert.deepEqual(f.all('.hs-table th').map(h => h.textContent), ['RANK', 'NAME', 'SCORE', 'BRIDGES', 'MODE', 'DATE']);
    assert.equal(f.rows().length, 10);
    assert.match(f.q('.hs-title').textContent, /HIGH SCORES/);
});

test('the starting names ACE, MAX, RAI, DEX and PIL fill the table, the rest are placeholders', t => {
    const f = viewFixture(t);
    assert.deepEqual(f.cells(f.rows()[0]), ['1ST', 'ACE', '18,500', '10', 'CAMPAIGN', '2026-01-01']);
    assert.deepEqual(f.cells(f.rows()[1]), ['2ND', 'MAX', '14,200', '8', 'ENDLESS', '2026-01-01']);
    assert.deepEqual(f.rows().slice(0, 5).map(r => f.cells(r)[1]), ['ACE', 'MAX', 'RAI', 'DEX', 'PIL']);
    assert.deepEqual(f.cells(f.rows()[4]), ['5TH', 'PIL', '7,200', '4', 'CAMPAIGN', '2026-01-01']);
    for (const row of f.rows().slice(5)) {
        assert.ok(row.hasAttribute('data-empty'));
        assert.deepEqual(f.cells(row).slice(1), ['---', '---', '---', '---', '---']);
    }
});

test('ordinals read like an arcade table', () => {
    const expected = { 1: '1ST', 2: '2ND', 3: '3RD', 4: '4TH', 10: '10TH', 11: '11TH', 12: '12TH', 13: '13TH', 21: '21ST', 22: '22ND', 101: '101ST', 111: '111TH' };
    for (const [n, text] of Object.entries(expected)) assert.equal(ordinal(Number(n)), text, n);
    assert.deepEqual(MODE_LABEL, { campaign: 'CAMPAIGN', endless: 'ENDLESS' });
});

test('your latest score blinks: only that row is marked, with a visible marker, and it follows the table live', t => {
    const f = viewFixture(t);
    assert.equal(f.all('[data-latest]').length, 0, 'nothing is marked before a run has been saved');
    f.board.submit({ initials: 'ZED', score: 12000, bridgesCleared: 6, mode: 'endless' });
    const marked = f.all('tr[data-latest]');
    assert.equal(marked.length, 1);
    assert.equal(f.cells(marked[0])[1], 'ZED');
    assert.equal(marked[0].getAttribute('data-rank'), '3');
    assert.match(marked[0].querySelector('.hs-latest-mark').textContent, /NEW/);
    assert.equal(f.all('.hs-latest-mark').length, 1);
    f.board.submit({ initials: 'TOP', score: 99999, bridgesCleared: 9, mode: 'campaign' });
    assert.equal(f.all('tr[data-latest]').length, 1);
    assert.equal(f.cells(f.q('tr[data-latest]'))[1], 'TOP', 'the mark moved to the newest run');
    f.board.reset();
    assert.equal(f.all('tr[data-latest]').length, 0, 'a reset clears it');
    assert.deepEqual(f.rows().slice(0, 5).map(r => f.cells(r)[1]), ['ACE', 'MAX', 'RAI', 'DEX', 'PIL']);
});

test('opening holds the game paused and moves focus in; closing releases the hold and returns focus to the canvas', t => {
    const f = viewFixture(t);
    f.view.open();
    assert.equal(f.view.isOpen, true);
    assert.equal(f.holds.active, 1);
    assert.equal(f.q('.hs-backdrop').hidden, false);
    assert.equal(f.document.activeElement, f.q('.hs-dialog'));
    f.view.open();
    assert.equal(f.holds.total, 1, 'opening twice takes one hold');
    f.view.close();
    assert.equal(f.holds.active, 0);
    assert.equal(f.document.activeElement, f.canvas);
    assert.deepEqual(f.opened, [true, false]);
    f.view.close();
    assert.equal(f.holds.total, 1, 'closing a closed table does nothing');
});

test('H opens and closes the table; Esc, Done, the X and a click on the backdrop close it', t => {
    const f = viewFixture(t);
    f.tap('h', { code: 'KeyH' }, { target: f.canvas });
    assert.equal(f.view.isOpen, true, 'H opens');
    f.tap('h', { code: 'KeyH' });
    assert.equal(f.view.isOpen, false, 'H closes');
    f.view.open();
    f.tap('Escape', { code: 'Escape' });
    assert.equal(f.view.isOpen, false, 'Esc closes');
    for (const selector of ['.hs-board-footer [data-role="close"]', '.hs-board-header [data-role="close"]']) {
        f.view.open();
        f.click(f.q(selector));
        assert.equal(f.view.isOpen, false, selector);
    }
    f.view.open();
    const backdrop = f.q('.hs-backdrop');
    backdrop.dispatchEvent(new f.window.MouseEvent('mousedown', { bubbles: true }));
    f.click(backdrop);
    assert.equal(f.view.isOpen, false, 'a press and release on the backdrop closes');
    f.view.open();
    f.q('.hs-table').dispatchEvent(new f.window.MouseEvent('mousedown', { bubbles: true }));
    f.click(f.q('.hs-table'));
    assert.equal(f.view.isOpen, true, 'a click inside the table does not');
    backdrop.dispatchEvent(new f.window.MouseEvent('mousedown', { bubbles: true }));
    f.q('.hs-table').dispatchEvent(new f.window.MouseEvent('click', { bubbles: true }));
    assert.equal(f.view.isOpen, true, 'a drag that merely ends on the backdrop does not close either');
});

test('H is ignored while typing in a field, with a modifier, held down, or when another screen is up', t => {
    let allowed = true;
    const f = viewFixture(t, { canOpen: () => allowed });
    f.document.getElementById('seed').focus();
    f.tap('h', { code: 'KeyH' });
    assert.equal(f.view.isOpen, false, 'typing the letter H in the seed box');
    f.canvas.focus();
    for (const mod of ['ctrlKey', 'altKey', 'metaKey']) {
        f.tap('h', { code: 'KeyH', [mod]: true });
        assert.equal(f.view.isOpen, false, mod);
    }
    f.key('h', { code: 'KeyH', repeat: true });
    assert.equal(f.view.isOpen, false, 'a held key');
    allowed = false;
    f.tap('h', { code: 'KeyH' });
    assert.equal(f.view.isOpen, false, 'refused by canOpen');
    allowed = true;
    f.tap('h', { code: 'KeyH' });
    assert.equal(f.view.isOpen, true);
    allowed = false;
    f.tap('h', { code: 'KeyH' });
    assert.equal(f.view.isOpen, false, 'but H can always close it');
});

test('Tab stays inside the table', t => {
    const f = viewFixture(t);
    f.view.open();
    const buttons = f.all('.hs-dialog button');
    buttons.at(-1).focus();
    f.key('Tab', { code: 'Tab' });
    assert.equal(f.document.activeElement, buttons[0]);
    f.key('Tab', { code: 'Tab', shiftKey: true });
    assert.equal(f.document.activeElement, buttons.at(-1));
    f.document.getElementById('other').focus();
    assert.ok(f.q('.hs-backdrop').contains(f.document.activeElement));
});

test('names are shown as text, never as markup', t => {
    const hostile = {
        entries: [{ rank: 1, initials: '<img src=x onerror=alert(1)>', score: 5, bridgesCleared: 0, mode: 'campaign', date: '2026-01-01' }],
        latestRank: 1, subscribe: () => () => {},
    };
    const f = viewFixture(t, { board: hostile });
    assert.equal(f.q('.hs-table img'), null);
    assert.equal(f.q('.hs-name').textContent, '<img src=x onerror=alert(1)>');
});

test('destroying the table while it is open releases the pause and removes it', t => {
    const f = viewFixture(t);
    f.view.open();
    f.view.destroy();
    assert.equal(f.holds.active, 0);
    assert.equal(f.q('.hs-backdrop'), null);
    f.tap('h', { code: 'KeyH' });
    assert.equal(f.view.isOpen, false, 'a destroyed table no longer listens');
});

// ============================================== the options screen's high-score section

function stubs() {
    return {
        input: { keybinds: defaultKeybinds(), setBindings() {}, resetDefaultBindings() {}, listenNextInput: () => () => {}, onBindingsChange: () => () => {} },
        sound: {
            channels: { ...DEFAULT_AUDIO_CHANNELS }, setMasterVolume() {}, setMuted() {}, setSfxEnabled() {}, setDroneEnabled() {}, setWarningsEnabled() {},
            subscribe: () => () => {}, play: () => true,
        },
    };
}

function fixtureOptions(p, extra = {}) {
    return new OptionsModal({ document: p.document, ...stubs(), getMode: () => 'campaign', setMode() {}, holdPause: () => () => {}, returnFocus: p.canvas, ...extra });
}

function optionsFixture(t, extra = {}) {
    const p = page(t);
    const calls = [];
    const held = { active: 0 };
    const modal = new OptionsModal({
        document: p.document, ...stubs(), getMode: () => 'campaign', setMode() {}, returnFocus: p.canvas,
        holdPause: () => { held.active++; return () => { held.active--; }; },
        highScores: { show: () => calls.push('show'), reset: () => calls.push('reset') },
        ...extra,
    });
    t.after(() => modal.destroy());
    p.canvas.focus();
    return { ...p, modal, calls, held, button: role => p.q(`[data-role="${role}"]`), confirm: () => p.q('.options-confirm') };
}

test('the options screen has a HIGH SCORES section only when the host provides high scores', t => {
    const without = page(t);
    const plain = fixtureOptions(without);
    t.after(() => plain.destroy());
    assert.deepEqual(without.all('.options-section h3').map(h => h.textContent), ['CONTROLS', 'AUDIO', 'GAME MODE']);
    assert.equal(without.q('[data-role="show-scores"]'), null);
    const f = optionsFixture(t);
    assert.deepEqual(f.all('.options-section h3').map(h => h.textContent), ['CONTROLS', 'AUDIO', 'GAME MODE', 'HIGH SCORES']);
    assert.match(f.button('show-scores').textContent, /High Scores/);
    assert.match(f.button('reset-scores').textContent, /Reset Leaderboard/);
});

test('"View High Scores" closes the options screen first (giving back the pause), then shows the table', t => {
    const f = optionsFixture(t);
    f.modal.open();
    assert.equal(f.held.active, 1);
    f.click(f.button('show-scores'));
    assert.equal(f.modal.isOpen, false);
    assert.equal(f.held.active, 0, 'the hold was released before the table took its own');
    assert.deepEqual(f.calls, ['show']);
});

test('RESET needs confirming: the first click only asks, Cancel changes nothing, Yes resets once', t => {
    const f = optionsFixture(t);
    f.modal.open();
    assert.equal(f.confirm().hidden, true);
    f.click(f.button('reset-scores'));
    assert.equal(f.confirm().hidden, false, 'a question is shown');
    assert.deepEqual(f.calls, [], 'nothing erased yet');
    assert.equal(f.document.activeElement, f.button('cancel-reset-scores'), 'the safe answer has focus');
    f.click(f.button('cancel-reset-scores'));
    assert.equal(f.confirm().hidden, true);
    assert.deepEqual(f.calls, [], 'cancelling erased nothing');
    assert.match(f.q('#options-scores').parentElement.querySelector('.options-status').textContent, /Nothing was erased/);
    f.click(f.button('reset-scores'));
    f.click(f.button('confirm-reset-scores'));
    assert.deepEqual(f.calls, ['reset']);
    assert.equal(f.confirm().hidden, true, 'the question goes away');
    assert.match(f.q('#options-scores').parentElement.querySelector('.options-status').textContent, /reset/i);
    f.click(f.button('confirm-reset-scores'));
    assert.deepEqual(f.calls, ['reset'], 'with the question gone, a stray click on Yes does nothing');
});

test('a pending reset question does not linger: closing and reopening the options starts fresh', t => {
    const f = optionsFixture(t);
    f.modal.open();
    f.click(f.button('reset-scores'));
    assert.equal(f.confirm().hidden, false);
    f.modal.close();
    f.modal.open();
    assert.equal(f.confirm().hidden, true);
    assert.deepEqual(f.calls, []);
});

test('the O key respects canOpen, so it cannot pile the options on top of another screen', t => {
    let allowed = false;
    const f = optionsFixture(t, { canOpen: () => allowed });
    f.tap('o', { code: 'KeyO' }, { target: f.canvas });
    assert.equal(f.modal.isOpen, false);
    allowed = true;
    f.tap('o', { code: 'KeyO' }, { target: f.canvas });
    assert.equal(f.modal.isOpen, true);
    allowed = false;
    f.tap('o', { code: 'KeyO' });
    assert.equal(f.modal.isOpen, false, 'it can always be closed');
});

// ======================================================= H is the high-score key, so it cannot be a game control

test('H is reserved like M and O: it cannot be bound to an action, by the options screen or by code', () => {
    assert.equal(RESERVED_CODES.KeyH, 'high scores');
    const change = assignKey(defaultKeybinds(), 'fire', 'KeyH', 'add');
    assert.match(change.error, /reserved for high scores/);
    assert.deepEqual(change.config, defaultKeybinds(), 'a refused change changes nothing');
    const input = new InputManager({ storage: null });
    assert.throws(() => input.rebind('fire', ['KeyH']), /reserved for high scores/);
    assert.ok(!sanitizeKeybinds({ fire: ['KeyH', 'KeyF'] }).fire.includes('KeyH'), 'a stored binding to H is dropped on load');
    input.destroy();
});

// ===================================== the session lays out the river for the mode it is in

test('endless mode streams in the extra enemies and campaign never does, and switching modes swaps the layout', () => {
    const make = (mode, seed) => headlessGame({ seed, game: { mode, startY: 3200 * 12 + 100, depots: { chance: 0 }, enemies: {}, fuel: { capacity: 1e9, startLevel: 1e9 } } });
    const extras = g => [...g.session.enemies.keys()].filter(id => id % 4 === 2);
    // A handful of seeds: any single stretch of river may happen to hold no extra, but not all of them.
    const seeds = [1, 2, 3, 2026, 77, 9];
    const endlessSeeds = seeds.filter(seed => extras(make('endless', seed)).length > 0);
    assert.ok(endlessSeeds.length >= 3, `extras are streamed in at bridge 12 in endless (${endlessSeeds.length} of ${seeds.length} seeds)`);
    for (const seed of seeds) assert.equal(extras(make('campaign', seed)).length, 0, `seed ${seed}: never in campaign`);
    const seed = endlessSeeds[0];
    const campaign = make('campaign', seed);
    campaign.session.setMode('endless');
    campaign.engine.reset(seed);
    assert.ok(extras(campaign).length > 0, 'switching to endless gives the endless layout from the next run');
    const endless = make('endless', seed);
    endless.session.setMode('campaign');
    endless.engine.reset(seed);
    assert.equal(extras(endless).length, 0, 'and back again');
});

// =================================================== the engine: a screen closing must not act as a key press

function holdEngine() {
    const fireTicks = [];
    const sim = { reset: () => 0, step: ctx => { if (ctx.input.firePressed) fireTicks.push(ctx.tick); return { cameraY: ctx.cameraY + 1, scrollSpeed: 60, cameraTeleported: false }; } };
    let script = () => ({});
    let frame = 0;
    const engine = new Engine({ seed: 1, simulation: sim, input: { update: () => idle(script(frame++)) }, renderer: { setWorld() {}, render() {} } });
    return { engine, fireTicks, setScript: fn => { script = fn; frame = 0; }, run: n => { for (let i = 0; i < n; i++) engine.runFrame(DT); } };
}

test('closing a screen swallows the Fire press that closed it, but only that one frame\'s', () => {
    const e = holdEngine();
    e.run(2);
    const release = e.engine.holdPause();
    e.run(2);
    release();
    e.setScript(f => (f === 0 ? { firePressed: true, fire: true } : {}));
    e.run(3);
    assert.deepEqual(e.fireTicks, [], 'the Enter that closed the screen did not fire a missile (or restart the run)');
    e.setScript(f => (f === 0 ? { firePressed: true, fire: true } : {}));
    e.run(2);
    assert.equal(e.fireTicks.length, 1, 'the next press counts');
});

test('a Fire press with no screen involved is unaffected', () => {
    const e = holdEngine();
    e.setScript(f => (f === 1 ? { firePressed: true, fire: true } : {}));
    e.run(3);
    assert.equal(e.fireTicks.length, 1);
});

