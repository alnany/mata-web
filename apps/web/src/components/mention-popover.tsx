// =============================================================================
// MentionPopover — the floating dropdown that appears above the textarea
// when the user types `@` followed by a query.
//
// The popover does NOT own the query / open state — that's textarea-
// proximate state managed in `composer.tsx` (we need it on the same
// component that owns the keyDown handler so Enter/Tab/ArrowUp can
// be intercepted without bubbling). The popover only renders the
// candidate list and routes mouse events back up.
//
// Match rule:
//   - Normalize query and candidate (lowercased)
//   - Substring match on displayName OR userId localpart
//   - Score = "exact prefix on displayName" beats "substring"; stable
//     alphabetical as the tie-breaker so the list doesn't jitter
//     between keystrokes
//
// We hard-cap to 8 results to keep the popover bounded.
// =============================================================================

import { For, Show } from 'solid-js';
import type { RoomMember } from '@mata/shared/matrix';
import { initials, prettyName } from './message-bubble.js';

export interface MentionMatch {
  member: RoomMember;
  /** lowercased display name, cached so the renderer doesn't redo it */
  normName: string;
}

const MAX_RESULTS = 8;

/**
 * Pure function — given members and a query (without the leading '@'),
 * returns the ordered list of matches we want to show. Exported so
 * composer.tsx can call it for "active item index" math and for the
 * popover both, off the same source of truth.
 */
export function matchMembers(members: RoomMember[], query: string): MentionMatch[] {
  const q = query.toLowerCase();
  // Empty query (just `@` typed) is allowed and shows everyone; we
  // rely on the cap to keep it sane.
  const out: { member: RoomMember; normName: string; score: number }[] = [];
  for (const m of members) {
    const name = (m.displayname || m.userId).toLowerCase();
    const local = m.userId.slice(1).split(':')[0]?.toLowerCase() ?? '';
    let score: number;
    if (q.length === 0) {
      score = 2; // everyone is a "fine" match
    } else if (name.startsWith(q)) {
      score = 4;
    } else if (local.startsWith(q)) {
      score = 3;
    } else if (name.includes(q) || local.includes(q)) {
      score = 1;
    } else {
      continue;
    }
    out.push({ member: m, normName: name, score });
  }
  out.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.normName.localeCompare(b.normName);
  });
  return out.slice(0, MAX_RESULTS).map(({ member, normName }) => ({ member, normName }));
}

export function MentionPopover(props: {
  results: MentionMatch[];
  activeIndex: number;
  onPick: (m: RoomMember) => void;
  onHover: (i: number) => void;
}) {
  return (
    <Show when={props.results.length > 0}>
      <div
        class="absolute bottom-full left-0 right-0 mb-1 max-h-64 overflow-y-auto rounded-xl border border-line bg-elev shadow-lg"
        role="listbox"
      >
        <For each={props.results}>
          {(r, i) => {
            const isActive = () => i() === props.activeIndex;
            return (
              <button
                type="button"
                role="option"
                aria-selected={isActive()}
                onMouseEnter={() => props.onHover(i())}
                // Prevent textarea blur on click — otherwise the popover
                // dismisses before onClick fires.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => props.onPick(r.member)}
                class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm"
                classList={{
                  'bg-mata-50 dark:bg-mata-950/40': isActive(),
                  'hover:bg-input': !isActive(),
                }}
              >
                <span class="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-input text-[10px] font-semibold text-fg-2">
                  {initials(prettyName(r.member.userId))}
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate font-medium">
                    {r.member.displayname || prettyName(r.member.userId)}
                  </span>
                  <span class="block truncate text-[11px] text-fg-3">{r.member.userId}</span>
                </span>
              </button>
            );
          }}
        </For>
      </div>
    </Show>
  );
}
