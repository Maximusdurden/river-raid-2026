import type { Simulation, SimulationContext, SimulationResult } from '../core/Engine.js';
import { speedToThrottle } from '../core/Throttle.js';
import { BridgeRegistry } from '../entities/Bridge.js';
import { DEFAULT_GAME_MODE, isGameMode, type GameMode } from './GameMode.js';
import { DepotSpawner, FuelDepot, type DepotConfig } from '../entities/FuelDepot.js';
import type { Enemy, EnemyContext } from '../entities/enemies/Enemy.js';
import { FighterJet } from '../entities/enemies/FighterJet.js';
import { PlayerJet, type DeathCause, type PlayerJetConfig } from '../entities/PlayerJet.js';
import type { Projectile } from '../entities/Projectile.js';
import { ParticleSystem } from '../rendering/Particles.js';
import { CollisionSystem } from '../systems/CollisionSystem.js';
import {
    CAMPAIGN_DIFFICULTY,
    DEFAULT_DIFFICULTY,
    difficultyAt,
    validateDifficultyConfig,
    type DifficultyConfig,
    type DifficultyProfile,
} from '../systems/Difficulty.js';
import { EnemySpawner, type EnemySpawnConfig } from '../systems/EnemySpawner.js';
import { FuelSystem, type FuelConfig } from '../systems/FuelSystem.js';
import {
    ProgressionSystem,
    type AwardResult,
    type KillCounts,
    type PointTable,
    type ScoreSource,
} from '../systems/ProgressionSystem.js';
import { WeaponSystem, type WeaponConfig } from '../systems/WeaponSystem.js';
import type { BridgeSpan, RiverGenerator } from '../world/RiverGenerator.js';

export interface GameSettings {
    startLives: number;
    /** World Y where the first jet appears (and where it respawns before any bridge falls). */
    startY: number;
    /** An extra life is awarded each time the score passes a multiple of this (0 = never). */
    bonusLifeEvery: number;
    /** Most lives that can be held at once. */
    maxLives: number;
    /** Campaign: destroying this many bridges wins the run (0 = no victory, like endless). */
    victoryBridges: number;
    /** `campaign` (default) can be won; `endless` never ends in victory. Can be changed later with `setMode`. */
    mode: GameMode;
    /** Pause between the jet being DEAD and the next jet appearing. */
    respawnDelay: number;
    /** A respawned jet appears this far past the checkpoint bridge. */
    respawnMargin: number;
    viewHeight: number;
    particleCapacity: number;
}

export const DEFAULT_GAME_SETTINGS: Readonly<GameSettings> = {
    startLives: 3,
    startY: 180,
    bonusLifeEvery: 10000,
    maxLives: 99,
    victoryBridges: 10,
    mode: DEFAULT_GAME_MODE,
    respawnDelay: 0.8,
    respawnMargin: 80,
    viewHeight: 720,
    particleCapacity: 1400,
};

export interface GameOptions extends Partial<GameSettings> {
    jet?: Partial<PlayerJetConfig>;
    fuel?: Partial<FuelConfig>;
    weapon?: Partial<WeaponConfig>;
    depots?: Partial<DepotConfig>;
    enemies?: Partial<EnemySpawnConfig>;
    /** Tuning for endless mode's rising difficulty (see `systems/Difficulty.ts`). Has no effect in campaign. */
    difficulty?: Partial<DifficultyConfig>;
    /** Overrides for the point table (boat 30, helicopter 60, depot 80, fighter 100, bridge 500). */
    points?: Partial<PointTable>;
}

/** Discrete things that happened, for audio, HUD flashes and tests. */
export type GameEvent =
    | { readonly type: 'fire'; readonly projectile: Projectile }
    | { readonly type: 'refuel-start' }
    | { readonly type: 'refuel-stop' }
    | { readonly type: 'low-fuel' }
    | { readonly type: 'fuel-empty' }
    | { readonly type: 'jet-destroyed'; readonly cause: DeathCause; readonly x: number; readonly y: number; readonly livesLeft: number }
    | { readonly type: 'depot-destroyed'; readonly depot: FuelDepot; readonly points: number }
    | { readonly type: 'bridge-destroyed'; readonly bridge: BridgeSpan; readonly points: number }
    /** A missile (points > 0) or a collision (points = 0, `rammed`) destroyed an enemy. */
    | { readonly type: 'enemy-destroyed'; readonly enemy: Enemy; readonly points: number; readonly rammed: boolean }
    /** A parked fighter just took off. */
    | { readonly type: 'fighter-launch'; readonly enemy: FighterJet }
    | { readonly type: 'extra-life'; readonly lives: number; readonly score: number }
    /** A bridge fell: `cleared` sections are now behind the player. */
    | { readonly type: 'stage-clear'; readonly cleared: number }
    | { readonly type: 'respawn'; readonly x: number; readonly y: number }
    | { readonly type: 'game-over'; readonly score: number }
    | { readonly type: 'victory'; readonly score: number };

export type GameEventListener = (event: GameEvent) => void;

/** A floating "+500" that rises from where something was destroyed. */
export interface ScorePopup {
    readonly x: number;
    readonly y: number;
    readonly text: string;
    /** The value shown (0 for labels such as "1UP"). Used to colour the popup. */
    readonly points: number;
    age: number;
    readonly life: number;
}

/** A banner shown over the playfield for a moment (stage clear, extra life). */
export interface HudNotice {
    readonly kind: 'stage-clear' | 'extra-life';
    readonly title: string;
    readonly subtitle: string;
    age: number;
    readonly life: number;
}

/** Final numbers for the game-over and victory screens. */
export interface RunSummary {
    readonly mode: GameMode;
    readonly score: number;
    /** Section the player was in (1 at the start, +1 per bridge). */
    readonly section: number;
    readonly bridges: number;
    readonly kills: Readonly<KillCounts>;
    readonly bonusLives: number;
}

const DEPOT_SPAWN_BEHIND = 150;
const DEPOT_SPAWN_AHEAD = 300;
const DEPOT_CULL_BEHIND = 100;
const DEPOT_CULL_AHEAD = 400;
const ENEMY_SPAWN_BEHIND = 100;
const ENEMY_SPAWN_AHEAD = 360;
const ENEMY_CULL_BEHIND = 160;
const POPUP_LIFE = 1.2;
const NOTICE_LIFE = 2.6;

function scoreSourceFor(kind: Enemy['kind']): ScoreSource {
    switch (kind) {
        case 'helicopter': return 'helicopter';
        case 'patrol-boat': return 'patrolBoat';
        case 'fighter': return 'fighter';
    }
}

function safeSpawnX(world: RiverGenerator, y: number): number {
    let best: { leftX: number; rightX: number } | undefined;
    for (const channel of world.getChannels(y)) {
        if (!best || channel.rightX - channel.leftX > best.rightX - best.leftX) best = channel;
    }
    return best ? (best.leftX + best.rightX) / 2 : world.config.worldWidth / 2;
}

/**
 * The Phase 3 rules, plugged into the engine's fixed step as its `Simulation`.
 *
 * Tick order: jet flight -> camera follows jet -> depot and enemy streaming -> enemy
 * movement -> weapons -> missile hits -> jet vs terrain -> jet vs enemies -> jet vs
 * depots -> fuel -> death/respawn lifecycle -> particles. Everything advances in fixed
 * steps, so a run is fully determined by (seed, config, per-tick inputs).
 *
 * Scoring comes from `ProgressionSystem` (boat 30, helicopter 60, depot 80, fighter 100,
 * bridge 500; an extra life every 10,000). Lives: a jet is spent when it starts exploding;
 * when the last one is spent the run ends (`gameOver`). A new jet appears just past the
 * furthest destroyed bridge (the checkpoint), or at the start before any bridge falls,
 * with full fuel and respawn protection. Destroyed depots and bridges stay destroyed for
 * the rest of the run; enemies, like the arcade original, come back fresh at a respawn.
 *
 * A shielded jet (respawn protection) is ghosted against enemies exactly as it is against
 * land: nobody is destroyed and no points are scored. Ramming an enemy without a shield
 * destroys both and scores nothing.
 *
 * Game mode: in `campaign` destroying `victoryBridges` bridges wins the run. In `endless`
 * there is no victory at all: each bridge still scores 500 points, still raises the section
 * counter and still becomes the respawn checkpoint, and the run continues until the last jet
 * is lost. The mode can be changed at any time (`setMode`) and applies from then on; it is not
 * reset by a restart. Switching to campaign when the run already has `victoryBridges` or more
 * bridges down does not end it on the spot: the next bridge destroyed does.
 */
export class GameSession implements Simulation {
    readonly settings: Readonly<GameSettings>;
    readonly jet: PlayerJet;
    readonly fuel: FuelSystem;
    readonly weapon: WeaponSystem;
    readonly bridges = new BridgeRegistry();
    readonly particles: ParticleSystem;
    /** Depots currently streamed in (visible or about to be), keyed by id. */
    readonly depots = new Map<number, FuelDepot>();
    /** Enemies currently in play, keyed by placement id. */
    readonly enemies = new Map<number, Enemy>();
    readonly progression: ProgressionSystem;
    readonly popups: ScorePopup[] = [];
    readonly notices: HudNotice[] = [];

    /** The run ended with the last jet lost. */
    gameOver = false;
    /** The run ended by destroying `victoryBridges` bridges (campaign only). */
    victory = false;
    /** The current mode. Change it with `setMode`. */
    mode: GameMode;
    /** Seconds since the run ended (either way). */
    gameOverTime = 0;
    cameraY = 0;
    time = 0;

    private readonly depotConfig: Partial<DepotConfig>;
    private readonly enemyConfig: Partial<EnemySpawnConfig>;
    private readonly difficultyConfig: Readonly<DifficultyConfig>;
    private currentDifficulty: DifficultyProfile = CAMPAIGN_DIFFICULTY;
    private readonly destroyedDepots = new Set<number>();
    /** Placement ids already turned into enemies during the current life. */
    private readonly spawnedEnemies = new Set<number>();
    private readonly listeners = new Set<GameEventListener>();
    private world: RiverGenerator | null = null;
    private collision: CollisionSystem | null = null;
    private spawner: DepotSpawner | null = null;
    private enemySpawner: EnemySpawner | null = null;
    private playerLineOffset = 180;
    /** Set once the current jet's destruction has been processed (lives, effects, events). */
    private deathHandled = false;

    constructor(options: GameOptions = {}) {
        const { jet, fuel, weapon, depots, enemies, points, difficulty, ...scalars } = options;
        this.settings = { ...DEFAULT_GAME_SETTINGS, ...scalars };
        const s = this.settings;
        if (!Number.isInteger(s.startLives) || s.startLives < 1) {
            throw new RangeError('Invalid GameSettings: startLives must be an integer >= 1.');
        }
        if (!Number.isInteger(s.victoryBridges) || s.victoryBridges < 0) {
            throw new RangeError('Invalid GameSettings: victoryBridges must be an integer >= 0.');
        }
        if (!isGameMode(s.mode)) throw new RangeError(`Invalid GameSettings: mode must be 'campaign' or 'endless'.`);
        for (const [name, value] of Object.entries(s)) {
            if (typeof value === 'number' && !Number.isFinite(value)) throw new RangeError(`Invalid GameSettings: ${name} must be finite.`);
        }
        this.mode = s.mode;
        this.jet = new PlayerJet(jet);
        this.fuel = new FuelSystem(fuel);
        this.weapon = new WeaponSystem(weapon);
        this.depotConfig = depots ?? {};
        this.enemyConfig = enemies ?? {};
        this.difficultyConfig = { ...DEFAULT_DIFFICULTY, ...difficulty };
        validateDifficultyConfig(this.difficultyConfig);
        this.progression = new ProgressionSystem({
            startLives: s.startLives,
            bonusLifeEvery: s.bonusLifeEvery,
            maxLives: s.maxLives,
            ...(points ? { points } : {}),
        });
        this.particles = new ParticleSystem({ capacity: s.particleCapacity });
    }

    // ------------------------------------------------------------ read model

    get score(): number {
        return this.progression.score;
    }

    get lives(): number {
        return this.progression.lives;
    }

    /** Bridges destroyed so far (0 at the start); the section number is `stage + 1`. */
    get stage(): number {
        return this.progression.stage;
    }

    /**
     * Bridges that must fall to win the run: `victoryBridges` in campaign, 0 (never) in endless.
     * 0 means there is no victory.
     */
    get victoryGoal(): number {
        return this.mode === 'endless' ? 0 : this.settings.victoryBridges;
    }

    /**
     * How hard the game is right now. Campaign is always the plain game (every scale 1); in
     * endless it follows the number of bridges destroyed, see `systems/Difficulty.ts`.
     */
    get difficulty(): DifficultyProfile {
        return this.currentDifficulty;
    }

    /** Switches between campaign and endless, effective immediately. Throws on anything else. */
    setMode(mode: GameMode): void {
        if (!isGameMode(mode)) throw new RangeError(`Unknown game mode "${String(mode)}".`);
        this.mode = mode;
        this.installSpawnerDifficulty();
        this.applyDifficulty();
    }

    /** The run is over, by defeat or victory: the world is frozen. */
    get runEnded(): boolean {
        return this.gameOver || this.victory;
    }

    /** Numbers for the end-of-run screens. */
    get summary(): RunSummary {
        return {
            mode: this.mode,
            score: this.progression.score,
            section: this.progression.stageNumber,
            bridges: this.progression.stage,
            kills: this.progression.kills,
            bonusLives: this.progression.bonusLivesGranted,
        };
    }

    get isRefueling(): boolean {
        return this.fuel.isRefueling;
    }

    /** Subscribes to game events. Returns an unsubscribe function. */
    onEvent(listener: GameEventListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    // ------------------------------------------------------------ Simulation

    reset(world: RiverGenerator, playerLineOffset: number): number {
        if (world.config.worldWidth !== this.jet.config.worldWidth) {
            throw new RangeError(`Jet worldWidth (${this.jet.config.worldWidth}) must match the river (${world.config.worldWidth}).`);
        }
        this.world = world;
        this.collision = new CollisionSystem(world, this.bridges);
        this.spawner = new DepotSpawner(world, this.depotConfig);
        this.enemySpawner = new EnemySpawner(world, this.spawner, this.enemyConfig);
        this.playerLineOffset = playerLineOffset;

        this.bridges.reset();
        this.depots.clear();
        this.destroyedDepots.clear();
        this.enemies.clear();
        this.spawnedEnemies.clear();
        this.popups.length = 0;
        this.notices.length = 0;
        this.weapon.reset();
        this.fuel.reset();
        this.progression.reset();
        this.particles.clear();
        this.particles.reseed(world.seed ^ 0x5eed5eed);
        this.gameOver = false;
        this.victory = false;
        this.gameOverTime = 0;
        this.time = 0;

        // Stage 0 again: the jet, the fuel and the spawners all start from the plain game.
        this.installSpawnerDifficulty();
        this.applyDifficulty();
        const y = this.settings.startY;
        this.jet.spawn(safeSpawnX(world, y), y);
        this.deathHandled = false;
        this.cameraY = y - playerLineOffset;
        this.syncDepots();
        this.syncEnemies();
        return this.cameraY;
    }

    step(context: SimulationContext): SimulationResult {
        const world = this.world;
        const collision = this.collision;
        if (!world || !collision) throw new Error('GameSession.step() called before reset().');
        const dt = context.deltaTime;
        const input = context.input;
        this.time = context.time;
        this.playerLineOffset = context.playerLineOffset;
        this.updatePopups(dt);
        this.updateNotices(dt);

        if (this.runEnded) {
            this.gameOverTime += dt;
            this.particles.update(dt);
            return { cameraY: this.cameraY, scrollSpeed: 0, cameraTeleported: false };
        }

        // 1. Fly. Stalling can detonate the jet inside update().
        this.jet.update(dt, { moveX: input.moveX, moveY: input.moveY, enginePowered: !this.fuel.isEmpty });
        this.processDeath();

        // 2. The camera is tied to the jet: forward speed IS scroll speed.
        this.cameraY = this.jet.y - this.playerLineOffset;
        this.syncDepots();
        this.syncEnemies();

        // 3. Enemies move (and are kept in the water), so missiles meet them where they now are.
        this.updateEnemies(dt, world, collision);

        // 4. Weapons.
        const missile = this.weapon.update(dt, {
            firePressed: input.firePressed,
            fire: input.fire,
            canFire: this.jet.isFlying,
            originX: this.jet.x,
            originY: this.jet.y + this.jet.config.height / 2,
            forwardSpeed: this.jet.speed,
            cameraY: this.cameraY,
            viewHeight: this.settings.viewHeight,
        });
        if (missile) this.emit({ type: 'fire', projectile: missile });

        // 5. Missile hits (before the jet-vs-depot check so a depot shot this tick gives no fuel).
        this.resolveProjectiles(collision, world);
        if (this.victory) {
            this.particles.update(dt);
            return { cameraY: this.cameraY, scrollSpeed: 0, cameraTeleported: false };
        }

        // 6. Jet vs terrain, then enemies, then depots.
        let overlappingDepot: FuelDepot | null = null;
        if (this.jet.isFlying) {
            const crash = collision.checkJet(this.jet.hitbox);
            if (crash) this.jet.destroy(crash.cause);
            this.processDeath();
        }
        if (this.jet.isFlying) {
            // A shielded jet passes through enemies untouched (and so do they).
            const rammed = collision.findEnemyOverlap(this.jet.hitbox, this.enemies.values());
            if (rammed && this.jet.canBeDestroyedBy('enemy')) {
                this.destroyEnemy(rammed, true);
                this.jet.destroy('enemy');
                this.processDeath();
            }
        }
        if (this.jet.isFlying) overlappingDepot = collision.findDepotOverlap(this.jet.hitbox, this.depots.values());

        // 7. Fuel: burn follows the jet's real speed; a depot adds on top.
        if (this.jet.isFlying) {
            const update = this.fuel.update(dt, {
                throttle: speedToThrottle(this.jet.speed, this.jet.config),
                refueling: overlappingDepot !== null,
            });
            if (update.refuelStarted) this.emit({ type: 'refuel-start' });
            if (update.refuelStopped) this.emit({ type: 'refuel-stop' });
            if (update.enteredCritical) this.emit({ type: 'low-fuel' });
            if (update.depleted) this.emit({ type: 'fuel-empty' });
            this.jet.setRefueling(this.fuel.isRefueling);
        }

        // 8. After the wreck has settled: next jet, or game over.
        let teleported = false;
        if (this.jet.state === 'DEAD' && this.jet.stateTime >= this.settings.respawnDelay - 1e-9) {
            if (this.lives > 0) {
                this.respawn(world);
                teleported = true;
            } else {
                this.gameOver = true;
                this.gameOverTime = 0;
                this.emit({ type: 'game-over', score: this.score });
            }
        }

        // 9. Effects.
        if (this.jet.isFlying) {
            this.particles.afterburner(
                this.jet.x, this.jet.y - this.jet.config.height / 2, this.jet.speed, this.jet.throttleLevel,
            );
        }
        this.particles.update(dt);
        return { cameraY: this.cameraY, scrollSpeed: this.jet.speed, cameraTeleported: teleported };
    }

    // -------------------------------------------------------------- internals

    /**
     * Sets the jet's speed scale and the fuel's burn scale for the current mode and stage.
     * Campaign: both 1. Endless: they follow the bridges destroyed. The jet keeps its current
     * speed and eases to the new limits, so a bridge falling never jolts the scroll.
     */
    private applyDifficulty(): void {
        const profile = this.mode === 'endless'
            ? difficultyAt(this.progression.stage, this.difficultyConfig)
            : CAMPAIGN_DIFFICULTY;
        this.currentDifficulty = profile;
        this.jet.setSpeedScale(profile.speedScale);
        this.fuel.setBurnScale(profile.burnScale);
    }

    /**
     * Things placed in the world are scaled by where they are (the bridges below that spot), so
     * the layout stays a pure function of the seed. Installed once per mode, not per bridge.
     */
    private installSpawnerDifficulty(): void {
        const world = this.world;
        if (!world) return;
        const config = this.difficultyConfig;
        const endless = this.mode === 'endless';
        this.spawner?.setChanceScale(endless ? y => difficultyAt(world.stageAt(y), config).depotChanceScale : null);
        this.enemySpawner?.setDifficulty(endless ? stage => difficultyAt(stage, config) : null);
    }

    private emit(event: GameEvent): void {
        for (const listener of this.listeners) listener(event);
    }

    /**
     * Handles a jet that has started exploding, exactly once per life, however it got
     * there (crash, stall detonation, or an external `jet.destroy()` call).
     */
    private processDeath(): void {
        if (this.deathHandled || this.jet.state !== 'EXPLODING') return;
        this.deathHandled = true;
        this.onJetDestroyed(this.jet.deathCause ?? 'fuel');
    }

    private onJetDestroyed(cause: DeathCause): void {
        const livesLeft = this.progression.loseLife();
        if (this.fuel.cancelRefuel()) this.emit({ type: 'refuel-stop' });
        this.particles.explosion(this.jet.x, this.jet.y, 1.4);
        this.emit({ type: 'jet-destroyed', cause, x: this.jet.x, y: this.jet.y, livesLeft });
    }

    private respawn(world: RiverGenerator): void {
        const y = this.bridges.respawnY(this.settings.startY, this.settings.respawnMargin);
        const x = safeSpawnX(world, y);
        this.jet.spawn(x, y, { invulnerable: true });
        this.deathHandled = false;
        this.fuel.reset();
        this.weapon.clear();
        this.depots.clear();
        // Enemies come back fresh around the checkpoint, as in the arcade original.
        this.enemies.clear();
        this.spawnedEnemies.clear();
        this.cameraY = y - this.playerLineOffset;
        this.syncDepots();
        this.syncEnemies();
        this.emit({ type: 'respawn', x, y });
    }

    private resolveProjectiles(collision: CollisionSystem, world: RiverGenerator): void {
        for (const projectile of this.weapon.projectiles) {
            if (!projectile.alive) continue;
            const hit = collision.sweepProjectile(projectile, this.depots.values(), this.enemies.values());
            if (!hit) continue;
            projectile.kill();
            switch (hit.kind) {
                case 'depot':
                    this.destroyDepot(hit.depot);
                    break;
                case 'enemy':
                    this.destroyEnemy(hit.enemy, false);
                    break;
                case 'bridge':
                    this.destroyBridge(hit.bridge, hit.x, world);
                    break;
                case 'land':
                    this.particles.impactSparks(hit.x, hit.y);
                    break;
            }
        }
    }

    private destroyDepot(depot: FuelDepot): void {
        depot.destroyed = true;
        this.depots.delete(depot.id);
        this.destroyedDepots.add(depot.id);
        const award = this.progression.award('depot');
        this.particles.explosion(depot.x, depot.y, 1);
        this.addPopup(depot.x, depot.y + 24, award.points);
        this.emit({ type: 'depot-destroyed', depot, points: award.points });
        this.applyBonus(award, depot.x, depot.y + 50);
    }

    /**
     * Removes an enemy from play. `rammed` means the player's jet flew into it: it is
     * destroyed, but nothing is scored. Otherwise a missile killed it: points are awarded.
     */
    private destroyEnemy(enemy: Enemy, rammed: boolean): void {
        enemy.destroy();
        this.enemies.delete(enemy.id);
        this.particles.enemyExplosion(enemy.x, enemy.y, enemy.kind);
        let points = 0;
        if (!rammed) {
            const award = this.progression.award(scoreSourceFor(enemy.kind));
            points = award.points;
            this.addPopup(enemy.x, enemy.y + enemy.height / 2 + 8, points);
            this.emit({ type: 'enemy-destroyed', enemy, points, rammed });
            this.applyBonus(award, enemy.x, enemy.y + 44);
        } else {
            this.emit({ type: 'enemy-destroyed', enemy, points, rammed });
        }
    }

    private destroyBridge(span: BridgeSpan, impactX: number, world: RiverGenerator): void {
        if (!this.bridges.destroy(span)) return;
        const award = this.progression.award('bridge');
        this.applyDifficulty(); // a bridge down is one stage harder (endless only)
        const river = world.sample(span.centerY);
        this.particles.explosion(impactX, span.centerY, 1.5);
        // A chain of blasts along the span, so the whole deck visibly collapses.
        for (let i = 0; i < 4; i++) {
            const t = (i + 0.5) / 4;
            const x = river.leftBankX + (river.rightBankX - river.leftBankX) * t;
            if (Math.abs(x - impactX) > 40) this.particles.explosion(x, span.centerY, 0.8);
        }
        this.addPopup(impactX, span.topY + 30, award.points);
        this.emit({ type: 'bridge-destroyed', bridge: span, points: award.points });
        const cleared = this.progression.stage;
        const faster = this.mode === 'endless' ? `  SPEED +${((this.currentDifficulty.speedScale - 1) * 100).toFixed(1)}%` : '';
        this.addNotice('stage-clear', `SECTION ${cleared} CLEARED`, `BRIDGE DESTROYED  +${award.points}${faster}`);
        this.emit({ type: 'stage-clear', cleared });
        this.applyBonus(award, impactX, span.topY + 70);
        const goal = this.victoryGoal;
        if (goal > 0 && cleared >= goal && !this.victory) {
            this.victory = true;
            this.gameOverTime = 0;
            this.emit({ type: 'victory', score: this.score });
        }
    }

    /** Announces any extra lives an award earned. */
    private applyBonus(award: AwardResult, x: number, y: number): void {
        if (award.bonusLives <= 0) return;
        this.popups.push({ x, y, text: '1UP', points: 0, age: 0, life: POPUP_LIFE * 1.6 });
        this.addNotice('extra-life', 'EXTRA JET!', `${this.progression.config.bonusLifeEvery.toLocaleString('en-US')} POINTS`);
        this.emit({ type: 'extra-life', lives: this.lives, score: this.score });
    }

    private addPopup(x: number, y: number, points: number): void {
        this.popups.push({ x, y, text: `+${points}`, points, age: 0, life: POPUP_LIFE });
    }

    private addNotice(kind: HudNotice['kind'], title: string, subtitle: string): void {
        // One banner per kind at a time: a newer one replaces an older one still on screen.
        const stale = this.notices.findIndex(n => n.kind === kind);
        if (stale >= 0) this.notices.splice(stale, 1);
        this.notices.push({ kind, title, subtitle, age: 0, life: NOTICE_LIFE });
    }

    private updateNotices(dt: number): void {
        for (let i = this.notices.length - 1; i >= 0; i--) {
            const notice = this.notices[i];
            if (!notice) continue;
            notice.age += dt;
            if (notice.age >= notice.life) this.notices.splice(i, 1);
        }
    }

    /** Moves every enemy one step, keeps it out of the banks, and retires the finished ones. */
    private updateEnemies(dt: number, world: RiverGenerator, collision: CollisionSystem): void {
        const context: EnemyContext = {
            world,
            playerX: this.jet.x,
            playerY: this.jet.y,
            playerFlying: this.jet.isFlying,
            time: this.time,
        };
        for (const [id, enemy] of this.enemies) {
            enemy.update(dt, context);
            if (enemy.alive) collision.resolveEnemyTerrain(enemy, world);
            if (enemy instanceof FighterJet) {
                if (enemy.launchedThisStep) this.emit({ type: 'fighter-launch', enemy });
                if (enemy.alive && enemy.isStreaking) {
                    this.particles.vaporTrail(enemy.x - enemy.direction * (enemy.height / 2), enemy.y, enemy.direction);
                }
            }
            if (!enemy.alive || enemy.y < this.cameraY - ENEMY_CULL_BEHIND) this.enemies.delete(id);
        }
    }

    /** Turns the spawner's placements into enemies as they come within range of the camera. */
    private syncEnemies(): void {
        const spawner = this.enemySpawner;
        if (!spawner) return;
        const lo = this.cameraY - ENEMY_SPAWN_BEHIND;
        const hi = this.cameraY + this.settings.viewHeight + ENEMY_SPAWN_AHEAD;
        const [first, last] = spawner.slotRange(lo, hi);
        for (let slot = first; slot <= last; slot++) {
            for (const placement of spawner.place(slot)) {
                if (placement.y < lo || placement.y > hi || this.spawnedEnemies.has(placement.id)) continue;
                this.spawnedEnemies.add(placement.id);
                this.enemies.set(placement.id, spawner.create(placement));
            }
        }
    }

    private updatePopups(dt: number): void {
        for (let i = this.popups.length - 1; i >= 0; i--) {
            const popup = this.popups[i];
            if (!popup) continue;
            popup.age += dt;
            if (popup.age >= popup.life) this.popups.splice(i, 1);
        }
    }

    /** Streams depots in ahead of the camera and drops those far behind or beyond the window. */
    private syncDepots(): void {
        const spawner = this.spawner;
        if (!spawner) return;
        const lo = this.cameraY - DEPOT_SPAWN_BEHIND;
        const hi = this.cameraY + this.settings.viewHeight + DEPOT_SPAWN_AHEAD;
        for (const [id, depot] of this.depots) {
            if (depot.y < lo - DEPOT_CULL_BEHIND || depot.y > hi + DEPOT_CULL_AHEAD) this.depots.delete(id);
        }
        const [first, last] = spawner.slotRange(lo, hi);
        for (let slot = first; slot <= last; slot++) {
            if (this.depots.has(slot) || this.destroyedDepots.has(slot)) continue;
            const depot = spawner.create(slot);
            if (depot && depot.y >= lo && depot.y <= hi) this.depots.set(slot, depot);
        }
    }
}
