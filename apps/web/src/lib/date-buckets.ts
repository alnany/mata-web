/**
 * Date utilities for day separators + relative timestamps in the room list.
 */

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function isSameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

/** Human label for a day-separator: "Today" / "Yesterday" / "May 25, 2026". */
export function dayLabel(ts: number, now = Date.now()): string {
  const today = startOfDay(now);
  const day = startOfDay(ts);
  if (day === today) return 'Today';
  if (day === today - ONE_DAY_MS) return 'Yesterday';
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
  });
}

/** Short time for message bubble footer: "14:32". */
export function shortTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Compact relative label for the room list right-side: "14:32", "Mon", "May 25". */
export function listTime(ts: number, now = Date.now()): string {
  if (!ts) return '';
  const today = startOfDay(now);
  const day = startOfDay(ts);
  const d = new Date(ts);
  if (day === today) return shortTime(ts);
  const oneWeekAgo = today - 6 * ONE_DAY_MS;
  if (day >= oneWeekAgo) {
    return d.toLocaleDateString(undefined, { weekday: 'short' });
  }
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : '2-digit',
  });
}
