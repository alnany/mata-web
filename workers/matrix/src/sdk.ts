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
  ): Promise<{
    events: TimelineEvent[];
    prevToken: string | null;
    readUpToEventId: string | null;
  }> {
    return this.requireSession().loadRoomHistory(roomId, fromToken, limit);
  }

  subscribeRoom(roomId: RoomId): void {
    this.requireSession().subscribeRoom(roomId);
  }

  unsubscribeRoom(): void {
    this.requireSession().unsubscribeRoom();
  }

  async sendMessage(
    roomId: RoomId,
    content: MessageBody,
    txnId: string,
    threadRoot?: EventId,
    replyTo?: { eventId: EventId; sender: UserId; body: string },
  ): Promise<void> {
    return this.requireSession().sendMessage(roomId, content, txnId, threadRoot, replyTo);
  }

  async setRoomMuted(roomId: RoomId, muted: boolean): Promise<boolean> {
    return this.requireSession().setRoomMuted(roomId, muted);
  }

  async loadThread(roomId: RoomId, threadRootId: EventId): Promise<TimelineEvent[]> {
    return this.requireSession().loadThread(roomId, threadRootId);
  }

  async sendCallEvent(
    roomId: RoomId,
    eventType: string,
    content: Record<string, unknown>,
  ): Promise<EventId> {
    return this.requireSession().sendCallEvent(roomId, eventType, content);
  }

  async getTurnServers(): Promise<import('@mata/shared/rpc').IceServer[]> {
    return this.requireSession().getTurnServers();
  }

  async searchMessages(
    query: string,
    roomId: RoomId | null,
  ): Promise<{ results: SearchHit[]; count: number; highlights: string[] }> {
    return this.requireSession().searchMessages(query, roomId);
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

  async pinEvent(roomId: RoomId, eventId: EventId): Promise<void> {
    return this.requireSession().pinEvent(roomId, eventId);
  }

  async unpinEvent(roomId: RoomId, eventId: EventId): Promise<void> {
    return this.requireSession().unpinEvent(roomId, eventId);
  }

  async fetchEvent(roomId: RoomId, eventId: EventId): Promise<TimelineEvent | null> {
    return this.requireSession().fetchEvent(roomId, eventId);
  }

  async fetchPresence(
    userId: UserId,
  ): Promise<{ presence: 'online' | 'offline' | 'unavailable'; lastActiveAgoMs: number | null; currentlyActive: boolean | null } | null> {
    return this.requireSession().fetchPresence(userId);
  }

  async fetchProfile(
    userId: UserId,
  ): Promise<{ displayName: string | null; avatarUrl: string | null; ignored: boolean }> {
    return this.requireSession().fetchProfile(userId);
  }

  async setIgnored(userId: UserId, ignored: boolean): Promise<void> {
    return this.requireSession().setIgnored(userId, ignored);
  }

  async fetchRoomSettings(roomId: RoomId): Promise<{
    name: string;
    topic: string;
    canSetName: boolean;
    canSetTopic: boolean;
    canSetAvatar: boolean;
  }> {
    return this.requireSession().fetchRoomSettings(roomId);
  }

  async setRoomName(roomId: RoomId, name: string): Promise<void> {
    return this.requireSession().setRoomName(roomId, name);
  }

  async setRoomTopic(roomId: RoomId, topic: string): Promise<void> {
    return this.requireSession().setRoomTopic(roomId, topic);
  }

  async setRoomAvatar(roomId: RoomId, mxc: MxcUri): Promise<void> {
    return this.requireSession().setRoomAvatar(roomId, mxc);
  }

  async setMemberPowerLevel(
    roomId: RoomId,
    userId: UserId,
    powerLevel: number,
  ): Promise<void> {
    return this.requireSession().setMemberPowerLevel(roomId, userId, powerLevel);
  }

  async fetchReadReceipts(
    roomId: RoomId,
  ): Promise<{ userId: UserId; eventId: EventId; ts: number }[]> {
    return this.requireSession().fetchReadReceipts(roomId);
  }

  async forgetRoom(roomId: RoomId): Promise<void> {
    return this.requireSession().forgetRoom(roomId);
  }

  async setWebPusher(
    subscription: WebPushSubscriptionJson,
    gatewayUrl: string,
    appId: string,
    lang: string,
  ): Promise<void> {
    return this.requireSession().setWebPusher(subscription, gatewayUrl, appId, lang);
  }

  async removeWebPusher(endpoint: string, appId: string): Promise<void> {
    return this.requireSession().removeWebPusher(endpoint, appId);
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

  async markRoomRead(roomId: RoomId): Promise<void> {
    return this.requireSession().markRoomRead(roomId);
  }

  async uploadMedia(data: ArrayBuffer, mime: string, filename: string): Promise<MxcUri> {
    return this.requireSession().uploadMedia(data, mime, filename);
  }

  async sendFileMessage(args: Parameters<SdkSession['sendFileMessage']>[0]) {
    return this.requireSession().sendFileMessage(args);
  }

  async loadMedia(args: Parameters<SdkSession['loadMedia']>[0]) {
    return this.requireSession().loadMedia(args);
  }

  async createRoom(args: Parameters<SdkSession['createRoom']>[0]) {
    return this.requireSession().createRoom(args);
  }

  async inviteToRoom(roomId: RoomId, userId: UserId) {
    return this.requireSession().inviteToRoom(roomId, userId);
  }

  async forwardEvent(sourceRoomId: RoomId, sourceEventId: EventId, targetRoomId: RoomId) {
    return this.requireSession().forwardEvent(sourceRoomId, sourceEventId, targetRoomId);
  }

  async joinRoom(roomId: RoomId) {
    return this.requireSession().joinRoom(roomId);
  }

  async leaveRoom(roomId: RoomId) {
    return this.requireSession().leaveRoom(roomId);
  }

  async loadRoomMembers(roomId: RoomId) {
    return this.requireSession().loadRoomMembers(roomId);
  }

  async kickFromRoom(roomId: RoomId, userId: UserId, reason: string | null) {
    return this.requireSession().kickFromRoom(roomId, userId, reason);
  }

  async beginDeviceVerification(userId: UserId, deviceId: DeviceId) {
    return this.requireSession().beginDeviceVerification(userId, deviceId);
  }

  async completeSasVerification(transactionId: string, result: 'match' | 'mismatch') {
    return this.requireSession().completeSasVerification(transactionId, result);
  }

  async cancelVerification(transactionId: string) {
    return this.requireSession().cancelVerification(transactionId);
  }

  // --- Phase 5.2 encryption setup -------------------------------------------

  async getEncryptionStatus() {
    return this.requireSession().getEncryptionStatus();
  }

  async listDevices() {
    return this.requireSession().listDevices();
  }

  async fetchUserDevices(userId: string) {
    return this.requireSession().fetchUserDevices(userId);
  }

  async enableKeyBackup(password: string, passphrase: string) {
    return this.requireSession().enableKeyBackup(password, passphrase);
  }

  async restoreKeyBackup(recoveryKey: string) {
    return this.requireSession().restoreKeyBackup(recoveryKey);
  }

  // --- Link previews + user directory ---------------------------------------

  /**
   * Server-side OG fetch via `/_matrix/media/v3/preview_url`. Returns
   * null when the homeserver can't produce metadata (404, opaque
   * URL, admin-locked endpoint, etc.) so the UI falls back to plain
   * text without a noisy toast.
   */
  async getUrlPreview(url: string) {
    return this.requireSession().getUrlPreview(url);
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
