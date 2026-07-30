/**
 * The markdown an agent actually writes → a tree of blocks and spans.
 *
 * **Nothing here ever produces markup.** It returns data; `conversation.tsx`
 * picks an element per node and passes every string through as a *child*, so
 * agent text becomes a text node and an attribute is only ever written where
 * this module has already vetted the value (`href`, below). That is the whole
 * of the safety argument, and it is structural rather than a filter: there is
 * no `innerHTML` and no HTML string anywhere in the path, so there is nothing
 * for an escaping bug to leak through. A `<script>` tag in a fenced block is
 * five characters of text and stays five characters of text.
 *
 * It is a **bounded subset**, on purpose — headings, emphasis, lists, links,
 * inline code, block quotes and fenced code. That is what agents emit, and a
 * full CommonMark implementation is a dependency this product does not want
 * (report: eight runtime packages is a feature). The rules below cost the
 * corners a real parser would keep:
 *
 *  - **`*` is the only emphasis marker.** `_` is not, because `some_snake_case`
 *    is far more common in an agent's prose than `_emphasis_`, and turning half
 *    an identifier into italics is worse than not italicising anything.
 *  - **Spans do not nest.** `**bold `code`**` renders as one bold run; the
 *    alternative is a recursive descent for a case nothing produces.
 *  - **Lists are flat plus a depth number.** Nesting deeper than one indent is
 *    clamped rather than modelled, because the only thing depth decides here is
 *    a padding value.
 *  - **No tables, no reference links, no HTML blocks, no setext headings.** A
 *    table degrades to paragraph text, which is what it looked like before.
 *
 * Anything unrecognised is text. There is no throw in this file: the same rule
 * the mappers hold — an unknown shape is shown, never fatal — applies here,
 * where the input is a string a language model wrote.
 */

export type Span =
  | { span: 'text'; text: string }
  | { span: 'code'; text: string }
  | { span: 'strong'; text: string }
  | { span: 'em'; text: string }
  /** `href` has already been checked by {@link safeHref}; nothing else may set one. */
  | { span: 'link'; text: string; href: string };

export type ListItem = { depth: number; spans: readonly Span[] };

export type Block =
  | { block: 'p'; spans: readonly Span[] }
  | { block: 'heading'; level: number; spans: readonly Span[] }
  | { block: 'quote'; spans: readonly Span[] }
  | { block: 'list'; ordered: boolean; items: readonly ListItem[] }
  /** Verbatim. Never re-parsed, never anything but text in the view. */
  | { block: 'code'; lang: string | null; text: string };

/** ``` or ~~~, with up to three spaces of indent, and an optional info string. */
const FENCE = /^ {0,3}(?:```|~~~)(.*)$/;
const FENCE_END = /^ {0,3}(?:```|~~~)\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/;

/**
 * The one place a link's target is decided. Everything else is a text node, so
 * this is the only value in the whole pipeline that becomes live browser
 * behaviour — which is why the check is an allow-list of two schemes rather
 * than a `javascript:` blocklist: `java\nscript:` is a URL a blocklist misses
 * and a browser honours.
 *
 * Anything else renders as the literal characters the agent wrote, so a link
 * tether will not follow is still *readable*.
 */
export function safeHref(url: string): string | null {
  const href = url.trim();
  return /^(?:https?:\/\/|mailto:)[^\s<>"'`]+$/i.test(href) ? href : null;
}

/**
 * Inline markers, tried in one pass and in this order: code first, so a
 * backtick run wins over anything inside it; then the two-star strong; then a
 * **bare `**` that matches and emits nothing**; then a single-star emphasis;
 * then links.
 *
 * That third alternative is the one that is not obvious. Without it a glob —
 * `src/**\/*.ts`, which agents write constantly — hands the emphasis rule two
 * loose stars to pair up, and half a path becomes italics. Matching the run and
 * producing no span consumes it: the characters stay in the surrounding text
 * because {@link inline} only slices text at spans it actually emits. It is a
 * lookbehind written as an alternative, deliberately — a real `(?<!\*)` is a
 * *parse-time* SyntaxError on an iOS Safari older than 16.4, which would take
 * the whole bundle down on exactly the phones this product is for.
 */
const INLINE =
  /`([^`]+)`|\*\*([^*\s](?:[^*]*[^*\s])?)\*\*|(?:\*\*)|\*([^*\s](?:[^*]*[^*\s])?)\*|\[([^\]\n]*)\]\(([^)\s]*)\)/g;

export function inline(text: string): readonly Span[] {
  const spans: Span[] = [];
  let at = 0;
  // A fresh lastIndex each call: the regex is module-level and `g` is stateful.
  INLINE.lastIndex = 0;
  for (let match = INLINE.exec(text); match !== null; match = INLINE.exec(text)) {
    const [whole, code, strong, em, label, url] = match;
    const span = spanOf(code, strong, em, label, url);
    // An unusable link: the characters stay, so the user still sees what was
    // written and can judge it, rather than a link silently disappearing.
    if (span === undefined) continue;
    if (match.index > at) spans.push({ span: 'text', text: text.slice(at, match.index) });
    spans.push(span);
    at = match.index + whole.length;
  }
  if (at < text.length) spans.push({ span: 'text', text: text.slice(at) });
  return spans;
}

function spanOf(
  code: string | undefined,
  strong: string | undefined,
  em: string | undefined,
  label: string | undefined,
  url: string | undefined,
): Span | undefined {
  if (code !== undefined) return { span: 'code', text: code };
  if (strong !== undefined) return { span: 'strong', text: strong };
  if (em !== undefined) return { span: 'em', text: em };
  if (label === undefined || url === undefined) return undefined;
  const href = safeHref(url);
  return href === null ? undefined : { span: 'link', text: label === '' ? href : label, href };
}

/**
 * Text → blocks. Line-based and single-pass: an agent's markdown is written by
 * a generator that emits it a line at a time, and everything in the subset
 * above is decidable from the start of a line.
 */
export function markdown(text: string): readonly Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let quote: string[] = [];
  // Raw until `flush`: a list item's continuation lines are appended as text,
  // so the inline pass runs once, on the whole item.
  let items: { depth: number; text: string }[] | null = null;
  let ordered = false;

  const flush = () => {
    if (paragraph.length > 0) {
      blocks.push({ block: 'p', spans: inline(paragraph.join('\n')) });
      paragraph = [];
    }
    if (quote.length > 0) {
      blocks.push({ block: 'quote', spans: inline(quote.join('\n')) });
      quote = [];
    }
    if (items !== null) {
      blocks.push({
        block: 'list',
        ordered,
        items: items.map(({ depth, text: item }) => ({ depth, spans: inline(item) })),
      });
      items = null;
    }
  };

  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at] ?? '';

    const fence = FENCE.exec(line);
    if (fence !== null) {
      flush();
      const body: string[] = [];
      for (at += 1; at < lines.length && !FENCE_END.test(lines[at] ?? ''); at += 1) {
        body.push(lines[at] ?? '');
      }
      // An unclosed fence runs to the end of the message rather than throwing
      // the rest of it away: a streamed reply is routinely read mid-fence.
      const lang = (fence[1] ?? '').trim();
      blocks.push({ block: 'code', lang: lang === '' ? null : lang, text: body.join('\n') });
      continue;
    }

    if (line.trim() === '') {
      flush();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      flush();
      blocks.push({
        block: 'heading',
        level: (heading[1] ?? '#').length,
        spans: inline(heading[2] ?? ''),
      });
      continue;
    }

    const quoted = QUOTE.exec(line);
    if (quoted !== null) {
      if (quote.length === 0) flush();
      quote.push(quoted[1] ?? '');
      continue;
    }

    const item = ITEM.exec(line);
    if (item !== null) {
      // Group 2 is the bullet; its absence means the number matched instead.
      const numbered = item[2] === undefined;
      // A list of the other kind ends this one: `1.` under `-` is a new list,
      // not an item of the old one.
      if (items !== null && ordered !== numbered) flush();
      if (items === null) {
        flush();
        ordered = numbered;
        items = [];
      }
      items.push({
        // Clamped: depth only picks a padding, and an agent that indents by
        // four spaces per level must not walk off the right of a 360px screen.
        depth: Math.min(2, Math.floor((item[1] ?? '').replace(/\t/g, '  ').length / 2)),
        text: item[4] ?? '',
      });
      continue;
    }

    // A plain line under a list item is that item's continuation — markdown's
    // own lazy rule, and what makes a wrapped bullet one bullet.
    const open = items?.[items.length - 1];
    if (open !== undefined) {
      open.text = `${open.text} ${line.trim()}`;
      continue;
    }
    if (quote.length > 0) {
      quote.push(line.trim());
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}
