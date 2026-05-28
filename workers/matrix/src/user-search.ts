/**
 * One-shot user-directory search.
 *
 * Backed by the matrix-js-sdk client's `searchUserDirectory` +
 * `mxcUrlToHttp` methods, but lives outside `sdk-impl.ts` so we can
 * iterate on this feature without re-uploading the entire SDK
 * implementation file. The boundary contract from ADR-001 still
 * holds — only the worker side touches the SDK; the main thread
 * sees a normalized `UserSearchHit[]`.
 *
 * Empty term short-circuits to no round-trip. 403 (homeserver admin
 * disabled the directory) silently degrades to empty results so the
 * UI falls back to direct Matrix-ID entry without a noisy toast.
 * Limit is clamped to [1, 50] per the Synapse contract.
 */

import type { UserId } from '@mata/shared/matrix';
import type { UserSearchHit } from '@mata/shared/matrix';

interface RawDirectoryHit {
  user_id: string;
  display_name?: string;
  avatar_url?: string;
}

interface RawDirectoryResponse {
  results?: RawDirectoryHit[];
  limited?: boolean;
}

interface SearchableClient {
  searchUserDirectory(opts: { term: string; limit: number }): Promise<RawDirectoryResponse>;
  mxcUrlToHttp(
    mxc: string,
    width?: number,
    height?: number,
    method?: 'scale' | 'crop',
    allowDirectLinks?: boolean,
    allowRedirects?: boolean,
    useAuthentication?: boolean,
  ): string | null;
}

export async function searchUsers(
  client: SearchableClient | null,
  term: string,
  limit: number,
): Promise<{ results: UserSearchHit[]; limited: boolean }> {
  const trimmed = term.trim();
  if (!trimmed) return { results: [], limited: false };
  if (!client) return { results: [], limited: false };
  try {
    const raw = await client.searchUserDirectory({
      term: trimmed,
      limit: Math.max(1, Math.min(limit, 50)),
    });
    const results: UserSearchHit[] = (raw.results ?? []).map((r) => {
      let avatarUrl: string | undefined;
      if (r.avatar_url && r.avatar_url.startsWith('mxc://')) {
        const http = client.mxcUrlToHttp(r.avatar_url, 64, 64, 'crop', false, true, true);
        avatarUrl = http ?? undefined;
      } else if (r.avatar_url) {
        avatarUrl = r.avatar_url;
      }
      return {
        userId: r.user_id as UserId,
        displayName: r.display_name,
        avatarUrl,
      };
    });
    return { results, limited: !!raw.limited };
  } catch {
    // Synapse returns 403 when the homeserver admin has disabled
    // the user directory entirely. Treat that as "no matches" so
    // the UI can fall back to direct Matrix-ID entry without a
    // noisy toast.
    return { results: [], limited: false };
  }
}
