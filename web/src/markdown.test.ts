import assert from 'node:assert/strict';
import test from 'node:test';

import { inline, markdown, safeHref, type Block } from './markdown.ts';

/** The block kinds, which is what most of these assertions are about. */
function kinds(text: string): string[] {
  return markdown(text).map((block) => block.block);
}

function only(text: string): Block {
  const blocks = markdown(text);
  assert.equal(blocks.length, 1, `expected one block, got ${JSON.stringify(blocks)}`);
  return blocks[0]!;
}

test('plain text is one paragraph of one text span, and nothing else', () => {
  // The commonest message in the product, and the one that must not grow
  // structure: the e2e specs count `getByText(exact)` matches on it.
  assert.deepEqual(only('hello there'), {
    block: 'p',
    spans: [{ span: 'text', text: 'hello there' }],
  });
});

test('a blank line separates paragraphs and a single break does not', () => {
  assert.deepEqual(kinds('one\ntwo\n\nthree'), ['p', 'p']);
  const [first] = markdown('one\ntwo\n\nthree');
  assert.deepEqual(first, { block: 'p', spans: [{ span: 'text', text: 'one\ntwo' }] });
});

test('headings carry their level and stop at six hashes', () => {
  assert.deepEqual(only('## What I changed'), {
    block: 'heading',
    level: 2,
    spans: [{ span: 'text', text: 'What I changed' }],
  });
  // Seven is not a heading in any dialect; it stays text.
  assert.equal(only('####### seven').block, 'p');
  // A hash with no space is a comment, a colour or a shell prompt.
  assert.equal(only('#ffb454 is the accent').block, 'p');
});

test('emphasis is the two star forms and never the underscore ones', () => {
  assert.deepEqual(inline('a **bold** and *italic* word'), [
    { span: 'text', text: 'a ' },
    { span: 'strong', text: 'bold' },
    { span: 'text', text: ' and ' },
    { span: 'em', text: 'italic' },
    { span: 'text', text: ' word' },
  ]);
  // The reason underscores are out: this is one identifier, not two words
  // around an emphasis, and it appears in agent prose constantly.
  assert.deepEqual(inline('the old_string field'), [
    { span: 'text', text: 'the old_string field' },
  ]);
  // A glob is not emphasis either.
  assert.deepEqual(inline('src/**/*.ts'), [{ span: 'text', text: 'src/**/*.ts' }]);
});

test('inline code wins over everything inside it', () => {
  assert.deepEqual(inline('run `npm test -- **/*.ts` first'), [
    { span: 'text', text: 'run ' },
    { span: 'code', text: 'npm test -- **/*.ts' },
    { span: 'text', text: ' first' },
  ]);
});

test('bulleted and numbered lists are separate blocks, and depth is clamped', () => {
  const [list] = markdown('- one\n  - nested\n        - very nested');
  assert.deepEqual(list, {
    block: 'list',
    ordered: false,
    items: [
      { depth: 0, spans: [{ span: 'text', text: 'one' }] },
      { depth: 1, spans: [{ span: 'text', text: 'nested' }] },
      // Four levels of indent, clamped to two: depth only picks a padding, and
      // a 360px screen has no room for a fifth one.
      { depth: 2, spans: [{ span: 'text', text: 'very nested' }] },
    ],
  });
  assert.deepEqual(kinds('- one\n1. two'), ['list', 'list']);
  const [, numbered] = markdown('- one\n1. two');
  assert.equal(numbered?.block === 'list' && numbered.ordered, true);
});

test('a line under a bullet continues it rather than starting a paragraph', () => {
  const [list] = markdown('- a long point that\nwrapped in the source');
  assert.deepEqual(list, {
    block: 'list',
    ordered: false,
    items: [
      { depth: 0, spans: [{ span: 'text', text: 'a long point that wrapped in the source' }] },
    ],
  });
});

test('a block quote is one block over consecutive lines', () => {
  assert.deepEqual(only('> first\n> second'), {
    block: 'quote',
    spans: [{ span: 'text', text: 'first\nsecond' }],
  });
});

test('a fenced block keeps its language, its whitespace and its exact bytes', () => {
  assert.deepEqual(only('```ts\nconst a = 1;\n\n  indented\n```'), {
    block: 'code',
    lang: 'ts',
    text: 'const a = 1;\n\n  indented',
  });
  assert.deepEqual(only('```\nplain\n```'), { block: 'code', lang: null, text: 'plain' });
  // A reply is routinely read mid-fence while it streams; an unclosed fence
  // must not throw the rest of the message away.
  assert.deepEqual(only('```sh\nnpm ci'), { block: 'code', lang: 'sh', text: 'npm ci' });
});

test('a fence is never re-parsed, so characters that would be markup stay text', () => {
  // The safety property, stated as data: what comes out is one `code` block
  // whose `text` is byte-identical to what went in. `conversation.tsx` renders
  // it as a child, so it becomes a text node — there is no HTML string
  // anywhere in the path for any of this to escape from.
  const dangerous = [
    '<script>alert(document.cookie)</script>',
    '<img src=x onerror="fetch(`/api/sessions`)">',
    '</code></pre><button onclick="doom()">Approve</button>',
    '<!-- --><iframe srcdoc="&lt;script&gt;">',
    '&lt;already escaped&gt; & raw & ampersands',
    '`backticks` **stars** [link](javascript:alert(1))',
  ].join('\n');
  const block = only(`\`\`\`html\n${dangerous}\n\`\`\``);
  assert.deepEqual(block, { block: 'code', lang: 'html', text: dangerous });
});

test('only http, https and mailto become a link; anything else stays literal', () => {
  assert.equal(safeHref('https://example.com/a?b=1#c'), 'https://example.com/a?b=1#c');
  assert.equal(safeHref('  http://box.local:8443/x  '), 'http://box.local:8443/x');
  assert.equal(safeHref('mailto:you@example.com'), 'mailto:you@example.com');
  // An allow-list rather than a blocklist, which is why each of these is null
  // rather than "cleaned": a blocklist misses the ones with the whitespace in.
  for (const bad of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'java\nscript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox',
    '/relative/path',
    '#anchor',
  ]) {
    assert.equal(safeHref(bad), null, bad);
  }
  // And an unusable link keeps its characters, so the user can still read what
  // was written rather than watching it vanish.
  assert.deepEqual(inline('see [this](javascript:alert(1)) now'), [
    { span: 'text', text: 'see [this](javascript:alert(1)) now' },
  ]);
  assert.deepEqual(inline('see [docs](https://example.com)'), [
    { span: 'text', text: 'see ' },
    { span: 'link', text: 'docs', href: 'https://example.com' },
  ]);
});

test('the whole subset survives one message together', () => {
  assert.deepEqual(
    kinds(
      [
        '# Done',
        '',
        'Changed **two** files, see `web/src/app.tsx`:',
        '',
        '- the first',
        '- the second',
        '',
        '> a note about it',
        '',
        '```ts',
        'export const a = 1;',
        '```',
        '',
        'That is all.',
      ].join('\n'),
    ),
    ['heading', 'p', 'list', 'quote', 'code', 'p'],
  );
});
