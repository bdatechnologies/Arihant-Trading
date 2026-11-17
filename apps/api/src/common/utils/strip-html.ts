/**
 * Real HTML tags only — `<b>`, `</div>`, `<img …>`, `<!-- … -->`: "<" must be followed by a letter, "/" or "!".
 * A lone "<" or ">" in ordinary text ("<50% on time", "discount <5%", "motor >80C") is kept. The older patterns
 * `<[^>]*>` / `<[^>]*>?` deleted everything from any "<" to the next ">" (or to the end of the text), silently
 * changing what reviews, blockers, proposals and complaints said.
 */
const HTML_TAG = /<\/?[a-zA-Z!][^<>]*>/g;

/**
 * Removes HTML tags (replacing each with `replacement`), repeating until none are left so `<<b>b>` cannot
 * reassemble into a tag. Plain text only: the web app renders user text escaped, never as HTML.
 */
export function stripHtmlTags(text: string, replacement = ''): string {
  let prev: string;
  let s = text;
  do {
    prev = s;
    s = s.replace(HTML_TAG, replacement);
  } while (s !== prev);
  return s;
}
