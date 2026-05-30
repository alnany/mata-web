/**
 * Pure DM de-duplication decision.
 *
 * "If a room already exists with another user, don't open a duplicate —
 * take the user to the existing room." The matching policy lives here as a
 * pure function so it is unit-testable in isolation; the worker maps live
 * matrix-js-sdk rooms into `DedupRoom` and delegates.
 *
 * Policy (in priority order):
 *  1. `m.direct` account-data is authoritative — it's how every Matrix
 *     client buckets DMs. The first room there that we're still in
 *     (joined or invited) wins.
 *  2. Fallback scan for a room the *other* side may have opened: an exact
 *     two-person joined room that contains the target, has no explicit
 *     name (real DMs are nameless), and where the target hasn't left.
 *
 * Rooms we've left or been banned from, named rooms, and rooms with more
 * than two members are never matched.
 */

export type Membership = 'join' | 'invite' | 'leave' | 'ban' | 'knock' | string;

export interface DedupRoom {
  roomId: string;
  myMembership: Membership;
  /** Total invited + joined members. A 1:1 DM is exactly 2. */
  memberCount: number;
  /** Explicit room name (m.room.name), if any. DMs are nameless. */
  name?: string | null;
  /** Membership of the target user in this room, or null if not a member. */
  targetMembership?: Membership | null;
}

/**
 * @param target          MXID of the person being messaged.
 * @param directRoomIds   roomIds listed under `m.direct[target]` (authoritative).
 * @param rooms           all rooms known to the client (for the fallback scan).
 * @returns the roomId to open, or null if a fresh room must be created.
 */
export function pickExistingDirectRoom(
  target: string,
  directRoomIds: readonly string[],
  rooms: readonly DedupRoom[],
): string | null {
  const byId = new Map(rooms.map((r) => [r.roomId, r]));
  const present = (m: Membership | null | undefined): boolean =>
    m === 'join' || m === 'invite';

  // 1) m.direct, authoritative — preserve list order.
  for (const id of directRoomIds) {
    const room = byId.get(id);
    if (!room) continue;
    if (present(room.myMembership)) return id;
  }

  // 2) Fallback: an exact two-person, nameless, joined room with the target.
  for (const room of rooms) {
    if (room.myMembership !== 'join') continue;
    if (room.memberCount !== 2) continue;
    if (room.name && room.name.trim().length > 0) continue;
    if (!present(room.targetMembership ?? null)) continue;
    return room.roomId;
  }

  return null;
}
