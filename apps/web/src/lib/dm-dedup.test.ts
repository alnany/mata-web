import { describe, it, expect } from 'vitest';
import { pickExistingDirectRoom, type DedupRoom } from '@mata/shared/dm-dedup';

const TARGET = '@bob:server';
const room = (over: Partial<DedupRoom>): DedupRoom => ({
  roomId: '!x:server',
  myMembership: 'join',
  memberCount: 2,
  name: null,
  targetMembership: 'join',
  ...over,
});

describe('pickExistingDirectRoom — no duplicate DM rooms', () => {
  it('returns the m.direct room when we are still joined', () => {
    const r = room({ roomId: '!dm:server' });
    expect(pickExistingDirectRoom(TARGET, ['!dm:server'], [r])).toBe('!dm:server');
  });

  it('prefers m.direct order over the fallback scan', () => {
    const a = room({ roomId: '!a:server' });
    const b = room({ roomId: '!b:server' });
    expect(pickExistingDirectRoom(TARGET, ['!b:server', '!a:server'], [a, b])).toBe('!b:server');
  });

  it('skips an m.direct room we have left, then finds a live fallback', () => {
    const left = room({ roomId: '!left:server', myMembership: 'leave' });
    const live = room({ roomId: '!live:server' });
    expect(pickExistingDirectRoom(TARGET, ['!left:server'], [left, live])).toBe('!live:server');
  });

  it('matches an invite-only DM the other side opened (no m.direct yet)', () => {
    const invited = room({ roomId: '!inv:server', myMembership: 'join', targetMembership: 'invite' });
    expect(pickExistingDirectRoom(TARGET, [], [invited])).toBe('!inv:server');
  });

  it('does NOT match a named two-person room (not a DM)', () => {
    const named = room({ roomId: '!named:server', name: 'Project chat' });
    expect(pickExistingDirectRoom(TARGET, [], [named])).toBeNull();
  });

  it('does NOT match a group room with >2 members', () => {
    const group = room({ roomId: '!grp:server', memberCount: 4 });
    expect(pickExistingDirectRoom(TARGET, [], [group])).toBeNull();
  });

  it('does NOT match a room where the target already left', () => {
    const stale = room({ roomId: '!stale:server', targetMembership: 'leave' });
    expect(pickExistingDirectRoom(TARGET, [], [stale])).toBeNull();
  });

  it('returns null (create fresh) when nothing matches', () => {
    expect(pickExistingDirectRoom(TARGET, [], [])).toBeNull();
  });

  it('ignores a banned-from m.direct room and falls through to null', () => {
    const banned = room({ roomId: '!ban:server', myMembership: 'ban' });
    expect(pickExistingDirectRoom(TARGET, ['!ban:server'], [banned])).toBeNull();
  });
});
