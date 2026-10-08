import type { TokenKind } from './token.ts';

// Tables of the lexer: which tokens end a statement or a value, entities, escapes, modes.

/**
 * A line break after one of these tokens ends the statement, so the lexer inserts a semicolon
 * there (the same rule as in Go).
 */
export const ENDS_STATEMENT: ReadonlySet<TokenKind> = new Set<TokenKind>([
  'Identifier',
  'Number',
  'String',
  'Template',
  'TemplateTail',
  'true',
  'false',
  'null',
  'this',
  'return',
  'break',
  'continue',
  '++',
  '--',
  ')',
  ']',
  '}',
  'JsxTagEnd',
  'JsxSelfClose',
]);

/**
 * Tokens that end a value: after them `<` means "less than", elsewhere it starts markup. The
 * language has no `<...>` generics or casts, so this is never ambiguous.
 */
export const ENDS_VALUE: ReadonlySet<TokenKind> = new Set<TokenKind>([
  'Identifier',
  'Number',
  'String',
  'Template',
  'TemplateTail',
  'true',
  'false',
  'null',
  'this',
  'super',
  '++',
  '--',
  ')',
  ']',
  '}',
  'JsxTagEnd',
  'JsxSelfClose',
]);

/** Tag and attribute names: `div`, `my-widget`, `aria-label`, `bind:value`. */
export const JSX_NAME = /[\p{ID_Start}$_][\p{ID_Continue}$\-:.]*/uy;

export const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  copy: '©',
  times: '×',
  middot: '·',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
};

/** Decodes HTML entities in markup text: `&amp;`, `&#169;`, `&#xA9;`. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (entity, name: string) => {
    if (name.startsWith('#')) {
      const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return Object.hasOwn(ENTITIES, name) ? ENTITIES[name]! : entity;
  });
}

export const IDENTIFIER = /[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*/uy;

export const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
  v: '\v',
  '0': '\0',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '`': '`',
  $: '$',
};

export type CharTest = (c: string | undefined) => boolean;

export const isDigit: CharTest = (c) => c !== undefined && c >= '0' && c <= '9';
export const isHexDigit: CharTest = (c) => c !== undefined && /^[0-9a-fA-F]$/.test(c);
export const isOctalDigit: CharTest = (c) => c !== undefined && c >= '0' && c <= '7';
export const isBinaryDigit: CharTest = (c) => c === '0' || c === '1';

/**
 * What the lexer is inside of, innermost last. `start` is where the template or element begins,
 * for error messages; `braces` counts unclosed `{` inside a substitution or expression.
 */
export type Mode =
  | { kind: 'template'; start: number; braces: number }
  // `{ ... }` inside markup: an attribute value, a spread or a child expression.
  | { kind: 'expression'; braces: number }
  // `<tag attributes`, element content between the tags, and `</tag`.
  | { kind: 'tag'; start: number }
  | { kind: 'content'; start: number }
  | { kind: 'closingTag'; start: number };

export type MarkupMode = Extract<Mode, { kind: 'tag' | 'content' | 'closingTag' }>;

export function isMarkup(mode: Mode | undefined): mode is MarkupMode {
  return mode?.kind === 'tag' || mode?.kind === 'content' || mode?.kind === 'closingTag';
}
