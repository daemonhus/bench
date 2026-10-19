// Fuzzy matching for search boxes: file paths (go to file) and free text (titles, names,
// comments).

/** Path fuzzy match: all query chars must appear in order (case-insensitive). Consecutive
 *  matches, segment starts and matches near the end (the file name) score higher. */
export function fuzzyMatch(query: string, candidate: string): { match: boolean; score: number } {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  let qi = 0;
  let score = 0;
  let prevMatchIdx = -2;

  for (let ci = 0; ci < c.length && qi < q.length; ci++) {
    if (c[ci] === q[qi]) {
      // Bonus for consecutive matches
      if (ci === prevMatchIdx + 1) score += 5;
      // Bonus for match at segment boundary (after / or at start)
      if (ci === 0 || c[ci - 1] === '/') score += 10;
      // Bonus for matching near end (filename part)
      score += ci / c.length;
      prevMatchIdx = ci;
      qi++;
    }
  }

  return { match: qi === q.length, score };
}

const WORD_BREAK = /[\s/_.:\-()[\]{}"'`,;#@]/;
const isWordStart = (s: string, i: number) => i === 0 || WORD_BREAK.test(s[i - 1]);

/** Longest text the loose (in-order letters) match is tried on: across a paragraph, scattered
 *  letters match almost anything, so long text needs the words themselves. */
const LOOSE_MAX = 120;

/**
 * How well `query` matches `text`, from 0 (no match) to 100. Best: the text starts with the
 * query; then the query at a word start; then anywhere; then every query word somewhere in the
 * text; last, for short text only, the query's letters in order (a typo-tolerant "fuzzy" match),
 * scored by how tightly they cluster and how many start words.
 */
export function matchText(query: string, text: string | undefined | null): number {
  const q = query.trim().toLowerCase();
  if (!q || !text) return 0;
  const t = text.toLowerCase();

  const at = t.indexOf(q);
  if (at === 0) return 100 - Math.min(10, (t.length - q.length) / 20);
  if (at > 0) {
    let i = at;
    while (i >= 0 && !isWordStart(t, i)) i = t.indexOf(q, i + 1);
    return i >= 0 ? 85 - Math.min(10, i / 20) : 70 - Math.min(10, at / 40);
  }

  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every((w) => t.includes(w))) return 60;

  if (t.length > LOOSE_MAX || q.length < 2) return 0;
  let qi = 0, first = -1, last = -1, starts = 0, runs = 0, prev = -2;
  for (let ci = 0; ci < t.length && qi < q.length; ci++) {
    if (t[ci] !== q[qi]) continue;
    if (q[qi] === ' ') { qi++; prev = ci; continue; }
    if (first < 0) first = ci;
    if (isWordStart(t, ci)) starts++;
    if (ci === prev + 1) runs++;
    last = ci;
    prev = ci;
    qi++;
  }
  if (qi < q.length) return 0;
  const span = last - first + 1;
  // Letters spread over more than four times the query's length are a coincidence, not a match.
  if (span > q.length * 4) return 0;
  const tightness = q.length / span; // 1 when the letters are adjacent
  return Math.round(20 + 20 * tightness + Math.min(10, starts * 3 + runs));
}
