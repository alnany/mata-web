/**
 * `MatrixCore` is the worker's single SDK seam. It defers loading the heavy
 * matrix-js-sdk + crypto-wasm modules until the first login or session
 * restore, so the worker's cold-start bundle stays under ~30 KB.
 *
 * See ADR-001 (worker boundary) and ADR-002 (SDK choice).
 */

import type {
  EventId,
  MessageBody,
  MxcUri,
  RoomId,
  RoomSummary,
  TimelineEvent,
} from '@mata/shared/matrix';
import { authError } from '@mata/shared/errors';
import type { WorkerEvent } from '@mata/shared/rpc';
import type { LoggedIn, LoginInput, SdkSession } from './sdk-impl.js';
import { loadActiveSession, type SessionRecord } from './session-store.js';

type Emit = (event: WorkerEvent) => void;

export class MatrixCore {
  private emit: Emit;
  private session: SdkSession | null = null;
  private loading: Promise<typeof import('./sdk-impl.js')> | null = null;

  constructor(emit: Emit) {
    this.emit = emit;
  }

  isLoggedIn(): boolean {
    return this.session?.isLoggedIn() ?? false;
  }

  /**
   * Diagnostic channel from main → user-visible sync log.
   *
   * The user views progress through the syncStatus event stream rendered
   * in their banner/log panel. From the main thread we cannot append to
   * that stream directly; we fire `diagLog` over the RPC and the worker
   * re-emits the note as a `diagNote` event — that flavor of event lands
   * in the same log feed but does NOT touch the sync-state pill. (Older
   * versions re-emitted as `syncStatus: 'connecting'`, which was correct
   * for the visible log but flipped the pill back to amber on every
   * phase marker even after sync reached `syncing`.)
   */
  diagLog(note: string): void {
    this.emit({ kind: 'diagNote', note });
  }

  async login(input: LoginInput): Promise<LoggedIn> {
    const impl = await this.ensureImpl();
    if (!this.session) this.session = new impl.SdkSession(this.emit);
    return this.session.login(input);
  }

  async tryRestore(): Promise<LoggedIn | null> {
    const record: SessionRecord | null = await loadActiveSession();
    if (!record) return null;
    return this.restoreFrom(record);
  }

  async restoreFrom(record: SessionRecord): Promise<LoggedIn> {
    const impl = await this.ensureImpl();
    if (!this.session) this.session = new impl.SdkSession(this.emit);
    return this.session.restoreFrom(record);
  }

  async logout(): Promise<void> {
    if (!this.session) return;
    await this.session.logout();
    this.session = null;
  }

  async listRoomSummaries(): Promise<RoomSummary[]> {
    return this.requireSession().listRoomSummaries();
  }

  async loadRoomHistory(
    roomId: RoomId,
    fromToken: string | null,
    limit: number,
  ): Promise<{ events: TimelineEvent[]; prevToken: string | null }> {
    return this.requireSession().loadRoomHistory(roomId, fromToken, limit);
  }

  async sendMessage(roomId: RoomId, content: MessageBody, txnId: string): Promise<void> {
    return this.requireSession().sendMessage(roomId, content, txnId);
  }

  async editMessage(
    roomId: RoomId,
    eventId: EventId,
    content: MessageBody,
    txnId: string,
  ): Promise<void> {
    return this.requireSession().editMessage(roomId, eventId, content, txnId);
  }

  async redactMessage(roomId: RoomId, eventId: EventId, reason: string | null): Promise<void> {
    return this.requireSession().redactMessage(roomId, eventId, reason);
  }

  async sendReaction(roomId: RoomId, eventId: EventId, key: string): Promise<void> {
    return this.requireSession().sendReaction(roomId, eventId, key);
  }

  async sendTyping(roomId: RoomId, timeoutMs: number): Promise<void> {
    return this.requireSession().sendTyping(roomId, timeoutMs);
  }

  async sendReadReceipt(roomId: RoomId, eventId: EventId): Promise<void> {
    return this.requireSession().sendReadReceipt(roomId, eventId);
  }

  async uploadMedia(data: ArrayBuffer, mime: string, filename: string): Promise<MxcUri> {
    return this.requireSession().uploadMedia(data, mime, filename);
  }

  // --- Phase 5.2 encryption setup -------------------------------------------

  async getEncryptionStatus() {
    return this.requireSession().getEncryptionStatus();
  }

  async listDevices() {
    return this.requireSession().listDevices();
  }

  async enableKeyBackup(password: string, passphrase: string) {
    return this.requireSession().enableKeyBackup(password, passphrase);
  }

  async restoreKeyBackup(recoveryKey: string) {
    return this.requireSession().restoreKeyBackup(recoveryKey);
  }

  private requireSession(): SdkSession {
    if (!this.session) throw authError('Not logged in');
    return this.session;
  }

  private ensureImpl(): Promise<typeof import('./sdk-impl.js')> {
    if (!this.loading) {
      this.loading = import('./sdk-impl.js').catch((err) => {
        this.loading = null;
        throw err;
      });
    }
    return this.loading;
  }
}

export type { LoginInput, LoggedIn };
