import * as vscode from 'vscode';
import type { EditPatch, EditPatchRelayPayload } from '@codemeet/shared';
import type { TypedSocket } from '../ConnectionManager.js';
import { EditDetector } from './EditDetector.js';
import { PatchApplicator } from './PatchApplicator.js';

/**
 * Coordinates edit detection, patch sending, and remote patch application.
 * Uses Socket.IO relay as transport (will be replaced by WebRTC DataChannel in Phase 5).
 */
export class EditSyncService implements vscode.Disposable {
  private detector: EditDetector;
  private applicator: PatchApplicator;
  private socket: TypedSocket | null = null;
  private roomId: string | null = null;
  private disposables: vscode.Disposable[] = [];

  /** Debounce timer for batching rapid keystrokes (50ms). */
  private pendingPatches: EditPatch[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(userId: string) {
    this.detector = new EditDetector(userId);
    this.applicator = new PatchApplicator();

    // When local edits happen, queue and send
    this.disposables.push(
      this.detector.onPatch((patch) => {
        this.queuePatch(patch);
      }),
    );
  }

  /** Start syncing edits for a room. */
  start(socket: TypedSocket, roomId: string): void {
    this.socket = socket;
    this.roomId = roomId;

    // Listen for incoming remote patches
    socket.on('edit-patch', (data: EditPatchRelayPayload) => {
      if (data.roomId === this.roomId) {
        this.handleRemotePatch(data.patch);
      }
    });
  }

  /** Stop syncing. */
  stop(): void {
    this.flushPending();
    this.socket = null;
    this.roomId = null;
  }

  private queuePatch(patch: EditPatch): void {
    this.pendingPatches.push(patch);

    // Debounce: flush after 50ms of no new patches
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flushPending(), 50);
  }

  private flushPending(): void {
    if (!this.socket || !this.roomId || this.pendingPatches.length === 0) return;

    for (const patch of this.pendingPatches) {
      this.socket.emit('edit-patch', {
        roomId: this.roomId,
        patch,
      });
    }
    this.pendingPatches = [];
    this.flushTimer = null;
  }

  private async handleRemotePatch(patch: EditPatch): Promise<void> {
    // Skip stale patches (OT-lite: last-writer-wins)
    const localRev = this.detector.getRev(patch.file);
    if (localRev > patch.rev) {
      // Stale patch — log but don't apply
      console.log(
        `[EditSync] Skipping stale patch for ${patch.file}: local rev ${localRev} > patch rev ${patch.rev}`,
      );
      return;
    }

    // Apply with suppression so it doesn't re-broadcast
    await this.applicator.apply(patch, async (file, fn) => {
      this.detector.suppressedFiles.add(file);
      try {
        await fn();
      } finally {
        // Small delay to ensure the change event has fired before unsuppressing
        setTimeout(() => {
          this.detector.suppressedFiles.delete(file);
        }, 100);
      }
    });

    // Update local rev to track this patch
    this.detector.setRev(patch.file, patch.rev);
  }

  dispose(): void {
    this.stop();
    this.detector.dispose();
    this.applicator.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
