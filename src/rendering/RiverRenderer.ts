import { Mulberry32, hashToUnit } from '../core/PRNG.js';
import type { BridgeSpan, RiverGenerator, RiverSlice } from '../world/RiverGenerator.js';

/** Logical (internal) resolution: 4:3 arcade viewport. Scaled to the display by CSS. */
export const VIEW_WIDTH = 960;
export const VIEW_HEIGHT = 720;

/**
 * What the simulation exposes for drawing: the last two fixed-step states. The
 * renderer blends them with `alpha` so motion stays smooth at any refresh rate.
 */
export interface RenderState {
    previousCameraY: number;
    cameraY: number;
    /** Simulation time in seconds (drives water animation). */
    previousTime: number;
    time: number;
    /** True while the simulation is frozen for any reason (rendering continues). */
    paused: boolean;
    /**
     * True only when the player paused. A menu holding the pause is not announced on the
     * canvas. Defaults to `paused` when absent.
     */
    userPaused?: boolean;
}

export interface RiverRendererOptions {
    /** Draw the dashed player line and bank markers (debug aid). */
    showGuides: boolean;
    /** Distance of the player line above the bottom of the view, in world units. */
    playerLineOffset: number;
}

const TILE_SIZE = 256;
const MAX_BACKING_WIDTH = 3840;

interface FlowLayer {
    id: number;
    spacing: number;
    /** World units per second, positive = up the screen (against the scroll). */
    speed: number;
    waveSpeed: number;
    amplitude: number;
    minLength: number;
    maxLength: number;
    lineWidth: number;
    color: string;
}

const FLOW_LAYERS: readonly FlowLayer[] = [
    { id: 11, spacing: 38, speed: 16, waveSpeed: 1.2, amplitude: 2.2, minLength: 70, maxLength: 200, lineWidth: 1.4, color: 'rgba(140, 215, 240, 0.12)' },
    { id: 23, spacing: 23, speed: 34, waveSpeed: 2.0, amplitude: 1.5, minLength: 40, maxLength: 120, lineWidth: 1.1, color: 'rgba(190, 235, 250, 0.10)' },
];

type TileKind = 'grass' | 'island';

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

function clamp01(value: number): number {
    return value < 0 ? 0 : value > 1 ? 1 : value;
}

export class RiverRenderer {
    readonly options: RiverRendererOptions;

    private readonly canvas: HTMLCanvasElement;
    private readonly ctx: CanvasRenderingContext2D;
    private world: RiverGenerator;
    private readonly visible: RiverSlice[] = [];
    private readonly resizeObserver: ResizeObserver | null;
    private scale = 1;
    private grassPattern: CanvasPattern | null = null;
    private islandPattern: CanvasPattern | null = null;
    private readonly waterGradient: CanvasGradient;
    private readonly hazeGradient: CanvasGradient;

    /** Decides whether a bridge is drawn intact or as ruins. Set by the game layer. */
    isBridgeDestroyed: (bridgeNumber: number) => boolean = () => false;

    constructor(canvas: HTMLCanvasElement, world: RiverGenerator, options: Partial<RiverRendererOptions> = {}) {
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('Canvas 2D context is not available.');
        this.canvas = canvas;
        this.ctx = context;
        this.world = world;
        this.assertWorld(world);
        this.options = { showGuides: false, playerLineOffset: 180, ...options };

        this.waterGradient = context.createLinearGradient(0, 0, 0, VIEW_HEIGHT);
        this.waterGradient.addColorStop(0, '#05304d');
        this.waterGradient.addColorStop(1, '#0a4a74');
        this.hazeGradient = context.createLinearGradient(0, 0, 0, 240);
        this.hazeGradient.addColorStop(0, 'rgba(4, 10, 22, 0.6)');
        this.hazeGradient.addColorStop(1, 'rgba(4, 10, 22, 0)');

        this.resize();
        this.resizeObserver = typeof ResizeObserver === 'function'
            ? new ResizeObserver(() => this.resize())
            : null;
        this.resizeObserver?.observe(canvas);
    }

    /** The 2D context, so layers drawn on top (game entities, HUD) share the canvas. */
    get context(): CanvasRenderingContext2D {
        return this.ctx;
    }

    /** Backing-store pixels per logical unit; apply as the base transform before drawing. */
    get pixelScale(): number {
        return this.scale;
    }

    setWorld(world: RiverGenerator): void {
        this.assertWorld(world);
        this.world = world;
    }

    destroy(): void {
        this.resizeObserver?.disconnect();
    }

    /**
     * Matches the backing store to the displayed size and device pixel ratio so lines
     * stay crisp. All drawing uses the fixed 960x720 logical space regardless.
     */
    resize(): void {
        const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
        const cssWidth = this.canvas.clientWidth || VIEW_WIDTH;
        const width = Math.min(MAX_BACKING_WIDTH, Math.max(1, Math.round(cssWidth * dpr)));
        const height = Math.max(1, Math.round((width * VIEW_HEIGHT) / VIEW_WIDTH));
        if (this.canvas.width !== width || this.canvas.height !== height || !this.grassPattern) {
            this.canvas.width = width;
            this.canvas.height = height;
            this.scale = width / VIEW_WIDTH;
            this.grassPattern = this.buildPattern('grass');
            this.islandPattern = this.buildPattern('island');
        }
    }

    /** Draws one frame. `alpha` in [0, 1] blends previous -> current simulation state. */
    render(state: RenderState, alpha: number): void {
        const a = clamp01(Number.isFinite(alpha) ? alpha : 1);
        const camY = lerp(state.previousCameraY, state.cameraY, a);
        const time = lerp(state.previousTime, state.time, a);
        const ctx = this.ctx;
        const world = this.world;

        ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';

        // Visible slices, bottom to top (one spare on each side for clean edges).
        const h = world.config.sliceHeight;
        const first = Math.floor(camY / h) - 1;
        const last = Math.ceil((camY + VIEW_HEIGHT) / h) + 1;
        this.visible.length = 0;
        for (let i = first; i <= last; i++) this.visible.push(world.getSlice(i));
        const sy = (slice: RiverSlice): number => VIEW_HEIGHT - (slice.worldY - camY);

        // Paths shared by the layers below.
        const water = new Path2D();
        const banks = new Path2D();
        let started = false;
        for (const slice of this.visible) {
            const y = sy(slice);
            if (started) {
                water.lineTo(slice.leftBankX, y);
                banks.lineTo(slice.leftBankX, y);
            } else {
                water.moveTo(slice.leftBankX, y);
                banks.moveTo(slice.leftBankX, y);
                started = true;
            }
        }
        started = false;
        for (let j = this.visible.length - 1; j >= 0; j--) {
            const slice = this.visible[j];
            if (!slice) continue;
            const y = sy(slice);
            water.lineTo(slice.rightBankX, y);
            if (started) {
                banks.lineTo(slice.rightBankX, y);
            } else {
                banks.moveTo(slice.rightBankX, y);
                started = true;
            }
        }
        water.closePath();

        // 1. Land, textured and anchored to the world so it scrolls with it.
        const textureShift = (((VIEW_HEIGHT + camY) % TILE_SIZE) + TILE_SIZE) % TILE_SIZE;
        this.fillTextured(this.grassPattern, '#2c5530', textureShift);

        // 2. Grass verge and beach, drawn on the land side of the shoreline. The water
        //    fill below hides the half of each stroke that falls inside the river.
        ctx.strokeStyle = 'rgba(78, 128, 64, 0.55)';
        ctx.lineWidth = 78;
        ctx.stroke(banks);
        ctx.strokeStyle = 'rgba(112, 150, 78, 0.65)';
        ctx.lineWidth = 42;
        ctx.stroke(banks);
        ctx.strokeStyle = 'rgba(190, 172, 120, 0.95)';
        ctx.lineWidth = 17;
        ctx.stroke(banks);

        // 3. Water, with flow lines and shoreline shading clipped to it.
        ctx.fillStyle = this.waterGradient;
        ctx.fill(water);
        ctx.save();
        ctx.clip(water);
        this.drawFlowLines(camY, time);
        ctx.strokeStyle = 'rgba(2, 14, 28, 0.26)';
        ctx.lineWidth = 56;
        ctx.stroke(banks);
        ctx.strokeStyle = 'rgba(2, 14, 28, 0.2)';
        ctx.lineWidth = 28;
        ctx.stroke(banks);
        ctx.strokeStyle = 'rgba(110, 205, 215, 0.2)';
        ctx.lineWidth = 12;
        ctx.stroke(banks);
        ctx.strokeStyle = `rgba(225, 246, 250, ${(0.4 + 0.12 * Math.sin(time * 2.1)).toFixed(3)})`;
        ctx.lineWidth = 3.5;
        ctx.stroke(banks);
        ctx.restore();

        // 4. Islands.
        this.drawIslands(camY, textureShift);

        // 5. Bridges.
        for (const span of world.findBridges(camY - 64, camY + VIEW_HEIGHT + 64)) {
            if (this.isBridgeDestroyed(span.number)) this.drawBridgeRuins(span, camY);
            else this.drawBridge(span, camY);
        }

        // 6. Atmosphere and optional guides.
        ctx.fillStyle = this.hazeGradient;
        ctx.fillRect(0, 0, VIEW_WIDTH, 240);
        if (this.options.showGuides) this.drawGuides(camY);
    }

    // ------------------------------------------------------------- internals

    private assertWorld(world: RiverGenerator): void {
        if (world.config.worldWidth !== VIEW_WIDTH) {
            throw new RangeError(`RiverRenderer requires worldWidth === ${VIEW_WIDTH}.`);
        }
    }

    private fillTextured(pattern: CanvasPattern | null, fallback: string, shift: number): void {
        const ctx = this.ctx;
        ctx.save();
        ctx.translate(0, shift);
        ctx.fillStyle = pattern ?? fallback;
        ctx.fillRect(0, -TILE_SIZE, VIEW_WIDTH, VIEW_HEIGHT + TILE_SIZE * 2);
        ctx.restore();
    }

    private drawFlowLines(camY: number, time: number): void {
        const ctx = this.ctx;
        const seed = this.world.seed;
        for (const layer of FLOW_LAYERS) {
            const drift = time * layer.speed;
            const lowRow = Math.floor((camY - drift) / layer.spacing) - 1;
            const highRow = Math.ceil((camY + VIEW_HEIGHT - drift) / layer.spacing) + 1;
            ctx.strokeStyle = layer.color;
            ctx.lineWidth = layer.lineWidth;
            ctx.beginPath();
            for (let row = lowRow; row <= highRow; row++) {
                const rowY = VIEW_HEIGHT - (row * layer.spacing + drift - camY);
                const segments = 1 + Math.floor(hashToUnit(seed, layer.id, row) * 2);
                for (let s = 0; s < segments; s++) {
                    const u0 = hashToUnit(seed, layer.id * 131 + s, row);
                    const u1 = hashToUnit(seed, layer.id * 131 + s + 17, row);
                    const x0 = u0 * (VIEW_WIDTH - 60);
                    const length = lerp(layer.minLength, layer.maxLength, u1);
                    const phase = u0 * Math.PI * 2;
                    for (let x = x0; x <= x0 + length; x += 14) {
                        const y = rowY + Math.sin(x * 0.035 + time * layer.waveSpeed + phase) * layer.amplitude;
                        if (x === x0) ctx.moveTo(x, y);
                        else ctx.lineTo(x, y);
                    }
                }
            }
            ctx.stroke();
        }
    }

    private drawIslands(camY: number, textureShift: number): void {
        const visible = this.visible;
        let runStart = -1;
        for (let j = 0; j <= visible.length; j++) {
            const slice = visible[j];
            const branching = slice?.isBranching ?? false;
            if (branching && runStart < 0) runStart = j;
            if (!branching && runStart >= 0) {
                // Include the zero-width slices on either side so the tips close.
                this.drawIsland(Math.max(0, runStart - 1), Math.min(visible.length - 1, j), camY, textureShift);
                runStart = -1;
            }
        }
    }

    private drawIsland(from: number, to: number, camY: number, textureShift: number): void {
        const ctx = this.ctx;
        const path = new Path2D();
        for (let j = from; j <= to; j++) {
            const slice = this.visible[j];
            if (!slice) continue;
            const y = VIEW_HEIGHT - (slice.worldY - camY);
            if (j === from) path.moveTo(slice.islandLeftX, y);
            else path.lineTo(slice.islandLeftX, y);
        }
        for (let j = to; j >= from; j--) {
            const slice = this.visible[j];
            if (!slice) continue;
            path.lineTo(slice.islandRightX, VIEW_HEIGHT - (slice.worldY - camY));
        }
        path.closePath();

        ctx.strokeStyle = 'rgba(1, 12, 24, 0.32)';
        ctx.lineWidth = 34;
        ctx.stroke(path);
        ctx.strokeStyle = 'rgba(110, 205, 215, 0.25)';
        ctx.lineWidth = 20;
        ctx.stroke(path);
        ctx.strokeStyle = '#d8c690';
        ctx.lineWidth = 14;
        ctx.stroke(path);
        ctx.save();
        ctx.clip(path);
        ctx.translate(0, textureShift);
        ctx.fillStyle = this.islandPattern ?? '#7a7a45';
        ctx.fillRect(0, -TILE_SIZE, VIEW_WIDTH, VIEW_HEIGHT + TILE_SIZE * 2);
        ctx.restore();
        ctx.strokeStyle = 'rgba(70, 60, 30, 0.55)';
        ctx.lineWidth = 2;
        ctx.stroke(path);
    }

    private drawBridge(span: BridgeSpan, camY: number): void {
        const ctx = this.ctx;
        const top = VIEW_HEIGHT - (span.topY - camY);
        const height = span.topY - span.bottomY;
        const sample = this.world.sample(span.centerY);

        // Cast shadow on the water and land beneath.
        ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
        ctx.fillRect(8, top + 12, VIEW_WIDTH, height);

        // Concrete abutments where the deck meets the banks.
        ctx.fillStyle = '#4a505c';
        ctx.fillRect(sample.leftBankX - 30, top - 4, 44, height + 8);
        ctx.fillRect(sample.rightBankX - 14, top - 4, 44, height + 8);

        // Deck.
        const deck = ctx.createLinearGradient(0, top, 0, top + height);
        deck.addColorStop(0, '#9aa3b4');
        deck.addColorStop(0.5, '#7b8494');
        deck.addColorStop(1, '#5d6574');
        ctx.fillStyle = deck;
        ctx.fillRect(0, top, VIEW_WIDTH, height);

        // Expansion joints.
        ctx.strokeStyle = 'rgba(30, 36, 48, 0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = 32; x < VIEW_WIDTH; x += 64) {
            ctx.moveTo(x, top);
            ctx.lineTo(x, top + height);
        }
        ctx.stroke();

        // Guard rails.
        ctx.fillStyle = '#c9d1de';
        ctx.fillRect(0, top, VIEW_WIDTH, 3);
        ctx.fillStyle = '#3f4552';
        ctx.fillRect(0, top + height - 3, VIEW_WIDTH, 3);

        // Centre line.
        ctx.strokeStyle = '#f2c94c';
        ctx.lineWidth = 2;
        ctx.setLineDash([18, 14]);
        ctx.beginPath();
        ctx.moveTo(0, top + height / 2);
        ctx.lineTo(VIEW_WIDTH, top + height / 2);
        ctx.stroke();
        ctx.setLineDash([]);

        // Hazard stripes on the abutments.
        ctx.fillStyle = '#f2c94c';
        for (const x of [sample.leftBankX - 30, sample.rightBankX - 14]) {
            for (let y = top; y < top + height; y += 12) ctx.fillRect(x, y, 6, 6);
        }
    }

    /** What is left of a destroyed bridge: charred abutments, broken stubs over land, rubble in the water. */
    private drawBridgeRuins(span: BridgeSpan, camY: number): void {
        const ctx = this.ctx;
        const seed = this.world.seed;
        const top = VIEW_HEIGHT - (span.topY - camY);
        const height = span.topY - span.bottomY;
        const sample = this.world.sample(span.centerY);
        const rand = (k: number): number => hashToUnit(seed, 0xb71d0000 + span.number, k);

        // Deck stubs over each bank with a jagged broken end.
        const stub = (fromX: number, toX: number, jaggedAtEnd: boolean): void => {
            const deck = ctx.createLinearGradient(0, top, 0, top + height);
            deck.addColorStop(0, '#6c7380');
            deck.addColorStop(1, '#434a57');
            ctx.fillStyle = deck;
            ctx.beginPath();
            ctx.moveTo(fromX, top);
            ctx.lineTo(toX, top);
            const steps = 6;
            for (let i = 0; i <= steps; i++) {
                const jag = (rand(i + (jaggedAtEnd ? 0 : 20)) - 0.5) * 22;
                ctx.lineTo(toX + jag, top + (height * i) / steps);
            }
            ctx.lineTo(fromX, top + height);
            ctx.closePath();
            ctx.fill();
            ctx.fillStyle = 'rgba(8, 6, 4, 0.45)';
            ctx.fill();
        };
        stub(0, sample.leftBankX - 34, true);
        stub(VIEW_WIDTH, sample.rightBankX + 34, false);

        // Abutments, scorched.
        ctx.fillStyle = '#2f343d';
        ctx.fillRect(sample.leftBankX - 30, top - 2, 44, height + 4);
        ctx.fillRect(sample.rightBankX - 14, top - 2, 44, height + 4);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
        ctx.fillRect(sample.leftBankX - 30, top - 2, 44, height + 4);
        ctx.fillRect(sample.rightBankX - 14, top - 2, 44, height + 4);

        // Rubble and floating wreckage in the river.
        const width = sample.rightBankX - sample.leftBankX;
        for (let i = 0; i < 22; i++) {
            const x = sample.leftBankX + 10 + rand(100 + i) * Math.max(1, width - 20);
            const y = top - 6 + rand(200 + i) * (height + 12);
            const size = 2 + rand(300 + i) * 5;
            ctx.fillStyle = i % 3 === 0 ? 'rgba(20, 22, 28, 0.85)' : 'rgba(70, 76, 88, 0.8)';
            ctx.fillRect(x, y, size * 1.6, size);
        }
        ctx.fillStyle = 'rgba(2, 10, 20, 0.25)';
        ctx.fillRect(sample.leftBankX, top - 10, width, height + 20);
    }

    private drawGuides(camY: number): void {
        const ctx = this.ctx;
        const worldY = camY + this.options.playerLineOffset;
        const y = VIEW_HEIGHT - this.options.playerLineOffset;
        const sample = this.world.sample(worldY);
        ctx.save();
        ctx.strokeStyle = 'rgba(255, 220, 120, 0.7)';
        ctx.lineWidth = 1;
        ctx.setLineDash([10, 8]);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(VIEW_WIDTH, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(255, 220, 120, 0.95)';
        for (const x of [sample.leftBankX, sample.rightBankX]) {
            ctx.fillRect(x - 2, y - 9, 4, 18);
        }
        ctx.font = '12px ui-monospace, Consolas, monospace';
        ctx.fillText('PLAYER LINE', 8, y - 6);
        ctx.restore();
    }

    /** Builds a seamless, resolution-matched texture tile and wraps it as a pattern. */
    private buildPattern(kind: TileKind): CanvasPattern | null {
        const tile = document.createElement('canvas');
        const pixels = Math.max(1, Math.round(TILE_SIZE * this.scale));
        tile.width = pixels;
        tile.height = pixels;
        const c = tile.getContext('2d');
        if (!c) return null;
        c.scale(pixels / TILE_SIZE, pixels / TILE_SIZE);

        const rng = new Mulberry32(kind === 'grass' ? 0x6a55c3 : 0x1f9d27);
        const grass = kind === 'grass';
        c.fillStyle = grass ? '#2c5530' : '#7a7a45';
        c.fillRect(0, 0, TILE_SIZE, TILE_SIZE);

        // Draws a shape at (x, y) and at every wrapped offset so the tile repeats seamlessly.
        const wrapped = (x: number, y: number, radius: number, draw: (px: number, py: number) => void): void => {
            for (const dx of [-TILE_SIZE, 0, TILE_SIZE]) {
                for (const dy of [-TILE_SIZE, 0, TILE_SIZE]) {
                    const px = x + dx;
                    const py = y + dy;
                    if (px + radius >= 0 && px - radius <= TILE_SIZE && py + radius >= 0 && py - radius <= TILE_SIZE) {
                        draw(px, py);
                    }
                }
            }
        };

        const blotchColors = grass
            ? ['#3b6b3a', '#244a2a', '#4a7a3c', '#6a6a3a']
            : ['#8c8a4f', '#66703c', '#a09a64', '#5a6a38'];
        for (let i = 0; i < 16; i++) {
            const x = rng.range(0, TILE_SIZE);
            const y = rng.range(0, TILE_SIZE);
            const r = rng.range(26, 66);
            const color = blotchColors[rng.int(0, blotchColors.length - 1)] ?? '#3b6b3a';
            const ry = r * rng.range(0.6, 1);
            wrapped(x, y, r, (px, py) => {
                c.globalAlpha = 0.2;
                c.fillStyle = color;
                c.beginPath();
                c.ellipse(px, py, r, ry, 0, 0, Math.PI * 2);
                c.fill();
            });
        }
        c.globalAlpha = 1;

        for (let i = 0; i < 520; i++) {
            const x = rng.range(0, TILE_SIZE);
            const y = rng.range(0, TILE_SIZE);
            const light = rng.chance(0.5);
            const speckleWidth = rng.chance(0.3) ? 3 : 1.5;
            wrapped(x, y, 3, (px, py) => {
                c.fillStyle = light
                    ? (grass ? 'rgba(170, 210, 120, 0.28)' : 'rgba(235, 220, 160, 0.3)')
                    : 'rgba(0, 20, 5, 0.22)';
                c.fillRect(px, py, speckleWidth, 1.5);
            });
        }

        // Tree clusters (grass) or boulders (island), with a drop shadow for relief.
        const props = grass ? 30 : 14;
        for (let i = 0; i < props; i++) {
            const x = rng.range(0, TILE_SIZE);
            const y = rng.range(0, TILE_SIZE);
            const r = grass ? rng.range(5, 10) : rng.range(4, 9);
            wrapped(x, y, r + 5, (px, py) => {
                c.fillStyle = 'rgba(0, 0, 0, 0.3)';
                c.beginPath();
                c.arc(px + 3, py + 4, r, 0, Math.PI * 2);
                c.fill();
                c.fillStyle = grass ? '#1d4424' : '#8a8b88';
                c.beginPath();
                c.arc(px, py, r, 0, Math.PI * 2);
                c.fill();
                c.fillStyle = grass ? '#2f6a35' : '#b3b4b0';
                c.beginPath();
                c.arc(px - r * 0.3, py - r * 0.3, r * 0.55, 0, Math.PI * 2);
                c.fill();
            });
        }

        const pattern = this.ctx.createPattern(tile, 'repeat');
        // The tile has `scale` times more pixels than logical units; undo that.
        pattern?.setTransform(new DOMMatrix().scale(TILE_SIZE / pixels, TILE_SIZE / pixels));
        return pattern;
    }
}
