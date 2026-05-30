import { describe, expect, it } from 'vitest';
import { highlightSegments } from './search-highlight.js';

const join = (segs: { text: string }[]) => segs.map((s) => s.text).join('');

describe('highlightSegments', () => {
  it('marks a single case-insensitive match and preserves original casing', () => {
    const segs = highlightSegments('Hello World', 'world');
    expect(segs).toEqual([
      { text: 'Hello ', match: false },
      { text: 'World', match: true },
    ]);
    expect(join(segs)).toBe('Hello World');
  });

  it('marks every occurrence', () => {
    const segs = highlightSegments('ababab', 'ab');
    expect(segs.filter((s) => s.match).length).toBe(3);
    expect(join(segs)).toBe('ababab');
  });

  it('handles a match at the very start and end', () => {
    expect(highlightSegments('abc', 'abc')).toEqual([{ text: 'abc', match: true }]);
  });

  it('returns the whole string unmatched when query is empty/whitespace', () => {
    expect(highlightSegments('hello', '   ')).toEqual([{ text: 'hello', match: false }]);
  });

  it('returns the whole string unmatched when there is no hit', () => {
    expect(highlightSegments('hello', 'zzz')).toEqual([{ text: 'hello', match: false }]);
  });

  it('returns empty for empty text', () => {
    expect(highlightSegments('', 'x')).toEqual([]);
  });

  it('never drops or duplicates characters (round-trips) with adjacent matches', () => {
    const text = 'fooBARfooBARbaz';
    const segs = highlightSegments(text, 'bar');
    expect(join(segs)).toBe(text);
  });
});
