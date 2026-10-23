import { InputManager } from './InputManager.js';

function requiredElement(id: string): HTMLElement {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing demo element: ${id}`);
    return element;
}

const canvas = requiredElement('input-canvas');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Expected an input canvas.');
const context = canvas.getContext('2d');
if (!context) throw new Error('Canvas 2D is not available.');
const ctx: CanvasRenderingContext2D = context;
const fields = {
    moveX: requiredElement('move-x'),
    moveY: requiredElement('move-y'),
    fire: requiredElement('fire'),
    firePressed: requiredElement('fire-pressed'),
    pausePressed: requiredElement('pause-pressed'),
    activeDevice: requiredElement('active-device'),
};
const edgeCounts = requiredElement('edge-counts');
const focusStatus = requiredElement('focus-status');
const padStatus = requiredElement('pad-status');
const input = new InputManager({ deadzone: 0.15 });
let fireEdges = 0;
let pauseEdges = 0;
let paused = false;
let frameId = 0;
let lastStatusUpdate = -Infinity;

function frame(time: number): void {
    // Always poll, even when paused. Multiple consumers should reuse this snapshot.
    const state = input.update();
    if (state.firePressed) fireEdges++;
    if (state.pausePressed) {
        pauseEdges++;
        paused = !paused;
    }
    fields.moveX.textContent = state.moveX.toFixed(3);
    fields.moveY.textContent = state.moveY.toFixed(3);
    fields.fire.textContent = String(state.fire);
    fields.firePressed.textContent = String(state.firePressed);
    fields.pausePressed.textContent = String(state.pausePressed);
    fields.activeDevice.textContent = state.activeDevice;
    edgeCounts.textContent = `${fireEdges} / ${pauseEdges}`;
    focusStatus.textContent = document.activeElement === canvas && document.hasFocus()
        ? 'INPUT ACTIVE · Click outside to release controls.'
        : 'INPUT IDLE · Click or Tab into the flight pad to activate.';

    ctx.clearRect(0, 0, 480, 480);
    ctx.strokeStyle = '#1b3047';
    ctx.lineWidth = 1;
    for (let value = 40; value < 480; value += 40) {
        ctx.beginPath();
        ctx.moveTo(value, 0);
        ctx.lineTo(value, 480);
        ctx.moveTo(0, value);
        ctx.lineTo(480, value);
        ctx.stroke();
    }
    const x = 240 + state.moveX * 180;
    const y = 240 - state.moveY * 180;
    ctx.strokeStyle = '#65dfcd';
    ctx.beginPath();
    ctx.moveTo(240, 240);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.fillStyle = state.fire ? '#ffbc69' : '#65dfcd';
    ctx.beginPath();
    ctx.moveTo(x, y - 18);
    ctx.lineTo(x + 14, y + 14);
    ctx.lineTo(x, y + 7);
    ctx.lineTo(x - 14, y + 14);
    ctx.closePath();
    ctx.fill();
    if (state.fire) {
        ctx.strokeStyle = '#ffbc69';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(x, y - 26);
        ctx.lineTo(x, 0);
        ctx.stroke();
    }
    ctx.font = '13px system-ui';
    ctx.fillStyle = '#a7bad3';
    ctx.fillText(paused ? 'PAUSE TOGGLED · polling continues' : 'BOOST ↑ / BRAKE ↓', 20, 28);

    if (time - lastStatusUpdate > 500) {
        lastStatusUpdate = time;
        try {
            const pads = Array.from(navigator.getGamepads?.() ?? []).filter(
                (pad): pad is Gamepad => pad !== null && pad.connected,
            );
            padStatus.textContent = pads.length
                ? pads.map(pad => `${pad.id}${pad.mapping === 'standard' ? '' : ' (unsupported mapping)'}`).join(' · ')
                : 'No exposed controller. Connect one and press a button.';
        } catch {
            padStatus.textContent = 'Gamepad access blocked by browser policy. Keyboard remains available.';
        }
    }
    frameId = requestAnimationFrame(frame);
}

function start(): void {
    cancelAnimationFrame(frameId);
    input.attach(canvas);
    frameId = requestAnimationFrame(frame);
}

window.addEventListener('pagehide', () => {
    cancelAnimationFrame(frameId);
    input.destroy();
});
window.addEventListener('pageshow', start);
start();