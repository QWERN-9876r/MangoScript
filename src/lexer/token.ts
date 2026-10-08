export const KEYWORDS = [
  'func',
  'comp',
  'return',
  'let',
  'const',
  'type',
  'interface',
  'class',
  'extends',
  'new',
  'this',
  'super',
  'if',
  'else',
  'for',
  'in',
  'break',
  'continue',
  'switch',
  'case',
  'default',
  'defer',
  'try',
  'catch',
  'finally',
  'throw',
  'import',
  'export',
  'null',
  'true',
  'false',
  'typeof',
  'instanceof',
  // Reserved for future use.
  'map',
  'async',
  'await',
] as const;

export const PUNCTUATORS = [
  '{',
  '}',
  '(',
  ')',
  '[',
  ']',
  ';',
  ',',
  ':',
  '.',
  '...',
  '?',
  '?.',
  '??',
  '=>',
  '=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '**=',
  '&=',
  '|=',
  '^=',
  '<<=',
  '>>=',
  '>>>=',
  '&&=',
  '||=',
  '??=',
  '==',
  '!=',
  '<',
  '>',
  '<=',
  '>=',
  '+',
  '-',
  '*',
  '/',
  '%',
  '**',
  '++',
  '--',
  '&',
  '|',
  '^',
  '~',
  '<<',
  '>>',
  '>>>',
  '&&',
  '||',
  '!',
  '@',
] as const;

export type Keyword = (typeof KEYWORDS)[number];
export type Punctuator = (typeof PUNCTUATORS)[number];

/**
 * Token kinds whose `value` holds string contents. Template literals are split around
 * substitutions: `a${x}b${y}c` becomes TemplateHead("a") x TemplateMiddle("b") y TemplateTail("c"),
 * and a template without substitutions is a single Template token. In markup, JsxText is the text
 * between tags and JsxString an attribute value in quotes; both have HTML entities decoded.
 */
export type StringKind =
  | 'String'
  | 'Template'
  | 'TemplateHead'
  | 'TemplateMiddle'
  | 'TemplateTail'
  | 'JsxText'
  | 'JsxString';

/**
 * Tokens of markup such as `<a href="/">text</a>`: JsxTagOpen `<`, JsxCloseTagOpen `</`, JsxName
 * (tag and attribute names, which may contain `-` and `:`), JsxTagEnd `>` and JsxSelfClose `/>`.
 * Expressions inside markup use the ordinary `{`, `}` and `=` tokens.
 */
export type JsxKind = 'JsxTagOpen' | 'JsxCloseTagOpen' | 'JsxName' | 'JsxTagEnd' | 'JsxSelfClose';

/** Keywords and punctuators use their own text as the kind, e.g. `func` or `+=`. */
export type TokenKind =
  'Identifier' | 'Number' | StringKind | JsxKind | 'EOF' | Keyword | Punctuator;

interface TokenBase {
  /** Source text. Empty for automatically inserted semicolons and EOF. */
  text: string;
  start: number;
  end: number;
}

export interface NumberToken extends TokenBase {
  kind: 'Number';
  value: number;
}

export interface StringToken extends TokenBase {
  kind: StringKind;
  /** Contents with escapes resolved, without quotes and `${` / `}` delimiters. */
  value: string;
}

export interface SimpleToken extends TokenBase {
  kind: Exclude<TokenKind, 'Number' | StringKind>;
}

export type Token = NumberToken | StringToken | SimpleToken;

const KEYWORD_SET: ReadonlySet<string> = new Set(KEYWORDS);
const PUNCTUATOR_SET: ReadonlySet<string> = new Set(PUNCTUATORS);

export function isKeyword(word: string): word is Keyword {
  return KEYWORD_SET.has(word);
}

export function isPunctuator(text: string): text is Punctuator {
  return PUNCTUATOR_SET.has(text);
}
