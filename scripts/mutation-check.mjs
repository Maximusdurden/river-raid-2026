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

// Phase 5 (options, rebinding, audio channels, endless mode, packaging). Run with no flag.
const phase5 = [
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
    ['pause key works under a hold', 'src/core/Engine.ts', 'if (input.pausePressed && this.pauseHolds.size === 0 && !swallow)', 'if (input.pausePressed && !swallow)', 'tests/GameMode.test.mjs'],
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

// Phase 6 (endless difficulty, high scores, initials entry, production defaults). Run with --phase6.
const phase6 = [
    ['jet sideways speed not scaled with forward speed', 'src/entities/PlayerJet.ts', 'maxLateralSpeed: base.maxLateralSpeed * k,', 'maxLateralSpeed: base.maxLateralSpeed,', 'tests/Difficulty.test.mjs'],
    ['jet sideways acceleration not scaled', 'src/entities/PlayerJet.ts', 'lateralAcceleration: base.lateralAcceleration * k,', 'lateralAcceleration: base.lateralAcceleration,', 'tests/Difficulty.test.mjs'],
    ['speed grows in a straight line forever', 'src/systems/Difficulty.ts', 'if (n <= kneeStage) return 1 + growth * n;', 'return 1 + growth * n;', 'tests/Difficulty.test.mjs'],
    ['fuel burn scale not applied', 'src/systems/FuelSystem.ts', 'return base * this.burnMultiplier;', 'return base;', 'tests/Difficulty.test.mjs'],
    ['a destroyed bridge does not raise the difficulty', 'src/game/GameSession.ts', 'this.applyDifficulty(); // a bridge down is one stage harder (endless only)', '', 'tests/Difficulty.test.mjs'],
    ['campaign gets the endless layout', 'src/game/GameSession.ts', "const endless = this.mode === 'endless';\r\n        this.spawner?", 'const endless = true;\r\n        this.spawner?', 'tests/HighScoreUI.test.mjs'],
    ['no extra enemies between waves', 'src/systems/EnemySpawner.ts', 'return extra ? [...regular, extra] : regular;', 'return extra ? regular : regular;', 'tests/Difficulty.test.mjs'],
    ['helicopters not sped up', 'src/systems/EnemySpawner.ts', 'normal * (this.curve ? this.curve(stage).helicopterSpeedScale : 1)', 'normal * 1', 'tests/Difficulty.test.mjs'],
    ['fighter trigger stays at 600', 'src/systems/EnemySpawner.ts', '(profile?.fighterTrigger ?? FIGHTER_TRIGGER_DISTANCE) - 60', 'FIGHTER_TRIGGER_DISTANCE - 60', 'tests/Difficulty.test.mjs'],
    ['depots are not thinned', 'src/entities/FuelDepot.ts', 'if (roll(0) >= c.chance * scale) return null;', 'if (roll(0) >= c.chance * (scale > 2 ? 0 : 1)) return null;', 'tests/Difficulty.test.mjs'],
    ['a tie ranks above the older score', 'src/systems/HighScoreSystem.ts', 'let index = entries.findIndex(entry => entry.score < whole);', 'let index = entries.findIndex(entry => entry.score <= whole);', 'tests/HighScores.test.mjs'],
    ['a tie with the record counts as beating it', 'src/systems/HighScoreSystem.ts', 'Math.floor(score) > top.score', 'Math.floor(score) >= top.score', 'tests/HighScores.test.mjs'],
    ['the table is not pruned to ten', 'src/systems/HighScoreSystem.ts', '.slice(0, MAX_HIGH_SCORES)', '.slice(0, MAX_HIGH_SCORES + 5)', 'tests/HighScores.test.mjs'],
    ['a score of zero qualifies', 'src/systems/HighScoreSystem.ts', 'if (whole <= 0) return null;', 'if (whole < 0) return null;', 'tests/HighScores.test.mjs'],
    ['the table is not saved after a submission', 'src/systems/HighScoreSystem.ts', 'writeItem(this.storage, STORAGE_KEYS.highScores, serializeHighScores(this.table));', 'void writeItem; void serializeHighScores;', 'tests/HighScores.test.mjs'],
    ['held keys type into the initials', 'src/ui/InitialsEntry.ts', 'if (arrow && this.heldKeys.has(key))', 'if (arrow || !arrow || this.heldKeys.has(key))', 'tests/HighScoreUI.test.mjs'],
    ['confirm keys ignore the grace period', 'src/ui/InitialsEntry.ts', 'if (this.now() - this.openedAt >= CONFIRM_GRACE_MS) this.confirmSlot();', 'this.confirmSlot();', 'tests/HighScoreUI.test.mjs'],
    ['a pad button held at the start acts at once', 'src/ui/InitialsEntry.ts', 'for (const action of this.readPadActions()) this.padState.set(action, Infinity);', 'void this.readPadActions;', 'tests/HighScoreUI.test.mjs'],
    ['saving the initials does not tell the game', 'src/ui/InitialsEntry.ts', 'this.opts.onSubmit(initials);', 'void initials;', 'tests/HighScoreUI.test.mjs'],
    ['Ctrl+letter types into the initials', 'src/ui/InitialsEntry.ts', 'if (!this.isShown || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;', 'if (!this.isShown || event.isComposing) return;', 'tests/HighScoreUI.test.mjs'],
    ['H opens the table while typing in a field', 'src/ui/LeaderboardView.ts', 'if (isTextEntry(event.target)) return;', 'void isTextEntry;', 'tests/HighScoreUI.test.mjs'],
    ['the table never releases the pause', 'src/ui/LeaderboardView.ts', 'this.releasePause?.();', 'void this.releasePause;', 'tests/HighScoreUI.test.mjs'],
    ['the latest run is not marked', 'src/ui/LeaderboardView.ts', "if (isLatest) row.setAttribute('data-latest', '');", '', 'tests/HighScoreUI.test.mjs'],
    ['reset erases without asking', 'src/ui/OptionsModal.ts', 'this.showResetConfirm();', 'this.showResetConfirm(); this.opts.highScores?.reset();', 'tests/HighScoreUI.test.mjs'],
    ['closing a screen lets its Fire press through', 'src/core/Engine.ts', 'else if (input.firePressed && !swallow) this.pendingFire = true;', 'else if (input.firePressed) this.pendingFire = true;', 'tests/HighScoreUI.test.mjs'],
    ['closing with Esc pauses the game again', 'src/core/Engine.ts', 'if (input.pausePressed && this.pauseHolds.size === 0 && !swallow)', 'if (input.pausePressed && this.pauseHolds.size === 0)', 'tests/GameMode.test.mjs'],
    ['H can be bound to a game action', 'src/core/InputManager.ts', "KeyO: 'options', KeyH: 'high scores' }", "KeyO: 'options' }", 'tests/HighScoreUI.test.mjs'],
    ['the celebration is never drawn', 'src/rendering/GameRenderer.ts', 'if (this.celebration.active) this.drawCelebration(ctx);', 'if (this.celebration.active && !this.celebration.active) this.drawCelebration(ctx);', 'tests/HighScoreRendering.test.mjs'],
    ['the debug toggle starts ticked', 'demo.html', '<input id="debug-toggle" type="checkbox" autocomplete="off">', '<input id="debug-toggle" type="checkbox" checked autocomplete="off">', 'tests/Pages.test.mjs'],
    ['the hitboxes follow a leftover checkbox, not the flags', 'src/main.ts', 'showGuides: displayFlags.showHitboxes', 'showGuides: guidesToggle.checked', 'tests/HighScoreRendering.test.mjs'],
];

const mutations = process.argv.includes('--phase6') ? phase6 : phase5;

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
