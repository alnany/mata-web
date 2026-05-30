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
  DeviceId,
  UserId,
} from '@mata/shared/matrix';
import { authError } from '@mata/shared/errors';
import type { SearchHit } from '@mata/shared/matrix';
import type { WebPushSubscriptionJson } from '@mata/shared/rpc';
import type { WorkerEvent } from '@mata/shared/rpc';
import type { LoggedIn, LoginInput, SdkSession } from './sdk-impl.js';
import { loadActiveSession, type SessionRecord } from './session-store.js';

type Emit = (event: WorkerEvent) => void;

export class MatrixCore {
  private emit: Emit;
  private session: SdkSession | null = null;
  // Single in-flight restore promise shared by tryRestore/restoreFrom/
  // ensureSession so a cold-boot restore and a concurrent self-heal
  // never kick off two bootClients on the same wrapper (which race the
  // crypto store + teardown). Whoever arrives first owns the boot; the
  // rest await the same promise.
  private restoring: Promise<LoggedIn> | null = null;
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
    if (this.restoring) return this.restoring;
    this.restoring = (async () => {
      const impl = await this.ensureImpl();
      if (!this.session) this.session = new impl.SdkSession(this.emit);
      return this.session.restoreFrom(record);
    })().finally(() => {
      this.restoring = null;
    });
    return this.restoring;
  }

  async logout(): Promise<void> {
    if (!this.session) return;
    await this.session.logout();
    this.session = null;
  }

  async listRoomSummaries(): Promise<RoomSummary[]> {
    return (await this.ensureSession()).listRoomSummaries();
  }

  async loadRoomHistory(
    roomId: RoomId,
    fromToken: string | null,
    limit: number,
  ): Promise<{
    events: TimelineEvent[];
    prevToken: string | null;
    readUpToEventId: string | null;
  }> {
    return (await this.ensureSession()).loadRoomHistory(roomId, fromToken, limit);
  }

  subscribeRoom(roomId: RoomId): void {
    if (this.session?.isLoggedIn()) {
      this.session.subscribeRoom(roomId);
      return;
    }
    // Worker (re)spawned without a live session — heal, then subscribe.
    void this.ensureSession()
      .then((sess) => sess.subscribeRoom(roomId))
      .catch(() => {});
  }

  unsubscribeRoom(): void {
    // Best-effort: nothing to unsubscribe if no live session.
    this.session?.unsubscribeRoom();
  }

  async sendMessage(
    roomId: RoomId,
    content: MessageBody,
    txnId: string,
    threadRoot?: EventId,
    replyTo?: { eventId: EventId; sender: UserId; body: string },
  ): Promise<void> {
    return (await this.ensureSession()).sendMessage(roomId, content, txnId, threadRoot, replyTo);
  }

  async setRoomMuted(roomId: RoomId, muted: boolean): Promise<boolean> {
    return (await this.ensureSession()).setRoomMuted(roomId, muted);
  }

  async loadThread(roomId: RoomId, threadRootId: EventId): Promise<TimelineEvent[]> {
    return (await this.ensureSession()).loadThread(roomId, threadRootId);
  }

  async sendCallEvent(
    roomId: RoomId,
    eventType: string,
    content: Record<string, unknown>,
  ): Promise<EventId> {
    return (await this.ensureSession()).sendCallEvent(roomId, eventType, content);
  }

  async getTurnServers(): Promise<import('@mata/shared/rpc').IceServer[]> {
    return (await this.ensureSession()).getTurnServers();
  }

  async searchMessages(
    query: string,
    roomId: RoomId | null,
  ): Promise<{ results: SearchHit[]; count: number; highlights: string[] }> {
    return (await this.ensureSession()).searchMessages(query, roomId);
  }

  async editMessage(
    roomId: RoomId,
    eventId: EventId,
    content: MessageBody,
    txnId: string,
  ): Promise<void> {
    return (await this.ensureSession()).editMessage(roomId, eventId, content, txnId);
  }

  async redactMessage(roomId: RoomId, eventId: EventId, reason: string | null): Promise<void> {
    return (await this.ensureSession()).redactMessage(roomId, eventId, reason);
  }

  async pinEvent(roomId: RoomId, eventId: EventId): Promise<void> {
    return (await this.ensureSession()).pinEvent(roomId, eventId);
  }

  async unpinEvent(roomId: RoomId, eventId: EventId): Promise<void> {
    return (await this.ensureSession()).unpinEvent(roomId, eventId);
  }

  async fetchEvent(roomId: RoomId, eventId: EventId): Promise<TimelineEvent | null> {
    return (await this.ensureSession()).fetchEvent(roomId, eventId);
  }

  async fetchPresence(
    userId: UserId,
  ): Promise<{ presence: 'online' | 'offline' | 'unavailable'; lastActiveAgoMs: number | null; currentlyActive: boolean | null } | null> {
    return (await this.ensureSession()).fetchPresence(userId);
  }

  async fetchProfile(
    userId: UserId,
  ): Promise<{ displayName: string | null; avatarUrl: string | null; ignored: boolean }> {
    return (await this.ensureSession()).fetchProfile(userId);
  }

  async setIgnored(userId: UserId, ignored: boolean): Promise<void> {
    return (await this.ensureSession()).setIgnored(userId, ignored);
  }

  async fetchRoomSettings(roomId: RoomId): Promise<{
    name: string;
    topic: string;
    canSetName: boolean;
    canSetTopic: boolean;
    canSetAvatar: boolean;
  }> {
    return (await this.ensureSession()).fetchRoomSettings(roomId);
  }

  async setRoomName(roomId: RoomId, name: string): Promise<void> {
    return (await this.ensureSession()).setRoomName(roomId, name);
  }

  async setRoomTopic(roomId: RoomId, topic: string): Promise<void> {
    return (await this.ensureSession()).setRoomTopic(roomId, topic);
  }

  async setRoomAvatar(roomId: RoomId, mxc: MxcUri): Promise<void> {
    return (await this.ensureSession()).setRoomAvatar(roomId, mxc);
  }

  async setMemberPowerLevel(
    roomId: RoomId,
    userId: UserId,
    powerLevel: number,
  ): Promise<void> {
    return (await this.ensureSession()).setMemberPowerLevel(roomId, userId, powerLevel);
  }

  async fetchReadReceipts(
    roomId: RoomId,
  ): Promise<{ userId: UserId; eventId: EventId; ts: number }[]> {
    return (await this.ensureSession()).fetchReadReceipts(roomId);
  }

  async fetchEditHistory(
    roomId: RoomId,
    eventId: EventId,
  ): Promise<{ body: string; ts: number; sender: UserId }[]> {
    return (await this.ensureSession()).fetchEditHistory(roomId, eventId);
  }

  async jumpToTimestamp(roomId: RoomId, ts: number): Promise<EventId | null> {
    return (await this.ensureSession()).jumpToTimestamp(roomId, ts);
  }

  async forgetRoom(roomId: RoomId): Promise<void> {
    return (await this.ensureSession()).forgetRoom(roomId);
  }

  async setWebPusher(
    subscription: WebPushSubscriptionJson,
    gatewayUrl: string,
    appId: string,
    lang: string,
  ): Promise<void> {
    return (await this.ensureSession()).setWebPusher(subscription, gatewayUrl, appId, lang);
  }

  async removeWebPusher(endpoint: string, appId: string): Promise<void> {
    return (await this.ensureSession()).removeWebPusher(endpoint, appId);
  }

  async sendReaction(roomId: RoomId, eventId: EventId, key: string): Promise<void> {
    return (await this.ensureSession()).sendReaction(roomId, eventId, key);
  }

  async sendTyping(roomId: RoomId, timeoutMs: number): Promise<void> {
    return (await this.ensureSession()).sendTyping(roomId, timeoutMs);
  }

  async sendReadReceipt(roomId: RoomId, eventId: EventId): Promise<void> {
    return (await this.ensureSession()).sendReadReceipt(roomId, eventId);
  }

  async markRoomRead(roomId: RoomId): Promise<void> {
    return (await this.ensureSession()).markRoomRead(roomId);
  }

  async uploadMedia(data: ArrayBuffer, mime: string, filename: string): Promise<MxcUri> {
    return (await this.ensureSession()).uploadMedia(data, mime, filename);
  }

  async sendFileMessage(args: Parameters<SdkSession['sendFileMessage']>[0]) {
    return (await this.ensureSession()).sendFileMessage(args);
  }

  async loadMedia(args: Parameters<SdkSession['loadMedia']>[0]) {
    return (await this.ensureSession()).loadMedia(args);
  }

  async createRoom(args: Parameters<SdkSession['createRoom']>[0]) {
    return (await this.ensureSession()).createRoom(args);
  }

  async inviteToRoom(roomId: RoomId, userId: UserId) {
    return (await this.ensureSession()).inviteToRoom(roomId, userId);
  }

  async forwardEvent(sourceRoomId: RoomId, sourceEventId: EventId, targetRoomId: RoomId) {
    return (await this.ensureSession()).forwardEvent(sourceRoomId, sourceEventId, targetRoomId);
  }

  async joinRoom(roomId: RoomId) {
    return (await this.ensureSession()).joinRoom(roomId);
  }

  async leaveRoom(roomId: RoomId) {
    return (await this.ensureSession()).leaveRoom(roomId);
  }

  async loadRoomMembers(roomId: RoomId) {
    return (await this.ensureSession()).loadRoomMembers(roomId);
  }

  async kickFromRoom(roomId: RoomId, userId: UserId, reason: string | null) {
    return (await this.ensureSession()).kickFromRoom(roomId, userId, reason);
  }

  async banFromRoom(roomId: RoomId, userId: UserId, reason: string | null) {
    return (await this.ensureSession()).banFromRoom(roomId, userId, reason);
  }

  async unbanFromRoom(roomId: RoomId, userId: UserId) {
    return (await this.ensureSession()).unbanFromRoom(roomId, userId);
  }

  async fetchBannedMembers(roomId: RoomId) {
    return (await this.ensureSession()).fetchBannedMembers(roomId);
  }

  async beginDeviceVerification(userId: UserId, deviceId: DeviceId) {
    return (await this.ensureSession()).beginDeviceVerification(userId, deviceId);
  }

  async completeSasVerification(transactionId: string, result: 'match' | 'mismatch') {
    return (await this.ensureSession()).completeSasVerification(transactionId, result);
  }

  async cancelVerification(transactionId: string) {
    return (await this.ensureSession()).cancelVerification(transactionId);
  }

  // --- Phase 5.2 encryption setup -------------------------------------------

  async getEncryptionStatus() {
    return (await this.ensureSession()).getEncryptionStatus();
  }

  async listDevices() {
    return (await this.ensureSession()).listDevices();
  }

  async fetchUserDevices(userId: string) {
    return (await this.ensureSession()).fetchUserDevices(userId);
  }

  async enableKeyBackup(password: string, passphrase: string) {
    return (await this.ensureSession()).enableKeyBackup(password, passphrase);
  }

  async restoreKeyBackup(recoveryKey: string) {
    return (await this.ensureSession()).restoreKeyBackup(recoveryKey);
  }

  // --- Link previews + user directory ---------------------------------------

  /**
   * Server-side OG fetch via `/_matrix/media/v3/preview_url`. Returns
   * null when the homeserver can't produce metadata (404, opaque
   * URL, admin-locked endpoint, etc.) so the UI falls back to plain
   * text without a noisy toast.
   */
  async getUrlPreview(url: string) {
    return (await this.ensureSession()).getUrlPreview(url);
  }

  /**
   * Type-leak accessor for the matrix-js-sdk client instance held
   * privately inside `SdkSession`. We need this so sibling modules
   * (e.g. `user-search.ts`) can run one-shot client methods without
   * SdkSession itself growing — sdk-impl.ts is intentionally frozen
   * at the moment due to a pipeline upload constraint. `private` is
   * compile-time only in TypeScript, so this cast is safe at runtime
   * and limited to this single seam.
   */
  getMatrixClient(): unknown {
    const session = this.session as unknown as { client?: unknown } | null;
    return session?.client ?? null;
  }

  /**
   * Like getMatrixClient but waits briefly for the client to finish
   * booting instead of returning null mid-login. Used by user-search
   * so the first lookup right after a cold load / refresh doesn't come
   * back silently empty just because /sync hadn't settled yet.
   */
  async getMatrixClientReady(): Promise<unknown> {
    const session = this.session as unknown as {
      waitForClient?: () => Promise<unknown>;
      client?: unknown;
    } | null;
    if (!session) return null;
    if (typeof session.waitForClient === 'function') {
      try {
        return await session.waitForClient();
      } catch {
        return null;
      }
    }
    return session.client ?? null;
  }

  /**
   * Resolve a live, logged-in session — healing a lost one on the way.
   *
   * `isLoggedIn()` is `client !== null`, so this returns immediately on the
   * happy path and otherwise re-restores from the persisted record. This is
   * the OUTER companion to SdkSession.waitForClient(): the outer layer
   * recreates the session wrapper + client when the whole worker was torn
   * down; the inner layer covers a momentarily-null client on a live
   * wrapper. Together they close the Safari "Not logged in" class for every
   * RPC. Only a genuinely logged-out user (no persisted record) still errors.
   */
  private async ensureSession(): Promise<SdkSession> {
    if (this.session?.isLoggedIn()) return this.session;
    // A restore may already be in flight (cold boot, or another RPC's heal).
    if (this.restoring) {
      try {
        await this.restoring;
      } catch {
        /* fall through and retry below */
      }
      if (this.session?.isLoggedIn()) return this.session;
    }
    const record = await loadActiveSession();
    if (!record) throw authError('Not logged in');
    await this.restoreFrom(record);
    if (!this.session?.isLoggedIn()) throw authError('Not logged in');
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
