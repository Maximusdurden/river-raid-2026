import type { BridgeStatus } from '../systems/CollisionSystem.js';
import type { BridgeSpan } from '../world/RiverGenerator.js';

/**
 * Tracks which bridges of the (deterministic) river have been destroyed.
 * The river generator knows where bridges are; this adds the mutable part.
 * The highest-numbered destroyed bridge is the current checkpoint: that is
 * where a new jet respawns after a crash.
 */
export class BridgeRegistry implements BridgeStatus {
    private readonly destroyedSpans = new Map<number, BridgeSpan>();
    private checkpointSpan: BridgeSpan | null = null;

    isIntact(bridgeNumber: number): boolean {
        return !this.destroyedSpans.has(bridgeNumber);
    }

    isDestroyed(bridgeNumber: number): boolean {
        return this.destroyedSpans.has(bridgeNumber);
    }

    /** Destroys a bridge. Returns false (and changes nothing) if it was already destroyed. */
    destroy(span: BridgeSpan): boolean {
        if (this.destroyedSpans.has(span.number)) return false;
        this.destroyedSpans.set(span.number, span);
        if (!this.checkpointSpan || span.number > this.checkpointSpan.number) this.checkpointSpan = span;
        return true;
    }

    get destroyedCount(): number {
        return this.destroyedSpans.size;
    }

    /** The furthest destroyed bridge, or null before the first one falls. */
    get checkpoint(): BridgeSpan | null {
        return this.checkpointSpan;
    }

    /** Stage number: how many bridges lie behind the checkpoint (0 at the start). */
    get stage(): number {
        return this.checkpointSpan?.number ?? 0;
    }

    /** World Y where a new jet appears: just past the checkpoint bridge, or the start line. */
    respawnY(startY: number, margin: number): number {
        return this.checkpointSpan ? this.checkpointSpan.topY + margin : startY;
    }

    reset(): void {
        this.destroyedSpans.clear();
        this.checkpointSpan = null;
    }
}
