# River Raid (2026 Modern Kinetic Remake)

A modernized 3.5D kinetic remake of the classic 1982 Atari 2600 shoot-'em-up masterpiece by Carol Shaw, built using **Three.js**, **Web Audio API**, and **HTML5 Canvas**.

## Features
- **3.5D Kinetic Perspective**: Dynamic lighting, rolling jet banking physics, and atmospheric fog over procedural river canyons.
- **Unified Controls**: Full support for PC Keyboard (`WASD` / `Arrows` / `Space`) and Standard Gamepads (Xbox / PlayStation controllers).
- **Resource Pressure Gameplay**: Dynamic fuel burn rate linked directly to engine throttle, requiring strategic refuel passes over moored barges.
- **Audio Synthesis**: Real-time Web Audio API procedural engine drone, low-pass filter warnings at low fuel, laser cannons, and concussive explosions.

## Quick Start
1. Install dependencies:
   ```bash
   npm install
   ```
2. Start local dev server:
   ```bash
   npm start
   ```
3. Open `http://localhost:8080` in your browser.

## Phase 1: standalone unified input

`InputManager.ts` exports `InputManager`, `InputState`, and `InputManagerOptions`.
The existing game is unchanged; the new module can be adopted independently.

- Install dependencies with `npm install`. `npm start` builds the TypeScript before serving.
- Open `http://localhost:8080/input-demo.html` for the real-time canvas and state inspector.
- `npm run build` emits browser ES modules, source maps, and declarations into `dist/`.
- `npm run typecheck` checks strict TypeScript; `npm test` builds and runs the automated DOM/gamepad tests.

### Game-loop contract

Create `new InputManager({ deadzone: 0.15 })`, call `attach(canvas)`, then call
`update()` **once per frame**, including paused/menu frames. Share the returned
snapshot rather than polling separately in each game system. Use `fire` for
continuous firing with the game's cooldown, `firePressed` for a single press,
and `pausePressed` to toggle pause. Call `destroy()` when leaving the game.
The instance can be reattached; repeated attach/destroy calls are safe.

`attach(canvas)` makes an otherwise non-focusable canvas focusable and focuses it
on pointer-down. Input and scroll suppression apply only while it (or a non-editable
descendant) has focus. `attach()` / `attach(window)` opts into page-wide capture.
Editable controls and modified browser shortcuts are not captured. Blur, hidden
tabs, and focus changes clear held keys and pending edges. A controller still held
when focus returns is treated as a fresh press.

### Mapping and arbitration

| Action | Keyboard | Standard gamepad |
| --- | --- | --- |
| Horizontal | Left/Right, A/D | Left stick X, D-pad Left/Right |
| Boost / brake | Up/Down, W/S | Inverted left stick Y, D-pad Up/Down |
| Fire | Space, J | 0 (A/Cross), 5 (RB/R1), 7 (RT/R2) |
| Pause | Escape, P | 9 (Start/Options) |

Opposite digital directions cancel. D-pad input overrides its corresponding stick
axis. Each analog axis uses `sign(v) * (abs(v) - deadzone) / (1 - deadzone)` outside
the deadzone, clamped to [-1, 1]; diagonals are not radially normalized. A button is
held if `pressed` is true or its analog value exceeds 0.5.

Latest meaningful activity selects `activeDevice`. Held controls, key repeat, and
small stick jitter do not repeatedly steal ownership. `activityThreshold` (default
0.02 in normalized units) filters changes for arbitration, not actual movement.
Movement prefers the active device with fallback to the other if it is neutral;
fire/pause are OR-combined across devices **before** edge detection. Multiple
controllers are supported: the most recently active moving pad steers and actions
are combined. Simultaneous changes detected in one frame resolve to the gamepad
poll (then later array entries for multiple pads); the API cannot reveal the exact
physical ordering of input between polls. Metadata persists while idle.

Keyboard taps entirely between frames are queued for one frame, even if `fire`
is already false. Several taps within one frame coalesce to one boolean edge.
Gamepad taps can only be observed during polling. Disconnected pads are removed
without releasing keyboard controls. Unknown/non-standard gamepad mappings are
ignored; custom mappings need an explicit adapter rather than guessed indices.

Gamepad availability depends on the browser, secure context (HTTPS or localhost),
Permissions Policy, and a physical button press to expose the controller. Missing
or blocked Gamepad APIs degrade to keyboard-only input without throwing.

## Phase 2: canvas loop and procedural river

`demo.html` now runs the full game (Phase 3, below) on top of this layer. Phase 2 on its own is the
same engine **without a simulation attached**: `new Engine({ seed, input, renderer })` free-scrolls from the
throttle alone (<kbd>Up</kbd>/<kbd>W</kbd> boost, <kbd>Down</kbd>/<kbd>S</kbd> brake), with `RiverRenderer`
as the renderer. Open `http://localhost:8080/demo.html` (optionally `?seed=2026`);
<kbd>Esc</kbd>/<kbd>P</kbd> pauses. The page has a seed box (any number or any text), a Random button, a Guides toggle, and a
debug overlay (FPS, ticks/s, world Y, river width at the player line, section, distance to the next
bridge, speed, throttle, active seed). The seed is written to the URL, so a run can be shared and replayed.

| File | Role |
| --- | --- |
| `src/core/PRNG.ts` | `Mulberry32` stream PRNG, stateless hashing, smooth `valueNoise1D`, `parseSeed` |
| `src/world/RiverGenerator.ts` | Deterministic river slices, sections, bridges, spatial queries |
| `src/rendering/RiverRenderer.ts` | Canvas 2D drawing, interpolation, texture tiles, DPR-aware resizing |
| `src/core/Engine.ts` | Fixed-timestep loop, input to throttle, pause, tick hooks |
| `src/main.ts` | Demo wiring (seed box, overlay) |

### Determinism

The river is a **pure function of (seed, config)**: every slice is derived from hashes of the seed and its
world position, not from a running random stream. Slices can be generated in any order, pruned, and
regenerated, and always match. Changing `RiverConfig` or the generator's tuning constants changes the
rivers produced by existing seeds. Seed text that is an unsigned integer below 2^32 is used directly;
any other text is FNV-1a hashed (the overlay shows both).

### Pacing

World Y increases upstream; the camera moves toward +Y. A *stage* is `bridgeEverySections` (5) sections of
640 units. Each stage runs: calm strait, then a shuffled mix of canyon / split channel / chokepoint, then a
calm strait, then a **bridge** (a checkpoint every 3200 units, 48 units thick). The first two sections are
always wide training straits. Difficulty ramps over the first 12 stages (narrower canyons and straits).
Islands only exist in channel sections and taper away before the adjacent bridge approach.

Guarantees (enforced by tests): river width >= `minRiverWidth` (180) everywhere; each channel around an
island >= `minChannelWidth` (140); banks stay inside the world; no island within 640 units of a bridge.
Bank slope (dx per dy between slices) has a median of about 0.24, a 99th percentile near 1.0, and never
exceeds about 1.85, only inside late chokepoints. The player's lateral speed in Phase 3 should comfortably
exceed the scroll speed (up to 420 units/s) times that slope to hug a bank at full boost.

### Spatial queries (for Phase 3 collision)

```ts
const bounds = world.getBounds(worldY);   // RiverBounds: leftBankX, rightBankX, isLand(x, y)
world.isLand(x, y);                        // bank, island, or outside the world; bridges are NOT land
world.sample(y);                           // interpolated slice: banks, island, width, section kind
world.getChannels(y);                      // 1 channel, or 2 around an island
world.isBridge(y); world.findBridges(minY, maxY); world.nextBridgeY(y);
```

Queries interpolate linearly between slices, exactly as the renderer draws them, so collision and visuals
agree. `world.prune(y)` drops cached slices below `y` (the engine does this each frame); `getSlice()` is
always safe afterwards.

### Loop and interpolation

Each display frame the engine polls `InputManager` **once**, adds the clamped frame time (max 0.25 s) to an
accumulator, runs fixed 1/60 s ticks (at most 8 per frame, extra backlog is dropped), then renders once
with `alpha = accumulator / fixedDeltaTime`. The renderer blends the previous and current camera/time by
`alpha`, so 60, 144 or 240 Hz displays all scroll smoothly while the simulation stays identical.

- Throttle: `moveY` maps to scroll speed, 90 (brake) / 220 (cruise) / 420 (boost) units/s, analog-aware,
  with limited acceleration (360/s^2) and deceleration (480/s^2).
- `firePressed` is latched until a tick consumes it, so presses are never lost on zero-tick frames or
  repeated on multi-tick frames. Pause is handled by the engine and freezes ticks, not rendering.
- `engine.onTick(listener)` is the hook for Phase 3 systems; `engine.reset(seed)` restarts a run.
- The engine does not own the input or renderer; call `input.destroy()` / `renderer.destroy()` yourself.

### Rendering

Logical resolution is 960x720 (4:3), 1 world unit per logical pixel. The canvas backing store follows the
displayed size and `devicePixelRatio` (capped at 3840 px wide), and CSS letterboxes it, so lines and textures
stay crisp at any window size. Layers: textured land (anchored to the world), grass verge and beach,
gradient water with two counter-scrolling flow-line layers, shoreline shadow and foam, islands, bridges
(deck, rails, centre line, abutments, shadow), then a haze overlay. `renderer.options.showGuides` draws the
player line (also used by the overlay's river-width readout).

## Phase 3: jet, fuel, missiles and bridges

Play at `http://localhost:8080/demo.html` (optionally `?seed=13`). Steer <kbd>Left</kbd><kbd>Right</kbd> /
<kbd>A</kbd><kbd>D</kbd>, boost <kbd>Up</kbd>/<kbd>W</kbd>, brake <kbd>Down</kbd>/<kbd>S</kbd>, fire
<kbd>Space</kbd>/<kbd>J</kbd> (hold to auto-repeat), pause <kbd>Esc</kbd>/<kbd>P</kbd>; gamepad: stick or D-pad,
A / RB / RT to fire. After game over, press Fire to start again. The **Hitboxes** checkbox outlines every
collision box; **Debug** toggles the overlay. `window.__riverRaid` exposes `{ engine, session, sound }` in the console.

| File | Role |
| --- | --- |
| `src/entities/PlayerJet.ts` | Flight model and the ALIVE / REFUELING / EXPLODING / DEAD state machine |
| `src/entities/FuelDepot.ts` | Depot entity and the deterministic `DepotSpawner` |
| `src/entities/Projectile.ts`, `Bridge.ts` | Missile; destroyed-bridge registry and checkpoint |
| `src/systems/FuelSystem.ts` | Tank, burn curve, low-fuel flag, refuelling |
| `src/systems/WeaponSystem.ts` | Firing discipline, ballistics, range |
| `src/systems/CollisionSystem.ts` | Box overlap, land probing, swept missile tests (pure functions) |
| `src/rendering/Particles.ts` | Pooled particle system (explosions, sparks, afterburner trail) |
| `src/rendering/GameRenderer.ts` | Jet sprite, depots, tracers, particles, HUD, overlays |
| `src/game/GameSession.ts` | The rules; plugs into the engine as its `Simulation` |
| `src/core/Throttle.ts` | Throttle <-> speed model shared by engine, jet and fuel |

### Rules and numbers

- **Jet**: 28x20 hitbox, spawns at world Y 180 (screen Y 540 of 720, `playerLineOffset = 180`). Forward speed
  is the scroll speed: brake 90 / cruise 220 / boost 420, eased with 360/s^2 up and 480/s^2 down. Sideways: up
  to 380 units/s (reached in ~0.15 s, shed in ~0.12 s), roll up to +/-20 degrees following the real lateral
  velocity. The jet freezes when destroyed, so the scroll stops.
- **Fuel**: 100 units. Burn follows the jet's actual speed, linearly between brake 1.4, cruise 2.2 and boost
  4.5 units/s. Below 20 the low-fuel flag is raised. At 0 the engine dies, controls are ignored, speed bleeds
  off, and the jet detonates after 0.5 s (a depot reached during the glide saves it).
- **Depots**: 20x45, one slot every 520 units with 85% chance, jittered +/-140, none below Y 420, none within
  120 of a bridge. Placed in the middle 40% of a navigable channel (either side of an island) with the full
  hitbox verified clear of land. Layout is a pure function of the seed. Overlap refuels at 28 units/s on top of
  the burn and never damages. A missile destroys one (+80, explosion) and it stays destroyed for the run.
- **Missiles**: launch at (jet speed + 650) along the jet's centreline from its nose; 4 shots/s while fire is
  held, a fresh press fires immediately, and at most 2 are in flight (configurable). They end on a hit, on land,
  or fully beyond the top of the view.
- **Bridges**: decks span the whole width. Flying into an intact one destroys the jet. A missile destroys it
  (+500, chain of explosions); it stays down and becomes the checkpoint.
- **Lives and respawn**: 3 jets, spent when one starts exploding. After the 1 s explosion and a 0.8 s pause the
  next jet appears just past the checkpoint bridge (or at the start) with full fuel, no missiles in flight, and
  3 s of blinking shield. The shield blocks land/bridge crashes, not fuel deaths, and it does not extend: if it
  lapses while the jet is over land, the jet is destroyed. Out of jets is game over.

### Engine integration

`Engine` gained an optional `simulation` (`reset(world, playerLineOffset)` and `step(context)`). With one
attached, the simulation owns the camera: `GameSession` sets `camera = jet.y - playerLineOffset` each tick and
reports `cameraTeleported` on respawn so the renderer never interpolates across the jump. Per tick: jet flight,
camera, depot streaming, weapons, missile hits, jet vs terrain, jet vs depots, fuel, death/respawn, particles.
`firePressed` is latched until a tick consumes it (Phase 2 contract), so single presses survive high refresh rates.
`session.onEvent()` emits `fire`, `refuel-start/stop`, `low-fuel`, `fuel-empty`, `jet-destroyed`,
`depot-destroyed`, `bridge-destroyed`, `respawn` and `game-over` for audio and HUD flashes.

### Collision details

Land tests use `RiverGenerator.isLand`: a grid of probes (every 7 units across, on the top and bottom edges
and on every river-slice boundary in between). Bank edges are piecewise linear between slice boundaries, so the
bank test is exact; island interiors are sampled, so a hitbox can graze the very tip of a tapering island.
Missiles are swept over each tick's travel (they move ~18 units per tick, a deck is 48 thick), and the
earliest of bridge / depot / land wins.

### Is it flyable?

A test autopilot (`tests/helpers.mjs`) plans a corridor ahead, commits to one side of islands and leaves a
margin. The test suite flies 12 seeds at full boost with infinite fuel past 12,500 units (at least 3 bridges
shot down), and 6 seeds each at cruise and half boost on real fuel past 10,000 units. A one-off 160-run sweep
(40 seeds x boost / half-boost / cruise / brake) never hit terrain either. The 380 units/s lateral
speed does **not** let a player trace the steepest bank slopes at boost (that would need ~770); what makes the
river flyable is that the centre-line and the navigable corridor change far more gently than the bank edges, and
that islands start thin. Islands grow outward at up to ~0.9x the forward speed, so at boost the player must
pick a side early; the jet cannot dodge a growing island from the middle.

## Phase 4: enemy armada, progression and sound

Same page, same controls, plus **M** to mute (and a Mute button and volume slider; both settings are
remembered). Audio starts locked, as browsers require, and unlocks on your first click or key press; the HUD
speaker says `PRESS A KEY` until it does.

| File | Role |
| --- | --- |
| `src/entities/enemies/Enemy.ts` | Abstract base: lifecycle, swept hitbox, shared patrol/steering, `patrolBounds` |
| `Helicopter.ts`, `PatrolBoat.ts`, `FighterJet.ts` | The three enemy types |
| `src/systems/EnemySpawner.ts` | Deterministic, stage-scaled placement |
| `src/systems/ProgressionSystem.ts` | Point table, extra lives, kill counts, stage counter |
| `src/systems/CollisionSystem.ts` | Now also: jet vs enemy, missile vs enemy, enemy vs terrain |
| `src/audio/SoundEngine.ts` | Procedural Web Audio: drone, one-shots, refuel chime, klaxon, mute, unlock |
| `src/rendering/GameRenderer.ts` | Enemy sprites, tiered score popups, banners, audio icon, end screens |
| `src/rendering/Particles.ts` | Adds contrails, rotor blades, water spray and per-enemy wrecks |

### Enemies

| | Hitbox | Points | Behaviour |
| --- | --- | --- | --- |
| Helicopter | 24x18 | 60 | Sweeps its channel side to side at 80-140 units/s, braking smoothly and turning before a bank or island |
| Patrol boat | 36x14 | 30 | A *cruiser* patrols at 30-60 units/s; a *drifter* slides downriver at 20 units/s |
| Fighter | 20x22 | 100 | Waits just outside a bank; when the player is ~600 below it, accelerates to 320-460 units/s straight across the river and is discarded once it has cleared the far bank |

Helicopters and cruisers hold their place along the river and the player scrolls toward them. Turning points are
computed from the stopping distance (v^2 / 2a), so a patrol brakes to a halt just short of the bank rather than
bouncing off it; in a channel too narrow to stop in, the cruise speed is capped so it still can. Limits come from
`patrolBounds()`, which checks the hull against the bank or island on its top and bottom edges and on every
river-slice boundary between them (exact, because banks are piecewise linear between slices). Fighters fly, so
banks and islands do not stop them.

### Spawning

Each slot (every 280 units, jittered +/-70) is a pure function of `(seed, slot)`, exactly like the river and the
depots, so a run replays from its seed alone regardless of how the player flew. Stage is the number of bridges
below the position (`floor(y / 3200)`).

- **Density**: 50% of slots spawn something in stage 1, +10% per stage, capped at 90%. Measured over 40 seeds that
  is about 2.7 enemies in the first section, 5 by section 3 and 7-8 from section 5.
- **Stage 1-2**: patrol boats and slow helicopters (80-98 units/s) only, and no fighters until the third section.
- **From stage 3**: fighters (about 15%, rising to 30%), helicopters up to the full 140, and chokepoints and
  canyons get opposing helicopter *pairs*.
- **Islands**: each channel gets its own enemy; fighters never park beside an island.
- **Placement rules**: the whole hull is verified to be in open water with room to patrol; drifters need open water
  for their whole slide; nothing within 150 units of a bridge or overlapping a depot's Y band; nothing below Y 700.

### Collisions and rewards

- **Missile vs enemy**: swept over the enemy's whole path this tick (so a fighter cannot slip sideways past a
  missile). Kills score the table value, throw debris, play the hit sound and show a floating `+N`.
- **Jet vs enemy**: both are destroyed, the jet loses a life and **nothing is scored**. The next jet appears at the
  last cleared bridge with the usual 3 s shield.
- **Shield**: protects against enemies exactly as it does against land: the jet passes through them, and neither
  side is destroyed or scored.
- **Enemy vs terrain**: a swimmer or hoverer that touches land is pushed back in and turned around, or removed if
  there is no room; a fighter is removed when it leaves the river. Enemies shot down come back after a death
  (as in the arcade), while destroyed depots and bridges stay destroyed.
- **Scoring**: boat 30, helicopter 60, depot 80, fighter 100, bridge 500. An extra life every 10,000 points (up to
  99 jets); one big award that skips several thresholds pays all of them, and none is paid twice. Each bridge
  destroyed advances the section counter and shows a banner. **Destroying 10 bridges wins the run**
  (`victoryBridges`; set 0 for an endless river). Game over and victory show a stat card whose rows add up to the
  score.

### Sound

Everything is synthesised (no audio files): oscillators, filtered noise and gain envelopes, through a compressor
that also acts as a limiter.

- **Engine drone**: sawtooth plus an octave-down triangle through a resonant low-pass, with vibrato. Pitch 52 Hz
  at the brake, 88 at cruise, 196 at full boost, getting brighter and louder as it rises.
- **Missile**: a fast downward square-wave chirp with a noise click. **Hit**: a short high tick.
- **Explosions**: noise through a resonant low-pass sweeping bright to dark with an exponential decay. Enemies pop,
  depots and jets add a sub-bass boom, and bridges are a long, deep boom with a crackling tail.
- **Refuel chime**: a rising C-E-G-C arpeggio, then a rest, repeating while fuel flows in.
- **Low-fuel klaxon**: two alternating tones, twice, then a pause, below 20 units (it keeps sounding through the
  engine-out glide).
- **Bridge fanfare**: a rising IV-V-I chord cadence after the blast; victory plays a longer one.

The chime and klaxon are scheduled a short way ahead of the audio clock, so they stay in time even if a frame is
late. The drone only touches its audio parameters when the throttle actually changes. Sound pauses with the game.

### Hooks and data

`session.onEvent()` adds `enemy-destroyed` (with `rammed`), `fighter-launch`, `extra-life`, `stage-clear` and
`victory` to the Phase 3 list; `engine.onFrame()` fires every rendered frame, paused or not (that is what drives
audio). The Phase 3 `depotScore` / `bridgeScore` options are replaced by one table:
`new GameSession({ points: { bridge: 750 }, bonusLifeEvery: 5000, victoryBridges: 5 })`.

### Verified

- 396 automated tests (headless, no browser needed): enemy movement bounds, spawner determinism and validity over
  30 seeds, score and extra-life thresholds, the full collision matrix, the sound engine against a fake
  `AudioContext`, and whole-game invariants (score always equals the points paid out; lives always equal start
  minus deaths plus extra lives; every run replays exactly).
- In a real browser: the audio graph was driven through an analyser. All 12 cues are audible, the drone gets
  louder and brighter with throttle, mute gives true silence, and nothing clips even at 100% volume with a bridge
  blast, fanfare and kills stacked. Sprites were inspected at 6x.
- **Not verified**: how the mix sounds on real speakers or headphones (levels were measured, not listened to), and
  physical gamepads.

Build and test: `npm test` (all phases, including the headless game and renderer smoke tests).

Tuning knobs worth knowing: `GameOptions` (`startLives`, `points`, `bonusLifeEvery`, `victoryBridges`,
`respawnDelay`, `jet`, `fuel`, `weapon`, `depots`, `enemies`), e.g.
`new GameSession({ weapon: { maxActiveProjectiles: 3 }, jet: { invulnerableSeconds: 5 }, enemies: { baseChance: 0.8 } })`.

## Phase 5: options, rebinding, audio channels, endless mode, GitHub Pages

Press **O** or click **⚙ Options** to open the settings screen. The game pauses while it is open; **Esc** or **O**
closes it and focus returns to the canvas. **O** is ignored while you are typing in a text box or waiting for a
rebind. Everything below is remembered in `localStorage`; unreadable or blocked storage falls back to defaults.

### Controls and mouse

`InputManager` moved to `src/core/InputManager.ts` (the root `InputManager.ts` re-exports it, so Phase 1 code still
works). Mouse buttons are ordinary input codes: `Mouse0` (left), `Mouse1` (middle), `Mouse2` (right).

| Action | Default inputs |
| --- | --- |
| `moveLeft` | Left Arrow, A |
| `moveRight` | Right Arrow, D |
| `accelerate` | Up Arrow, W |
| `brake` | Down Arrow, S |
| `fire` | Space, J, **Left Click**, Enter |
| `pause` | Esc, P |

```ts
input.rebind('fire', ['Mouse2', 'KeyF']);     // replaces; throws RangeError for a bad, reserved, empty or oversized list
input.resetDefaultBindings();
const cancel = input.listenNextInput(code => { /* the next key or mouse press, consumed */ });
```

- Stored as JSON in `riverraid.keybinds`. Bad, partial or corrupt data is repaired per action, never fatal.
- `M` (mute) and `O` (options) are reserved. Assigning a key that another action uses moves it, and the screen says so.
  Every action must keep at least one input. Each action holds at most 6.
- `listenNextInput` swallows the press *and* its follow-up `keyup`, `click` and `contextmenu`, so a rebind never
  also fires a shot or pauses the game. The right button only suppresses the browser context menu while `Mouse2`
  is actually bound, and clicks on buttons, links and the dialog are never shots.
- Gamepad buttons are fixed.

### Audio channels

`sfx`, `drone` and `warning` each have their own gain bus into one shared limiter, then the master volume:
`buses → compressor (limiter) → master → speakers`. `setSfxEnabled`, `setDroneEnabled` and `setWarningsEnabled`
take effect immediately (a 15 ms fade, so there is no click) and a disabled channel is also never scheduled.
`AudioChannelConfig { masterVolume, muted, sfxEnabled, droneEnabled, warningsEnabled }` is stored in
`riverraid.audio_settings`; the Phase 4 `riverraid.volume` / `riverraid.muted` keys are migrated on first load.

### Campaign and endless

`GameSession` takes `mode: 'campaign' | 'endless'` (default campaign), stored in `riverraid.game_mode`.
Campaign ends in victory after `victoryBridges` (10). In endless there is **no victory**: each bridge still pays
500 and sets a checkpoint, and the river carries on. The HUD reads `SECTION 3 / 10` or `SECTION 12 · ENDLESS`.
Changing mode applies at once and does not restart the run.

### Pausing from a menu

`engine.holdPause()` returns a release function. Holds stack, and the player's own pause (Esc / P) is separate:
a hold neither cancels it nor is lost behind it, and the pause key does nothing while a hold is active. The frame
right after the last release ignores a pause press, because Esc both closes the screen and is the pause key, and
without that the game stayed frozen after closing the screen with Esc (found in a real browser, now covered by
tests that wire in the real `InputManager`).

### Packaging for GitHub Pages

- Every URL is relative (`./styles.css`, `./dist/src/main.js`), so the game works at `user.github.io/repo/` as well
  as at `localhost:8080/`.
- `demo.html` is the game page. `npm run build` compiles TypeScript **and copies `demo.html` to `index.html`**
  (generated, git-ignored). The old prototype `index.html` was kept as `legacy.html`.
- `npm run build:pages` assembles `_site/` (the pages, `styles.css`, only `dist/**/*.js`, `.nojekyll`) and then
  **verifies** it: no root-absolute URLs, no bare imports, no missing files, and exact letter case (Pages is
  case-sensitive and Windows is not).
- `.github/workflows/deploy.yml`: checkout, `npm ci`, typecheck, test, build, `build:pages`, then
  `actions/deploy-pages@v4`. One-time setup: **Settings → Pages → Source: GitHub Actions**.
  If this project lives in a sub-folder of the repository, the workflow must sit at the repository root and the
  commented `working-directory`, `cache-dependency-path` and artifact `path` lines need enabling.

### Verified

- 592 automated tests, including: rebind serialization and mouse normalization (`Mouse0` → fire), channel
  filtering, endless play past bridge 10, the modal's focus handling and rebinding flows (in jsdom), and the
  page and site checks.
- `scripts/mutation-check.mjs` deliberately breaks 22 behaviours one at a time (for example "capture does not
  consume the key press" or "rebinding leaves keys held") and confirms a test fails for each: 22 of 22 caught.
- In a real browser, served under a sub-path: a real held left click fires at the 2-missile cap and stops on
  release; a real right click rebinds Fire to `Mouse2`; audio switches, volume and endless mode survive a reload;
  opening the screen freezes the world and Esc and O resume it (the Done button was checked in jsdom only);
  P and Esc still pause and unpause; a corrupt keybinds entry falls back to defaults; all 28 requests stayed
  inside the sub-path with none failing.
- **Not verified**: the GitHub Actions workflow itself has never run (only parsed), how the audio sounds on real
  speakers, or physical gamepads.
