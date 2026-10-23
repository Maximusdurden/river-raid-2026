// One-off verification helper (not part of the build): break a behaviour on purpose and confirm
// the tests that are meant to guard it notice. Each mutation is applied, built, tested and
// reverted, and the original file contents are restored even if something throws.
//   node scripts/mutation-check.mjs
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = file => readFileSync(resolve(root, file), 'utf8');
const write = (file, text) => writeFileSync(resolve(root, file), text);

const mutations = [
    ['right-click menu not swallowed while capturing', 'src/core/InputManager.ts', "if (code === 'Mouse2') this.swallowContextMenuUntil", 'if (false) this.swallowContextMenuUntil', 'tests/InputBindings.test.mjs'],
    ['window-mode UI clicks count as shots', 'src/core/InputManager.ts', 'if (!this.element && this.isInteractive(event.target)) return;', '', 'tests/InputBindings.test.mjs'],
    ['context menu always blocked', 'src/core/InputManager.ts', "if (!this.relevant.has('Mouse2')) return;", '', 'tests/InputBindings.test.mjs'],
    ['bindings not persisted', 'src/core/InputManager.ts', 'writeItem(this.storage, STORAGE_KEYS.keybinds, serializeKeybinds(this.bindings));', 'void writeItem; void serializeKeybinds;', 'tests/InputBindings.test.mjs'],
    ['captured key release not swallowed', 'src/core/InputManager.ts', 'if (this.swallowKeyUps.delete(event.code)) event.preventDefault();', '', 'tests/InputBindings.test.mjs'],
    ['warnings switch ignored by the scheduler', 'src/audio/SoundEngine.ts', 'if (this.lowFuel && this.warningsOn) {', 'if (this.lowFuel) {', 'tests/AudioChannels.test.mjs'],
    ['klaxon routed through the effects bus', 'src/audio/SoundEngine.ts', "gain.connect(spec.bus === 'warning' ? graph.warning : graph.sfx);", 'gain.connect(graph.sfx);', 'tests/AudioChannels.test.mjs'],
    ['drone bypasses its own bus', 'src/audio/SoundEngine.ts', 'engineGain.connect(drone);', 'engineGain.connect(compressor);', 'tests/AudioChannels.test.mjs'],
    ['sfx switch ignored by play()', 'src/audio/SoundEngine.ts', '|| !this.sfxOn || ctx.state', '|| ctx.state', 'tests/AudioChannels.test.mjs'],
    ['audio settings not persisted', 'src/audio/SoundEngine.ts', 'writeItem(this.storage, STORAGE_KEYS.audio, serializeAudioSettings(this.channels));', 'void writeItem; void serializeAudioSettings;', 'tests/AudioChannels.test.mjs'],
    ['endless mode still wins', 'src/game/GameSession.ts', "return this.mode === 'endless' ? 0 : this.settings.victoryBridges;", 'return this.settings.victoryBridges;', 'tests/GameMode.test.mjs'],
    ['pause key works under a hold', 'src/core/Engine.ts', 'if (input.pausePressed && this.pauseHolds.size === 0)', 'if (input.pausePressed)', 'tests/GameMode.test.mjs'],
    ['a hold is also cleared by the player\u2019s pause', 'src/core/Engine.ts', 'return this.userPaused || this.pauseHolds.size > 0;', 'return this.userPaused;', 'tests/GameMode.test.mjs'],
    ['options screen never releases the pause', 'src/ui/OptionsModal.ts', 'this.releasePause?.();', 'void this.releasePause;', 'tests/OptionsModal.test.mjs'],
    ['O hijacked while typing', 'src/ui/OptionsModal.ts', 'if (isTextEntry(event.target)) return;', 'void isTextEntry;', 'tests/OptionsModal.test.mjs'],
    // The first stopImmediatePropagation in the file belongs to the key-capture handler.
    ['capture does not consume the key press', 'src/core/InputManager.ts', 'event.stopImmediatePropagation();', 'void event;', 'tests/InputBindings.test.mjs'],
    ['focus is not returned when closing', 'src/ui/OptionsModal.ts', 'target?.focus();', 'void target;', 'tests/OptionsModal.test.mjs'],
    ['rebinding leaves keys held', 'src/core/InputManager.ts', '        this.refreshRelevant();\r\n        // A key', '        this.refreshRelevant();\r\n        return;\r\n        // A key', 'tests/InputBindings.test.mjs'],
    ["sfx re-enable plays no confirmation", 'src/ui/OptionsModal.ts', 'sound.setSfxEnabled(this.checks.sfx.checked);', 'void sound;', 'tests/OptionsModal.test.mjs'],
    ['rebind stealing never refused', 'src/core/InputManager.ts', 'if (remaining.length === 0) {', 'if (false) {', 'tests/InputBindings.test.mjs'],
    ['verifier lets absolute URLs through', 'scripts/build-pages.mjs', "if (clean.startsWith('/')) {", 'if (false) {', 'tests/Pages.test.mjs'],
    ['verifier ignores wrong capitalisation', 'scripts/build-pages.mjs', 'if (!existsExact(site, wanted)) {', 'if (!existsSync(join(site, wanted))) {', 'tests/Pages.test.mjs'],
];

const build = () => spawnSync(process.execPath, [resolve(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], { cwd: root, encoding: 'utf8' });
const test = file => {
    const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { cwd: root, encoding: 'utf8' });
    const fail = Number(/^# fail (\d+)/m.exec(run.stdout)?.[1] ?? NaN);
    return { fail, pass: Number(/^# pass (\d+)/m.exec(run.stdout)?.[1] ?? NaN) };
};

let survived = 0;
for (const [label, file, find, replace, tests] of mutations) {
    const original = read(file);
    if (!original.includes(find)) {
        console.log(`?? ${label}: pattern not found in ${file}`);
        survived++;
        continue;
    }
    try {
        write(file, original.replace(find, replace));
        const built = build();
        if (built.status !== 0) {
            console.log(`-- ${label}: does not compile (not a useful mutation)`);
            continue;
        }
        const { fail, pass } = test(tests);
        const killed = fail > 0;
        if (!killed) survived++;
        console.log(`${killed ? 'caught  ' : 'SURVIVED'} ${label}  (${fail} failing / ${pass} passing)`);
    } finally {
        write(file, original);
    }
}
build();
const final = test('tests/InputBindings.test.mjs');
console.log(`\n${mutations.length - survived}/${mutations.length} mutations caught. Restored: ${final.fail === 0 ? 'ok' : 'STILL FAILING'}`);
process.exitCode = survived === 0 ? 0 : 1;
