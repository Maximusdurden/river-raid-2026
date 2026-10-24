import type { AudioState } from '../audio/SoundEngine.js';
import type { FrameRenderer } from '../core/Engine.js';
import { FighterJet } from '../entities/enemies/FighterJet.js';
import { Helicopter } from '../entities/enemies/Helicopter.js';
import { PatrolBoat } from '../entities/enemies/PatrolBoat.js';
import type { GameMode } from '../game/GameMode.js';
import type { GameSession, HudNotice, ScorePopup } from '../game/GameSession.js';
import type { RiverGenerator } from '../world/RiverGenerator.js';
import { Celebration } from './Celebration.js';
import {
    RiverRenderer,
    VIEW_HEIGHT,
    VIEW_WIDTH,
    type RenderState,
    type RiverRendererOptions,
} from './RiverRenderer.js';

const TAU = Math.PI * 2;
const MONO = 'ui-monospace, "Cascadia Mono", Consolas, monospace';
const SANS = '"Segoe UI", system-ui, sans-serif';

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

function clamp01(value: number): number {
    return value < 0 ? 0 : value > 1 ? 1 : value;
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
}

function panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
    roundedRect(ctx, x, y, w, h, 10);
    ctx.fillStyle = 'rgba(4, 10, 22, 0.72)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(101, 223, 205, 0.28)';
    ctx.lineWidth = 1;
    ctx.stroke();
}

/** The HUD reminder for the options screen. */
export const OPTIONS_HINT = '[O] OPTIONS';
export const SCORES_HINT = '[H] HIGH SCORES';
/** Where the end screen starts while a high-score celebration is on (normally 150), and the banner's centre line above it. */
export const CELEBRATION_TOP = 196;
export const CELEBRATION_BANNER_Y = 124;

/** The line under the score: the section, and in campaign how far through the 10 bridges the run is. */
export function sectionLine(mode: GameMode, bridgesDown: number, campaignLength: number): string {
    const section = bridgesDown + 1;
    if (mode === 'endless') return `SECTION ${section} \u00b7 ENDLESS`;
    return campaignLength > 0 ? `SECTION ${section} / ${campaignLength}` : `SECTION ${section}`;
}

/** Short HUD text for the sound state. */
export function audioLabel(state: AudioState): string {
    switch (state) {
        case 'on': return 'SOUND  [M]';
        case 'muted': return 'MUTED  [M]';
        case 'locked': return 'PRESS A KEY';
        case 'unsupported': return 'NO AUDIO';
    }
}

/** Green when healthy, through amber, to red as the tank empties. */
export function fuelColor(fraction: number): string {
    const f = clamp01(fraction);
    const hue = f >= 0.5 ? 138 : f >= 0.3 ? lerp(46, 138, (f - 0.3) / 0.2) : f >= 0.2 ? lerp(4, 46, (f - 0.2) / 0.1) : 4;
    return `hsl(${hue.toFixed(0)}, 88%, 54%)`;
}

// ------------------------------------------------------------------ jet sprite

function traceFuselage(ctx: CanvasRenderingContext2D): void {
    ctx.beginPath();
    ctx.moveTo(0, -12);
    ctx.lineTo(2.8, -5);
    ctx.lineTo(3.3, 6);
    ctx.lineTo(1.9, 10.2);
    ctx.lineTo(0, 8.6);
    ctx.lineTo(-1.9, 10.2);
    ctx.lineTo(-3.3, 6);
    ctx.lineTo(-2.8, -5);
    ctx.closePath();
}

function traceWing(ctx: CanvasRenderingContext2D, side: 1 | -1): void {
    ctx.beginPath();
    ctx.moveTo(side * 2.6, -3);
    ctx.lineTo(side * 14, 8.5);
    ctx.lineTo(side * 13.2, 10.6);
    ctx.lineTo(side * 3.2, 6.4);
    ctx.closePath();
}

function traceFin(ctx: CanvasRenderingContext2D, side: 1 | -1): void {
    ctx.beginPath();
    ctx.moveTo(side * 3, 5.2);
    ctx.lineTo(side * 7.6, 10.8);
    ctx.lineTo(side * 2.2, 9.8);
    ctx.closePath();
}

function traceSilhouette(ctx: CanvasRenderingContext2D): void {
    ctx.beginPath();
    for (const side of [1, -1] as const) {
        ctx.moveTo(side * 2.6, -3);
        ctx.lineTo(side * 14, 8.5);
        ctx.lineTo(side * 13.2, 10.6);
        ctx.lineTo(side * 3.2, 6.4);
        ctx.closePath();
    }
    ctx.moveTo(0, -12);
    ctx.lineTo(2.8, -5);
    ctx.lineTo(3.3, 6);
    ctx.lineTo(1.9, 10.2);
    ctx.lineTo(-1.9, 10.2);
    ctx.lineTo(-3.3, 6);
    ctx.lineTo(-2.8, -5);
    ctx.closePath();
}

/** Afterburner: length follows throttle (brake ~6, cruise ~20, boost ~34), with flicker. */
function drawFlame(ctx: CanvasRenderingContext2D, throttle: number, time: number): void {
    const level = (Math.max(-1, Math.min(1, throttle)) + 1) / 2;
    const flicker = 0.9 + 0.1 * Math.sin(time * 71) + 0.05 * Math.sin(time * 133 + 1.7);
    const length = lerp(6, 34, level) * flicker;
    const layers: readonly (readonly [number, number, string])[] = [
        [3.4, 1, 'rgba(255, 110, 30, 0.5)'],
        [2.4, 0.72, 'rgba(255, 196, 90, 0.7)'],
        [1.3, 0.46, throttle > 0.3 ? 'rgba(190, 225, 255, 0.95)' : 'rgba(255, 246, 210, 0.9)'],
    ];
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const [halfWidth, lengthScale, color] of layers) {
        const tip = 9.6 + length * lengthScale;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(-halfWidth, 9.6);
        ctx.quadraticCurveTo(-halfWidth * 0.6, 9.6 + (tip - 9.6) * 0.55, 0, tip);
        ctx.quadraticCurveTo(halfWidth * 0.6, 9.6 + (tip - 9.6) * 0.55, halfWidth, 9.6);
        ctx.closePath();
        ctx.fill();
    }
    ctx.restore();
}

export interface JetSpriteOptions {
    x: number;
    y: number;
    /** Bank angle in radians (+ = right). */
    roll: number;
    maxRoll: number;
    /** Throttle level in [-1, 1]; scales the afterburner. */
    throttle: number;
    flame: boolean;
    time: number;
    scale?: number;
    shadow?: boolean;
}

/**
 * Draws the jet nose-up, centred on (x, y) in logical units. Banking rotates the whole
 * sprite, narrows it slightly (foreshortening) and shades the lowered wing darker.
 */
export function drawJetSprite(ctx: CanvasRenderingContext2D, o: JetSpriteOptions): void {
    const scale = o.scale ?? 1;
    const bank = o.maxRoll > 0 ? Math.max(-1, Math.min(1, o.roll / o.maxRoll)) : 0;
    const squash = 1 - 0.1 * Math.abs(bank);

    if (o.shadow) {
        ctx.save();
        ctx.translate(o.x + 9 * scale, o.y + 13 * scale);
        ctx.rotate(o.roll);
        ctx.scale(scale * 0.92 * squash, scale * 0.92);
        ctx.fillStyle = 'rgba(0, 8, 20, 0.3)';
        traceSilhouette(ctx);
        ctx.fill();
        ctx.restore();
    }

    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.rotate(o.roll);
    ctx.scale(scale * squash, scale);
    if (o.flame) drawFlame(ctx, o.throttle, o.time);

    ctx.lineJoin = 'round';
    ctx.lineWidth = 0.7;
    ctx.strokeStyle = 'rgba(8, 22, 42, 0.7)';
    traceFin(ctx, 1);
    ctx.fillStyle = '#4c6d96';
    ctx.fill();
    ctx.stroke();
    traceFin(ctx, -1);
    ctx.fill();
    ctx.stroke();

    traceWing(ctx, -1);
    ctx.fillStyle = `hsl(214, 42%, ${46 + 9 * bank}%)`;
    ctx.fill();
    ctx.stroke();
    traceWing(ctx, 1);
    ctx.fillStyle = `hsl(214, 42%, ${46 - 9 * bank}%)`;
    ctx.fill();
    ctx.stroke();

    // Wing-tip markings.
    ctx.fillStyle = '#ff6a4d';
    ctx.fillRect(-13.6, 7.6, 1.8, 2.8);
    ctx.fillRect(11.8, 7.6, 1.8, 2.8);

    traceFuselage(ctx);
    ctx.fillStyle = '#dfe8f3';
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#aebccf';
    ctx.fillRect(-0.4, -6, 0.8, 12);

    // Canopy.
    ctx.fillStyle = '#2cc8f0';
    ctx.beginPath();
    ctx.ellipse(0, -3.4, 1.9, 3.5, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(230, 252, 255, 0.85)';
    ctx.beginPath();
    ctx.ellipse(-0.5, -4.4, 0.6, 1.5, 0, 0, TAU);
    ctx.fill();

    // Nozzle.
    ctx.fillStyle = '#39414f';
    ctx.fillRect(-1.5, 8.6, 3, 1.6);
    ctx.restore();
}

// -------------------------------------------------------------------- enemies

export interface HelicopterSpriteOptions {
    x: number;
    y: number;
    /** +1 nose points right, -1 nose points left. */
    facing: 1 | -1;
    /** Main rotor angle in radians. */
    rotor: number;
    /** Slight yaw into the direction of travel, in radians. */
    lean: number;
}

/**
 * Patrol helicopter seen from above, 24x18: olive fuselage, amber-blue canopy, tail boom
 * with a spinning tail rotor, skids, and a twin-blade main rotor drawn as a motion-blurred
 * disc with a fading sweep behind each blade.
 */
export function drawHelicopter(ctx: CanvasRenderingContext2D, o: HelicopterSpriteOptions): void {
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.scale(o.facing, 1);
    ctx.rotate(o.lean * 0.6);

    ctx.fillStyle = 'rgba(0, 8, 20, 0.28)';
    ctx.beginPath();
    ctx.ellipse(5, 7, 12, 6, 0, 0, TAU);
    ctx.fill();

    // Skids and struts.
    ctx.strokeStyle = '#2b3039';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(-7, -5.4);
    ctx.lineTo(9, -5.4);
    ctx.moveTo(-7, 5.4);
    ctx.lineTo(9, 5.4);
    ctx.moveTo(-3, -5.4);
    ctx.lineTo(-3, 5.4);
    ctx.moveTo(5, -5.4);
    ctx.lineTo(5, 5.4);
    ctx.stroke();

    // Tail boom, fin and tail rotor.
    ctx.fillStyle = '#566174';
    ctx.fillRect(-13, -1, 9, 2);
    ctx.fillStyle = '#3f4857';
    ctx.fillRect(-13.6, -3.8, 2.2, 7.6);
    const tail = o.rotor * 1.7;
    ctx.fillStyle = 'rgba(210, 220, 232, 0.28)';
    ctx.beginPath();
    ctx.arc(-13, 0, 3.4, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = '#1f242b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-13 + Math.cos(tail) * 3.4, Math.sin(tail) * 3.4);
    ctx.lineTo(-13 - Math.cos(tail) * 3.4, -Math.sin(tail) * 3.4);
    ctx.stroke();

    // Fuselage, engine housing, canopy.
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = 'rgba(14, 22, 12, 0.75)';
    ctx.fillStyle = '#7f9466';
    ctx.beginPath();
    ctx.ellipse(1, 0, 8.2, 5.2, 0, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#5a6a4a';
    ctx.fillRect(-4, -2.4, 6, 4.8);
    ctx.fillStyle = '#e8a33a';
    ctx.fillRect(-1, -5.2, 1.6, 10.4);
    ctx.fillStyle = '#2cc8f0';
    ctx.beginPath();
    ctx.ellipse(5.2, 0, 3.4, 3, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(235, 252, 255, 0.85)';
    ctx.beginPath();
    ctx.ellipse(4.4, -1, 1.3, 0.9, 0, 0, TAU);
    ctx.fill();

    // Main rotor: blur disc, two fading sweeps, two blades, hub.
    const radius = 11.5;
    ctx.fillStyle = 'rgba(206, 218, 230, 0.15)';
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, TAU);
    ctx.fill();
    for (let blade = 0; blade < 2; blade++) {
        const angle = o.rotor + blade * Math.PI;
        for (let i = 1; i <= 4; i++) {
            ctx.strokeStyle = `rgba(214, 224, 236, ${(0.16 - i * 0.03).toFixed(3)})`;
            ctx.lineWidth = 2.2;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(Math.cos(angle - i * 0.28) * radius, Math.sin(angle - i * 0.28) * radius);
            ctx.stroke();
        }
    }
    ctx.strokeStyle = '#1b2027';
    ctx.lineWidth = 1.9;
    ctx.beginPath();
    ctx.moveTo(Math.cos(o.rotor) * radius, Math.sin(o.rotor) * radius);
    ctx.lineTo(-Math.cos(o.rotor) * radius, -Math.sin(o.rotor) * radius);
    ctx.stroke();
    ctx.fillStyle = '#a3acb8';
    ctx.beginPath();
    ctx.arc(0, 0, 1.7, 0, TAU);
    ctx.fill();
    ctx.restore();
}

export interface BoatSpriteOptions {
    x: number;
    y: number;
    facing: 1 | -1;
    time: number;
    /** 0 = dead in the water, 1 = full cruise: scales the wake. */
    speedFraction: number;
    drifting: boolean;
    /** Per-boat phase for the animations. */
    seed: number;
}

/**
 * Patrol boat, 36x14: a pointed grey hull with a red waterline, a lit cabin, a swivelling
 * deck cannon, an animated bow wave and a V-shaped wake (or spreading ripples while it
 * drifts).
 */
export function drawPatrolBoat(ctx: CanvasRenderingContext2D, o: BoatSpriteOptions): void {
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.scale(o.facing, 1);
    const speed = Math.max(0, Math.min(1, o.speedFraction));

    // Water effects first, so the hull sits on top of them.
    ctx.lineCap = 'round';
    if (o.drifting) {
        for (let ring = 0; ring < 2; ring++) {
            const phase = (o.time * 0.55 + ring * 0.5 + o.seed * 0.37) % 1;
            ctx.strokeStyle = `rgba(206, 238, 250, ${(0.34 * (1 - phase)).toFixed(3)})`;
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.ellipse(0, 0, 20 + 15 * phase, 9 + 8 * phase, 0, 0, TAU);
            ctx.stroke();
        }
    } else {
        const length = 20 + 22 * speed;
        ctx.strokeStyle = `rgba(214, 240, 250, ${(0.16 + 0.26 * speed).toFixed(3)})`;
        ctx.lineWidth = 2;
        ctx.setLineDash([7, 6]);
        ctx.lineDashOffset = -o.time * 16;
        for (const side of [-1, 1]) {
            ctx.beginPath();
            ctx.moveTo(-16, side * 5);
            ctx.lineTo(-16 - length, side * (6 + length * 0.42));
            ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.strokeStyle = `rgba(226, 246, 252, ${(0.12 + 0.2 * speed).toFixed(3)})`;
        ctx.lineWidth = 3.4;
        ctx.beginPath();
        ctx.moveTo(-18, 0);
        ctx.lineTo(-18 - length * 0.8, 0);
        ctx.stroke();
    }
    // Bow wave.
    const foam = 0.35 + 0.5 * speed + (o.drifting ? 0 : 0.1 * Math.sin(o.time * 9 + o.seed));
    ctx.strokeStyle = `rgba(240, 252, 255, ${foam.toFixed(3)})`;
    ctx.lineWidth = 1.8;
    for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(18.5, 0);
        ctx.quadraticCurveTo(14, side * 3, 7, side * (8.4 + 2 * speed));
        ctx.stroke();
    }

    // Shadow and hull.
    ctx.fillStyle = 'rgba(0, 10, 22, 0.28)';
    ctx.beginPath();
    ctx.moveTo(-17, -4);
    ctx.lineTo(11, -4.6);
    ctx.lineTo(19, 2.4);
    ctx.lineTo(11, 9.6);
    ctx.lineTo(-17, 9);
    ctx.closePath();
    ctx.fill();
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(-18, -6.5);
    ctx.lineTo(10, -7);
    ctx.lineTo(18.5, 0);
    ctx.lineTo(10, 7);
    ctx.lineTo(-18, 6.5);
    ctx.closePath();
    ctx.fillStyle = '#7d8794';
    ctx.fill();
    ctx.strokeStyle = '#b4382c';
    ctx.lineWidth = 1.7;
    ctx.stroke();

    // Deck.
    ctx.beginPath();
    ctx.moveTo(-15.5, -4.6);
    ctx.lineTo(9, -4.8);
    ctx.lineTo(14.8, 0);
    ctx.lineTo(9, 4.8);
    ctx.lineTo(-15.5, 4.6);
    ctx.closePath();
    ctx.fillStyle = '#a7b0bc';
    ctx.fill();
    ctx.strokeStyle = 'rgba(40, 48, 60, 0.5)';
    ctx.lineWidth = 0.7;
    ctx.stroke();
    ctx.fillStyle = '#6a7482';
    ctx.fillRect(-15, -3.8, 3, 2.6);
    ctx.fillRect(-15, 1.4, 3, 2.4);

    // Cabin with a lit window strip, and a mast.
    ctx.fillStyle = '#dde2e9';
    ctx.fillRect(-11, -3.4, 8.5, 6.8);
    ctx.fillStyle = '#8895a6';
    ctx.fillRect(-10, -2.6, 6.5, 5.2);
    ctx.fillStyle = '#ffd96b';
    ctx.fillRect(-4.4, -2.1, 1.3, 4.2);
    ctx.fillStyle = '#2b3039';
    ctx.beginPath();
    ctx.arc(-6.8, 0, 1.2, 0, TAU);
    ctx.fill();

    // Deck cannon, slowly sweeping.
    const aim = Math.sin(o.time * 1.2 + o.seed * 1.9) * 0.38;
    ctx.save();
    ctx.translate(8.2, 0);
    ctx.rotate(aim);
    ctx.fillStyle = '#272c33';
    ctx.fillRect(0, -0.9, 8.4, 1.8);
    ctx.fillStyle = '#434b57';
    ctx.beginPath();
    ctx.arc(0, 0, 2.8, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#6b7482';
    ctx.beginPath();
    ctx.arc(-0.5, -0.6, 1, 0, TAU);
    ctx.fill();
    ctx.restore();
    ctx.restore();
}

export interface FighterSpriteOptions {
    x: number;
    y: number;
    facing: 1 | -1;
    streaking: boolean;
    time: number;
    seed: number;
}

/**
 * Interceptor, 20x22: dark swept wings with orange stripes and an amber canopy, so it
 * reads as hostile at a glance. While streaking it burns a long afterburner; parked, its
 * wing-tip lights blink.
 */
export function drawFighter(ctx: CanvasRenderingContext2D, o: FighterSpriteOptions): void {
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.scale(o.facing, 1);

    ctx.fillStyle = 'rgba(0, 8, 20, 0.28)';
    ctx.beginPath();
    ctx.moveTo(14, 6);
    ctx.lineTo(-4, -4);
    ctx.lineTo(-6, 17);
    ctx.closePath();
    ctx.fill();

    if (o.streaking) {
        const flicker = 0.85 + 0.15 * Math.sin(o.time * 90 + o.seed) + 0.08 * Math.sin(o.time * 151);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const layers: readonly (readonly [number, number, string])[] = [
            [4.2, 1, 'rgba(255, 96, 28, 0.45)'],
            [2.8, 0.72, 'rgba(255, 190, 80, 0.7)'],
            [1.4, 0.45, 'rgba(255, 246, 215, 0.95)'],
        ];
        for (const [half, scale, color] of layers) {
            const tip = -10 - 18 * scale * flicker;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.moveTo(-10, -half);
            ctx.quadraticCurveTo((tip - 10) * 0.55, -half * 0.6, tip, 0);
            ctx.quadraticCurveTo((tip - 10) * 0.55, half * 0.6, -10, half);
            ctx.closePath();
            ctx.fill();
        }
        ctx.restore();
    }

    ctx.lineJoin = 'round';
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = 'rgba(8, 10, 16, 0.8)';

    // Tailplanes, then wings.
    ctx.fillStyle = '#3b4352';
    for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(-7, side * 2);
        ctx.lineTo(-10.5, side * 6.4);
        ctx.lineTo(-11.5, side * 6.4);
        ctx.lineTo(-10, side * 2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
    }
    for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(4, side * 1.8);
        ctx.lineTo(-5.5, side * 11);
        ctx.lineTo(-9, side * 11);
        ctx.lineTo(-6.5, side * 2);
        ctx.closePath();
        ctx.fillStyle = '#566074';
        ctx.fill();
        ctx.stroke();
        ctx.strokeStyle = '#ee6a43';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(-3.4, side * 7);
        ctx.lineTo(-6.8, side * 7);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(8, 10, 16, 0.8)';
        ctx.lineWidth = 0.8;
    }

    // Fuselage.
    ctx.beginPath();
    ctx.moveTo(10.5, 0);
    ctx.lineTo(5.5, -1.9);
    ctx.lineTo(-8, -2.3);
    ctx.lineTo(-10.5, -1.3);
    ctx.lineTo(-10.5, 1.3);
    ctx.lineTo(-8, 2.3);
    ctx.lineTo(5.5, 1.9);
    ctx.closePath();
    ctx.fillStyle = '#434c5c';
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ee6a43';
    ctx.fillRect(-3, -1.9, 1.6, 3.8);
    ctx.fillStyle = '#ffcf5a';
    ctx.beginPath();
    ctx.ellipse(3.4, 0, 2.8, 1.4, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 250, 220, 0.8)';
    ctx.beginPath();
    ctx.ellipse(2.6, -0.5, 1, 0.5, 0, 0, TAU);
    ctx.fill();

    if (!o.streaking && Math.floor(o.time * 2.2 + o.seed) % 2 === 0) {
        ctx.fillStyle = '#ff4a3a';
        ctx.fillRect(-8.6, -11.4, 2, 1.6);
        ctx.fillStyle = '#5dff9a';
        ctx.fillRect(-8.6, 9.8, 2, 1.6);
    }
    ctx.restore();
}

/** A speaker glyph: waves when on, a red slash when muted, dim pulsing waves while waiting to be unlocked. */
export function drawAudioIcon(ctx: CanvasRenderingContext2D, x: number, y: number, state: AudioState, time: number): void {
    ctx.save();
    ctx.translate(x, y);
    const live = state === 'on';
    const dim = state === 'locked' ? 0.45 + 0.35 * Math.sin(time * 4) : state === 'unsupported' ? 0.35 : 1;
    ctx.globalAlpha = Math.max(0.2, Math.min(1, dim));
    ctx.fillStyle = live ? '#eaf6ff' : '#9fb4c8';
    ctx.beginPath();
    ctx.moveTo(-8, -3);
    ctx.lineTo(-4, -3);
    ctx.lineTo(1, -7);
    ctx.lineTo(1, 7);
    ctx.lineTo(-4, 3);
    ctx.lineTo(-8, 3);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = live ? '#65dfcd' : '#9fb4c8';
    ctx.lineWidth = 1.6;
    if (state === 'on' || state === 'locked') {
        ctx.beginPath();
        ctx.arc(1, 0, 4.2, -0.9, 0.9);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(1, 0, 8, -0.95, 0.95);
        ctx.stroke();
    }
    if (state === 'muted' || state === 'unsupported') {
        ctx.strokeStyle = '#ff5d4a';
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(4, -6);
        ctx.lineTo(11, 6);
        ctx.moveTo(11, -6);
        ctx.lineTo(4, 6);
        ctx.stroke();
    }
    ctx.restore();
}

/** Colour tiers for floating scores: the bigger the prize, the warmer the colour. */
export function popupColor(points: number): string {
    if (points <= 0) return '#7dffc0';
    if (points >= 500) return '#fff1a8';
    if (points >= 100) return '#ff9fdc';
    if (points >= 80) return '#ffb347';
    if (points >= 60) return '#ffe27a';
    return '#bfe9ff';
}

export interface GameRendererOptions extends RiverRendererOptions {
    /** Draw hitboxes (follows `showGuides` unless set). */
    showHitboxes: boolean;
}

/**
 * Draws the river (Phase 2) and, on top of it, the game layer: depots, enemies, missiles,
 * the jet, particles, floating scores, notices and the HUD. Everything is interpolated
 * with the loop's alpha, so motion is smooth at any refresh rate.
 */
export class GameRenderer implements FrameRenderer {
    readonly river: RiverRenderer;
    /** Reports the sound state for the HUD icon. Set by the host once the sound engine exists. */
    audioState: () => AudioState = () => 'unsupported';
    /** The high-score show: set it going with `celebration.start(...)`; the renderer draws the border and banner. */
    readonly celebration = new Celebration();
    private readonly session: GameSession;
    private world: RiverGenerator;

    constructor(canvas: HTMLCanvasElement, world: RiverGenerator, session: GameSession, options: Partial<RiverRendererOptions> = {}) {
        this.river = new RiverRenderer(canvas, world, options);
        this.world = world;
        this.session = session;
        this.river.isBridgeDestroyed = (n: number): boolean => session.bridges.isDestroyed(n);
    }

    setWorld(world: RiverGenerator): void {
        this.world = world;
        this.river.setWorld(world);
    }

    destroy(): void {
        this.river.destroy();
    }

    /**
     * Hitbox outlines and guide lines (the page's "Hitboxes" toggle). False unless something turns
     * it on: it is never remembered from an earlier session.
     */
    get showHitboxes(): boolean {
        return this.river.options.showGuides;
    }

    set showHitboxes(on: boolean) {
        this.river.options.showGuides = on;
    }

    render(state: RenderState, alpha: number): void {
        this.river.render(state, alpha);
        const a = clamp01(Number.isFinite(alpha) ? alpha : 1);
        const camY = lerp(state.previousCameraY, state.cameraY, a);
        const time = lerp(state.previousTime, state.time, a);
        const ctx = this.river.context;
        const scale = this.river.pixelScale;

        ctx.save();
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        this.drawDepots(ctx, camY, time);
        this.drawEnemies(ctx, camY, a, time);
        this.drawProjectiles(ctx, camY, a);
        this.drawJet(ctx, camY, a, time);
        this.session.particles.render(ctx, camY, a, VIEW_HEIGHT);
        this.drawPopups(ctx, camY);
        if (this.river.options.showGuides) this.drawHitboxes(ctx, camY, a);
        this.drawHud(ctx, time, state.userPaused ?? state.paused);
        // The end screen dims everything under it; a celebration's fireworks are drawn again on top so they stay bright.
        if (this.celebration.active && (this.session.gameOver || this.session.victory)) {
            this.session.particles.render(ctx, camY, a, VIEW_HEIGHT);
        }
        ctx.restore();
    }

    // ------------------------------------------------------------- game layer

    private drawDepots(ctx: CanvasRenderingContext2D, camY: number, time: number): void {
        for (const depot of this.session.depots.values()) {
            const sy = VIEW_HEIGHT - (depot.y - camY);
            if (sy < -60 || sy > VIEW_HEIGHT + 60) continue;
            const w = depot.width;
            const h = depot.height;
            ctx.save();
            ctx.translate(depot.x, sy);

            ctx.fillStyle = 'rgba(0, 8, 20, 0.35)';
            ctx.fillRect(-w / 2 + 4, -h / 2 + 5, w, h);

            // High-visibility pulse so depots read at a glance.
            const pulse = 0.5 + 0.5 * Math.sin(time * 5 + depot.id);
            ctx.globalCompositeOperation = 'lighter';
            ctx.fillStyle = `rgba(255, 90, 60, ${(0.1 + 0.12 * pulse).toFixed(3)})`;
            ctx.beginPath();
            ctx.ellipse(0, 0, w * 1.25, h * 0.78, 0, 0, TAU);
            ctx.fill();
            ctx.globalCompositeOperation = 'source-over';

            roundedRect(ctx, -w / 2, -h / 2, w, h, 4);
            ctx.fillStyle = '#d8342a';
            ctx.fill();
            ctx.lineWidth = 1.6;
            ctx.strokeStyle = '#f4f6f8';
            ctx.stroke();

            // Hazard-striped end caps.
            for (const capY of [-h / 2 + 1.6, h / 2 - 6.6]) {
                for (let i = 0; i < 5; i++) {
                    ctx.fillStyle = i % 2 === 0 ? '#ffd23f' : '#1b1f27';
                    ctx.fillRect(-w / 2 + 1.6 + i * ((w - 3.2) / 5), capY, (w - 3.2) / 5, 5);
                }
            }

            ctx.fillStyle = '#ffffff';
            ctx.font = `800 9px ${SANS}`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            for (let i = 0; i < 4; i++) ctx.fillText('FUEL'.charAt(i), 0, -13.5 + i * 9);
            ctx.restore();
        }
    }

    private drawEnemies(ctx: CanvasRenderingContext2D, camY: number, a: number, time: number): void {
        for (const enemy of this.session.enemies.values()) {
            const x = lerp(enemy.previousX, enemy.x, a);
            const sy = VIEW_HEIGHT - (lerp(enemy.previousY, enemy.y, a) - camY);
            if (sy < -60 || sy > VIEW_HEIGHT + 60 || x < -50 || x > VIEW_WIDTH + 50) continue;
            if (enemy instanceof Helicopter) {
                drawHelicopter(ctx, {
                    x, y: sy,
                    facing: Math.abs(enemy.vx) > 3 ? (enemy.vx > 0 ? 1 : -1) : enemy.heading,
                    rotor: enemy.rotorAngle(time),
                    lean: enemy.lean,
                });
            } else if (enemy instanceof PatrolBoat) {
                drawPatrolBoat(ctx, {
                    x, y: sy,
                    facing: Math.abs(enemy.vx) > 2 ? (enemy.vx > 0 ? 1 : -1) : enemy.heading,
                    time,
                    speedFraction: enemy.isDrifting ? 0 : Math.abs(enemy.vx) / Math.max(1, enemy.speed),
                    drifting: enemy.isDrifting,
                    seed: enemy.id % 97,
                });
            } else if (enemy instanceof FighterJet) {
                drawFighter(ctx, { x, y: sy, facing: enemy.direction, streaking: enemy.isStreaking, time, seed: enemy.id % 89 });
            }
        }
    }

    private drawProjectiles(ctx: CanvasRenderingContext2D, camY: number, a: number): void {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (const p of this.session.weapon.projectiles) {
            if (!p.alive) continue;
            const x = lerp(p.previousX, p.x, a);
            const sy = VIEW_HEIGHT - (lerp(p.previousY, p.y, a) - camY);
            if (sy < -40 || sy > VIEW_HEIGHT + 40) continue;
            const length = 26;
            const trail = ctx.createLinearGradient(x, sy + length, x, sy - p.height / 2);
            trail.addColorStop(0, 'rgba(80, 200, 255, 0)');
            trail.addColorStop(0.7, 'rgba(120, 230, 255, 0.55)');
            trail.addColorStop(1, 'rgba(255, 255, 255, 0.95)');
            ctx.lineCap = 'round';
            ctx.strokeStyle = 'rgba(90, 200, 255, 0.2)';
            ctx.lineWidth = 9;
            ctx.beginPath();
            ctx.moveTo(x, sy + length);
            ctx.lineTo(x, sy - p.height / 2);
            ctx.stroke();
            ctx.strokeStyle = trail;
            ctx.lineWidth = 3;
            ctx.stroke();
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(x, sy - p.height / 2, 2.4, 0, TAU);
            ctx.fill();
        }
        ctx.restore();
    }

    private drawJet(ctx: CanvasRenderingContext2D, camY: number, a: number, time: number): void {
        const jet = this.session.jet;
        if (!jet.isFlying) return;
        // Respawn protection blinks.
        if (jet.isInvulnerable && Math.floor(time * 10) % 2 === 0) return;
        drawJetSprite(ctx, {
            x: lerp(jet.previousX, jet.x, a),
            y: VIEW_HEIGHT - (lerp(jet.previousY, jet.y, a) - camY),
            roll: lerp(jet.previousRoll, jet.roll, a),
            maxRoll: jet.maxRoll,
            throttle: jet.throttleLevel,
            flame: !jet.isStalled,
            time,
            shadow: true,
        });
    }

    private drawPopups(ctx: CanvasRenderingContext2D, camY: number): void {
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (const popup of this.session.popups) this.drawPopup(ctx, popup, camY);
        ctx.restore();
    }

    /** A score that rises and fades; the biggest prizes are larger and glow. */
    private drawPopup(ctx: CanvasRenderingContext2D, popup: ScorePopup, camY: number): void {
        const t = popup.age / popup.life;
        const big = popup.points >= 500;
        const sy = VIEW_HEIGHT - (popup.y - camY) - t * (big ? 52 : 36);
        const pop = 1 + 0.35 * Math.max(0, 1 - t * 6); // a quick pop at the start
        ctx.save();
        ctx.translate(Math.max(28, Math.min(VIEW_WIDTH - 28, popup.x)), sy);
        ctx.scale(pop, pop);
        ctx.globalAlpha = Math.max(0, Math.min(1, (1 - t) * 1.6));
        ctx.font = `800 ${big ? 26 : 18}px ${MONO}`;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
        ctx.fillText(popup.text, 1.5, 1.5);
        if (big) {
            ctx.shadowColor = 'rgba(255, 214, 96, 0.9)';
            ctx.shadowBlur = 12;
        }
        ctx.fillStyle = popupColor(popup.points);
        ctx.fillText(popup.text, 0, 0);
        ctx.restore();
    }

    private drawHitboxes(ctx: CanvasRenderingContext2D, camY: number, a: number): void {
        const session = this.session;
        ctx.save();
        ctx.lineWidth = 1;
        const outline = (color: string, x: number, wy: number, w: number, h: number): void => {
            ctx.strokeStyle = color;
            ctx.strokeRect(x - w / 2, VIEW_HEIGHT - (wy - camY) - h / 2, w, h);
        };
        const jet = session.jet;
        outline('#ff3b3b', lerp(jet.previousX, jet.x, a), lerp(jet.previousY, jet.y, a), jet.config.width, jet.config.height);
        for (const depot of session.depots.values()) outline('#ffd23f', depot.x, depot.y, depot.width, depot.height);
        for (const enemy of session.enemies.values()) {
            outline('#ff5de0', lerp(enemy.previousX, enemy.x, a), lerp(enemy.previousY, enemy.y, a), enemy.width, enemy.height);
        }
        for (const p of session.weapon.projectiles) {
            if (p.alive) outline('#6be4ff', lerp(p.previousX, p.x, a), lerp(p.previousY, p.y, a), p.width, p.height);
        }
        for (const span of this.world.findBridges(camY - 64, camY + VIEW_HEIGHT + 64)) {
            if (!session.bridges.isIntact(span.number)) continue;
            outline('#ff7a3b', VIEW_WIDTH / 2, span.centerY, VIEW_WIDTH, span.topY - span.bottomY);
        }
        ctx.restore();
    }

    // --------------------------------------------------------------------- HUD

    private drawHud(ctx: CanvasRenderingContext2D, time: number, paused: boolean): void {
        const session = this.session;
        ctx.save();
        ctx.textBaseline = 'alphabetic';

        // Score and section, top centre.
        panel(ctx, VIEW_WIDTH / 2 - 92, 10, 184, 70);
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(160, 200, 230, 0.8)';
        ctx.font = `600 11px ${MONO}`;
        ctx.fillText('SCORE', VIEW_WIDTH / 2, 28);
        ctx.fillStyle = '#eaf6ff';
        ctx.font = `700 30px ${MONO}`;
        ctx.fillText(String(Math.floor(session.score)).padStart(6, '0'), VIEW_WIDTH / 2, 56);
        ctx.fillStyle = 'rgba(160, 200, 230, 0.8)';
        ctx.font = `600 11px ${MONO}`;
        ctx.fillText(sectionLine(session.mode, session.stage, session.settings.victoryBridges), VIEW_WIDTH / 2, 72);

        // Lives, top right.
        panel(ctx, VIEW_WIDTH - 158, 10, 148, 46);
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(160, 200, 230, 0.8)';
        ctx.font = `600 11px ${MONO}`;
        ctx.fillText('JETS', VIEW_WIDTH - 148, 28);
        if (session.lives <= 5) {
            for (let i = 0; i < session.lives; i++) {
                drawJetSprite(ctx, {
                    x: VIEW_WIDTH - 118 + i * 21, y: 33, roll: 0, maxRoll: 0, throttle: 0, flame: false, time, scale: 0.6,
                });
            }
        } else {
            ctx.fillStyle = '#eaf6ff';
            ctx.font = `700 18px ${MONO}`;
            ctx.fillText(`x${session.lives}`, VIEW_WIDTH - 110, 40);
        }

        // Sound status, under the jets panel.
        const audio = this.audioState();
        panel(ctx, VIEW_WIDTH - 158, 62, 148, 28);
        drawAudioIcon(ctx, VIEW_WIDTH - 138, 76, audio, time);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = audio === 'on' ? '#eaf6ff' : audio === 'muted' ? '#ff9a8c' : 'rgba(160, 200, 230, 0.85)';
        ctx.font = `600 11px ${MONO}`;
        ctx.fillText(audioLabel(audio), VIEW_WIDTH - 118, 77);
        // A reminder that the settings screen exists; the real control is the DOM button and the O key.
        ctx.textAlign = 'right';
        ctx.fillStyle = 'rgba(160, 200, 230, 0.7)';
        ctx.font = `600 11px ${MONO}`;
        ctx.fillText(OPTIONS_HINT, VIEW_WIDTH - 12, 108);
        ctx.fillText(SCORES_HINT, VIEW_WIDTH - 12, 124);
        ctx.textBaseline = 'alphabetic';

        this.drawFuelGauge(ctx, time);
        for (const notice of session.notices) this.drawNotice(ctx, notice);

        if (session.gameOver || session.victory) {
            this.drawEndScreen(ctx, time);
            if (this.celebration.active) this.drawCelebration(ctx);
        } else if (paused) {
            ctx.fillStyle = 'rgba(2, 8, 18, 0.45)';
            ctx.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
            ctx.textAlign = 'center';
            ctx.fillStyle = '#eaf6ff';
            ctx.font = `800 44px ${SANS}`;
            ctx.fillText('PAUSED', VIEW_WIDTH / 2, VIEW_HEIGHT / 2);
        }
        ctx.restore();
    }

    /** A banner that slides in under the score and fades out (stage clear, extra life). */
    private drawNotice(ctx: CanvasRenderingContext2D, notice: HudNotice): void {
        const t = notice.age / notice.life;
        const alpha = Math.max(0, Math.min(1, t * 7, (1 - t) * 3));
        const slide = (1 - Math.min(1, t * 6)) * 24;
        const stage = notice.kind === 'stage-clear';
        const y = (stage ? 128 : 206) - slide;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        const w = stage ? 420 : 300;
        roundedRect(ctx, VIEW_WIDTH / 2 - w / 2, y - 36, w, 70, 12);
        ctx.fillStyle = 'rgba(4, 10, 22, 0.78)';
        ctx.fill();
        ctx.strokeStyle = stage ? 'rgba(255, 214, 96, 0.85)' : 'rgba(125, 255, 192, 0.85)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = stage ? '#ffd966' : '#7dffc0';
        ctx.font = `800 ${stage ? 32 : 28}px ${SANS}`;
        ctx.fillText(notice.title, VIEW_WIDTH / 2, y + 2);
        ctx.fillStyle = 'rgba(214, 234, 250, 0.92)';
        ctx.font = `600 14px ${MONO}`;
        ctx.fillText(notice.subtitle, VIEW_WIDTH / 2, y + 24);
        ctx.restore();
    }

    /** Game over or victory: a dimmed playfield, the verdict, a stat card and a replay prompt. */
    private drawEndScreen(ctx: CanvasRenderingContext2D, time: number): void {
        const session = this.session;
        const won = session.victory;
        const summary = session.summary;
        const fade = Math.max(0, Math.min(1, session.gameOverTime / 0.7));
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.fillStyle = 'rgba(2, 8, 18, 0.72)';
        ctx.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        const cx = VIEW_WIDTH / 2;
        // A celebration needs the room above the verdict for its banner, so the whole card sits lower.
        const top = this.celebration.active ? CELEBRATION_TOP : 150;

        ctx.shadowColor = won ? 'rgba(255, 214, 96, 0.7)' : 'rgba(255, 93, 74, 0.6)';
        ctx.shadowBlur = 24;
        ctx.fillStyle = won ? '#ffd966' : '#ff5d4a';
        ctx.font = `800 ${won ? 60 : 64}px ${SANS}`;
        ctx.fillText(won ? 'RIVER CLEARED' : 'GAME OVER', cx, top);
        ctx.shadowBlur = 0;
        if (won) {
            ctx.fillStyle = 'rgba(214, 234, 250, 0.95)';
            ctx.font = `600 18px ${MONO}`;
            ctx.fillText(`ALL ${summary.bridges} BRIDGES DESTROYED`, cx, top + 32);
        }

        const cardTop = top + 56;
        roundedRect(ctx, cx - 250, cardTop, 500, 266, 14);
        ctx.fillStyle = 'rgba(8, 18, 34, 0.9)';
        ctx.fill();
        ctx.strokeStyle = won ? 'rgba(255, 214, 96, 0.6)' : 'rgba(101, 223, 205, 0.4)';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.fillStyle = '#eaf6ff';
        ctx.font = `700 30px ${MONO}`;
        ctx.fillText(`FINAL SCORE ${Math.floor(summary.score)}`, cx, cardTop + 48);
        ctx.fillStyle = 'rgba(160, 200, 230, 0.9)';
        ctx.font = `600 14px ${MONO}`;
        ctx.fillText(`SECTION REACHED ${summary.section}   ·   BRIDGES DESTROYED ${summary.bridges}`, cx, cardTop + 76);

        const rows: readonly (readonly [string, number, number])[] = [
            ['HELICOPTERS', summary.kills.helicopter, 60],
            ['PATROL BOATS', summary.kills.patrolBoat, 30],
            ['FIGHTERS', summary.kills.fighter, 100],
            ['FUEL DEPOTS', summary.kills.depot, 80],
            ['BRIDGES', summary.kills.bridge, 500],
        ];
        ctx.font = `600 15px ${MONO}`;
        rows.forEach(([label, count, value], i) => {
            const y = cardTop + 112 + i * 26;
            ctx.textAlign = 'left';
            ctx.fillStyle = 'rgba(214, 234, 250, 0.92)';
            ctx.fillText(label, cx - 200, y);
            ctx.textAlign = 'right';
            ctx.fillStyle = '#eaf6ff';
            ctx.fillText(`${count} x ${value}`, cx + 40, y);
            ctx.fillStyle = popupColor(value);
            ctx.fillText(String(count * value), cx + 200, y);
        });
        ctx.textAlign = 'center';
        if (summary.bonusLives > 0) {
            ctx.fillStyle = '#7dffc0';
            ctx.font = `700 14px ${MONO}`;
            ctx.fillText(`EXTRA JETS EARNED ${summary.bonusLives}`, cx, cardTop + 250);
        }

        if (session.gameOverTime > 1) {
            ctx.globalAlpha = fade * (0.55 + 0.45 * Math.sin(time * 5));
            ctx.fillStyle = '#65dfcd';
            ctx.font = `600 20px ${MONO}`;
            ctx.fillText(won ? 'PRESS FIRE TO FLY AGAIN' : 'PRESS FIRE TO PLAY AGAIN', cx, cardTop + 266 + 42);
        }
        ctx.restore();
    }

    /**
     * The high-score show over the end screen: a flashing neon-gold border and a pulsing banner.
     * The all-time record gets a double border, a faster flash and a bigger, brighter banner.
     */
    private drawCelebration(ctx: CanvasRenderingContext2D): void {
        const show = this.celebration;
        const kind = show.kind;
        if (!kind) return;
        const record = kind === 'record';
        const age = show.age;
        const fadeIn = clamp01(age / 0.25);
        const flash = record ? 0.5 + 0.5 * Math.sin(age * 14) : 0.5 + 0.5 * Math.sin(age * 6);
        // The flash eases to a steady glow once the fireworks are over.
        const glow = 0.45 + 0.55 * flash * (0.35 + 0.65 * show.intensity);
        ctx.save();
        ctx.globalAlpha = fadeIn;
        ctx.shadowColor = '#ffcc33';
        ctx.shadowBlur = record ? 28 : 18;
        ctx.strokeStyle = `rgba(255, 214, 64, ${glow.toFixed(3)})`;
        ctx.lineWidth = record ? 10 : 6;
        ctx.strokeRect(5, 5, VIEW_WIDTH - 10, VIEW_HEIGHT - 10);
        if (record) {
            ctx.strokeStyle = `rgba(255, 244, 168, ${(1 - glow * 0.6).toFixed(3)})`;
            ctx.lineWidth = 3;
            ctx.strokeRect(20, 20, VIEW_WIDTH - 40, VIEW_HEIGHT - 40);
        }

        const pulse = 1 + (record ? 0.08 : 0.04) * Math.sin(age * (record ? 9 : 6));
        ctx.translate(VIEW_WIDTH / 2, record ? CELEBRATION_BANNER_Y - 2 : CELEBRATION_BANNER_Y + 2);
        ctx.scale(pulse, pulse);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `800 ${record ? 46 : 38}px ${SANS}`;
        ctx.lineWidth = 6;
        ctx.strokeStyle = 'rgba(40, 18, 0, 0.9)';
        const text = record ? '\u2605 NEW ALL-TIME RECORD! \u2605' : 'NEW HIGH SCORE!';
        ctx.strokeText(text, 0, 0);
        ctx.fillStyle = record && flash > 0.5 ? '#fff6c2' : '#ffd23f';
        ctx.fillText(text, 0, 0);
        ctx.restore();
    }

    private drawFuelGauge(ctx: CanvasRenderingContext2D, time: number): void {
        const fuel = this.session.fuel;
        const refueling = this.session.isRefueling;
        const critical = fuel.isCritical;
        const barWidth = 400;
        const barHeight = 16;
        const x = (VIEW_WIDTH - barWidth) / 2;
        const y = VIEW_HEIGHT - 44;
        const pulse = 0.5 + 0.5 * Math.sin(time * 12);

        panel(ctx, x - 64, y - 28, barWidth + 134, 66);
        if (critical) {
            roundedRect(ctx, x - 64, y - 28, barWidth + 134, 66, 10);
            ctx.strokeStyle = `rgba(255, 60, 50, ${(0.25 + 0.6 * pulse).toFixed(3)})`;
            ctx.lineWidth = 2;
            ctx.stroke();
        }

        ctx.textBaseline = 'middle';
        ctx.textAlign = 'right';
        ctx.fillStyle = 'rgba(160, 200, 230, 0.9)';
        ctx.font = `700 12px ${MONO}`;
        ctx.fillText('FUEL', x - 12, y + barHeight / 2);

        roundedRect(ctx, x, y, barWidth, barHeight, 8);
        ctx.fillStyle = 'rgba(18, 32, 50, 0.95)';
        ctx.fill();
        ctx.save();
        roundedRect(ctx, x, y, barWidth, barHeight, 8);
        ctx.clip();
        const fillWidth = (barWidth - 4) * fuel.fraction;
        if (fillWidth > 0) {
            ctx.fillStyle = critical ? `hsl(4, 90%, ${(44 + 16 * pulse).toFixed(0)}%)` : fuelColor(fuel.fraction);
            ctx.fillRect(x + 2, y + 2, fillWidth, barHeight - 4);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
            ctx.fillRect(x + 2, y + 2, fillWidth, (barHeight - 4) / 2);
            if (refueling) {
                // A bright band sweeping along the fill while fuel flows in.
                const sweep = ((time * 2.4) % 1) * fillWidth;
                ctx.fillStyle = 'rgba(210, 255, 235, 0.55)';
                ctx.fillRect(x + 2 + sweep - 14, y + 2, 28, barHeight - 4);
            }
        }
        ctx.strokeStyle = 'rgba(4, 10, 22, 0.8)';
        ctx.lineWidth = 1.5;
        for (let i = 1; i < 10; i++) {
            ctx.beginPath();
            ctx.moveTo(x + (barWidth * i) / 10, y);
            ctx.lineTo(x + (barWidth * i) / 10, y + barHeight);
            ctx.stroke();
        }
        ctx.restore();
        roundedRect(ctx, x, y, barWidth, barHeight, 8);
        ctx.strokeStyle = refueling ? 'rgba(120, 255, 190, 0.9)' : 'rgba(101, 223, 205, 0.4)';
        ctx.lineWidth = refueling ? 2 : 1;
        ctx.stroke();

        ctx.textAlign = 'left';
        ctx.fillStyle = critical ? '#ff6a5a' : '#eaf6ff';
        ctx.font = `700 20px ${MONO}`;
        ctx.fillText(`${Math.round(fuel.percent)}%`, x + barWidth + 14, y + barHeight / 2);

        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(160, 200, 230, 0.7)';
        ctx.font = `600 10px ${MONO}`;
        ctx.fillText('E', x + 6, y + barHeight + 12);
        ctx.fillText('F', x + barWidth - 6, y + barHeight + 12);

        if (critical && pulse > 0.4) {
            ctx.fillStyle = '#ff5a4a';
            ctx.font = `800 13px ${MONO}`;
            ctx.fillText(fuel.isEmpty ? 'ENGINE OUT' : 'LOW FUEL', VIEW_WIDTH / 2, y - 12);
        } else if (refueling) {
            ctx.fillStyle = '#7dffc0';
            ctx.font = `800 13px ${MONO}`;
            ctx.fillText('REFUELING +', VIEW_WIDTH / 2, y - 12);
        }
    }
}
