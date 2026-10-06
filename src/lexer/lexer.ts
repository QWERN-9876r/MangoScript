import type { Diagnostic } from '../diagnostics.ts';
import { isKeyword, isPunctuator, type StringKind, type Token, type TokenKind } from './token.ts';

export interface LexResult {
  /** Always ends with an EOF token. */
  tokens: Token[];
  diagnostics: Diagnostic[];
}

export function tokenize(text: string): LexResult {
  return new Lexer(text).run();
}

/**
 * A line break after one of these tokens ends the statement, so the lexer inserts a semicolon
 * there (the same rule as in Go).
 */
const ENDS_STATEMENT: ReadonlySet<TokenKind> = new Set<TokenKind>([
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
const ENDS_VALUE: ReadonlySet<TokenKind> = new Set<TokenKind>([
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
const JSX_NAME = /[\p{ID_Start}$_][\p{ID_Continue}$\-:.]*/uy;

const ENTITIES: Readonly<Record<string, string>> = {
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
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (entity, name: string) => {
    if (name.startsWith('#')) {
      const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return Object.hasOwn(ENTITIES, name) ? ENTITIES[name]! : entity;
  });
}

const IDENTIFIER = /[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*/uy;

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
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

type CharTest = (c: string | undefined) => boolean;

const isDigit: CharTest = (c) => c !== undefined && c >= '0' && c <= '9';
const isHexDigit: CharTest = (c) => c !== undefined && /^[0-9a-fA-F]$/.test(c);
const isOctalDigit: CharTest = (c) => c !== undefined && c >= '0' && c <= '7';
const isBinaryDigit: CharTest = (c) => c === '0' || c === '1';

/**
 * What the lexer is inside of, innermost last. `start` is where the template or element begins,
 * for error messages; `braces` counts unclosed `{` inside a substitution or expression.
 */
type Mode =
  | { kind: 'template'; start: number; braces: number }
  // `{ ... }` inside markup: an attribute value, a spread or a child expression.
  | { kind: 'expression'; braces: number }
  // `<tag attributes`, element content between the tags, and `</tag`.
  | { kind: 'tag'; start: number }
  | { kind: 'content'; start: number }
  | { kind: 'closingTag'; start: number };

type MarkupMode = Extract<Mode, { kind: 'tag' | 'content' | 'closingTag' }>;

function isMarkup(mode: Mode | undefined): mode is MarkupMode {
  return mode?.kind === 'tag' || mode?.kind === 'content' || mode?.kind === 'closingTag';
}

class Lexer {
  private readonly text: string;
  private pos = 0;
  private readonly tokens: Token[] = [];
  private readonly diagnostics: Diagnostic[] = [];
  private readonly modes: Mode[] = [];

  constructor(text: string) {
    this.text = text;
  }

  run(): LexResult {
    if (this.text.startsWith('﻿')) this.pos = 1;
    for (;;) {
      const mode = this.modes.at(-1);
      if (isMarkup(mode)) {
        // Markup has its own rules for whitespace and no automatic semicolons.
        if (this.pos >= this.text.length) break;
        if (mode.kind === 'content') this.scanContent(mode);
        else this.scanTag(mode);
        continue;
      }
      const sawNewline = this.skipTrivia();
      if (sawNewline && this.lastEndsStatement() && !this.nextLineContinues()) {
        this.insertSemicolon();
      }
      if (this.pos >= this.text.length) break;
      this.scanToken();
    }
    if (this.lastEndsStatement()) this.insertSemicolon();
    for (const mode of this.modes) {
      if (mode.kind === 'template') {
        this.error('unterminated template literal', mode.start, mode.start + 1);
      }
    }
    // Nested elements are inside the first one, so it is enough to report that.
    const element = this.modes.find(isMarkup);
    if (element) this.error('unterminated element', element.start, element.start + 1);
    this.tokens.push({ kind: 'EOF', text: '', start: this.pos, end: this.pos });
    this.diagnostics.sort((a, b) => a.start - b.start);
    return { tokens: this.tokens, diagnostics: this.diagnostics };
  }

  /** Skips whitespace and comments; returns whether a line break was skipped. */
  private skipTrivia(): boolean {
    const t = this.text;
    let sawNewline = false;
    while (this.pos < t.length) {
      const c = t[this.pos];
      if (c === '\n') {
        sawNewline = true;
        this.pos++;
      } else if (c === ' ' || c === '\t' || c === '\r' || c === '\v' || c === '\f') {
        this.pos++;
      } else if (t.startsWith('//', this.pos)) {
        const end = t.indexOf('\n', this.pos);
        this.pos = end === -1 ? t.length : end;
      } else if (t.startsWith('/*', this.pos)) {
        const end = t.indexOf('*/', this.pos + 2);
        if (end === -1) {
          this.error('unterminated block comment', this.pos, this.pos + 2);
          this.pos = t.length;
        } else {
          // A comment spanning several lines counts as a line break.
          const newline = t.indexOf('\n', this.pos);
          if (newline !== -1 && newline < end) sawNewline = true;
          this.pos = end + 2;
        }
      } else {
        break;
      }
    }
    return sawNewline;
  }

  private lastEndsStatement(): boolean {
    const last = this.tokens.at(-1);
    return last !== undefined && ENDS_STATEMENT.has(last.kind);
  }

  /**
   * Unlike Go, a line starting with `.` / `?.` continues a method chain, and a line starting with
   * a closing bracket ends a list, so no semicolon is needed before it.
   */
  private nextLineContinues(): boolean {
    const t = this.text;
    const c = t[this.pos];
    const next = t[this.pos + 1];
    if (c === ')' || c === ']' || c === '}') return true;
    if (c === '.') return next !== '.' && !isDigit(next);
    return c === '?' && next === '.' && !isDigit(t[this.pos + 2]);
  }

  private insertSemicolon(): void {
    const end = this.tokens.at(-1)?.end ?? 0;
    this.tokens.push({ kind: ';', text: '', start: end, end });
  }

  private scanToken(): void {
    const t = this.text;
    const start = this.pos;
    const c = t[start];

    if (isDigit(c) || (c === '.' && isDigit(t[start + 1]))) {
      this.scanNumber(start);
    } else if (c === '"' || c === "'") {
      this.scanString(start, c);
    } else if (c === '`') {
      this.scanTemplate(start, false);
    } else if (c === '}' && this.top()?.kind === 'template' && this.braces() === 0) {
      this.scanTemplate(start, true);
    } else if (c === '}' && this.top()?.kind === 'expression' && this.braces() === 0) {
      // The end of `{ ... }` inside markup: back to the tag or the element content.
      this.push('}', start, start + 1);
      this.modes.pop();
    } else if (c === '<' && this.startsElement()) {
      this.push('JsxTagOpen', start, start + 1);
      this.modes.push({ kind: 'tag', start });
    } else if (!this.scanWord(start) && !this.scanPunctuator(start)) {
      const char = String.fromCodePoint(t.codePointAt(start) ?? 0);
      this.error(`unexpected character "${char}"`, start, start + char.length);
      this.pos += char.length;
    }
  }

  private scanWord(start: number): boolean {
    IDENTIFIER.lastIndex = start;
    const word = IDENTIFIER.exec(this.text)?.[0];
    if (word === undefined) return false;
    this.pos = start + word.length;
    if (word.startsWith('$$')) {
      this.error('names starting with "$$" are reserved for generated code', start, this.pos);
    }
    this.tokens.push({
      kind: isKeyword(word) ? word : 'Identifier',
      text: word,
      start,
      end: this.pos,
    });
    return true;
  }

  private scanPunctuator(start: number): boolean {
    const t = this.text;

    const three = t.slice(start, start + 3);
    if (three === '===' || three === '!==') {
      const kind = three === '===' ? '==' : '!=';
      this.error(`"${three}" is not needed: "${kind}" is already strict`, start, start + 3);
      this.pos = start + 3;
      this.tokens.push({ kind, text: three, start, end: this.pos });
      return true;
    }

    for (let length = 4; length > 0; length--) {
      const candidate = t.slice(start, start + length);
      // `a ?.5 : b` is a conditional expression, not optional chaining (same rule as in JS).
      if (!isPunctuator(candidate) || (candidate === '?.' && isDigit(t[start + 2]))) continue;
      this.pos = start + length;
      this.tokens.push({ kind: candidate, text: candidate, start, end: this.pos });
      const top = this.top();
      if (top?.kind === 'template' || top?.kind === 'expression') {
        if (candidate === '{') top.braces++;
        if (candidate === '}') top.braces--;
      }
      return true;
    }
    return false;
  }

  private scanNumber(start: number): void {
    const t = this.text;
    let pos = start;

    const prefix = t[pos] === '0' ? t[pos + 1]?.toLowerCase() : undefined;
    const radixDigit =
      prefix === 'x'
        ? isHexDigit
        : prefix === 'b'
          ? isBinaryDigit
          : prefix === 'o'
            ? isOctalDigit
            : undefined;

    if (radixDigit) {
      pos = this.scanDigits(pos + 2, radixDigit);
      if (pos === start + 2) {
        this.error(`expected digits after "${t.slice(start, pos)}"`, start, pos);
      }
    } else {
      pos = this.scanDigits(pos, isDigit);
      if (/^0[0-9_]/.test(t.slice(start, pos))) {
        this.error('leading zeros are not allowed (use "0o" for octal numbers)', start, pos);
      }
      if (t[pos] === '.' && isDigit(t[pos + 1])) {
        pos = this.scanDigits(pos + 1, isDigit);
      }
      if (t[pos] === 'e' || t[pos] === 'E') {
        const exponent = pos++;
        if (t[pos] === '+' || t[pos] === '-') pos++;
        if (isDigit(t[pos])) pos = this.scanDigits(pos, isDigit);
        else this.error('expected digits in exponent', exponent, pos);
      }
    }

    // `123abc` is almost certainly a typo, not a number followed by a name.
    IDENTIFIER.lastIndex = pos;
    const suffix = IDENTIFIER.exec(t)?.[0];
    if (suffix !== undefined) {
      this.error('identifier cannot start immediately after a number', pos, pos + suffix.length);
      pos += suffix.length;
    }

    this.pos = pos;
    const text = t.slice(start, pos);
    this.tokens.push({
      kind: 'Number',
      value: Number(text.replaceAll('_', '')),
      text,
      start,
      end: pos,
    });
  }

  /** Consumes digits and `_` separators starting at `pos`; returns the end offset. */
  private scanDigits(pos: number, isValid: CharTest): number {
    const t = this.text;
    for (;;) {
      if (isValid(t[pos])) {
        pos++;
      } else if (t[pos] === '_') {
        const run = pos;
        while (t[pos] === '_') pos++;
        if (pos - run > 1 || !isValid(t[run - 1]) || !isValid(t[pos])) {
          this.error('"_" can only appear between digits', run, pos);
        }
      } else {
        return pos;
      }
    }
  }

  private scanString(start: number, quote: '"' | "'"): void {
    const t = this.text;
    let pos = start + 1;
    let value = '';
    for (;;) {
      const c = t[pos];
      if (c === undefined || c === '\n' || c === '\r') {
        this.error('unterminated string literal', start, pos);
        break;
      }
      if (c === quote) {
        pos++;
        break;
      }
      if (c === '\\') {
        const escape = this.scanEscape(pos);
        value += escape.value;
        pos = escape.end;
      } else {
        value += c;
        pos++;
      }
    }
    this.pos = pos;
    this.tokens.push({ kind: 'String', value, text: t.slice(start, pos), start, end: pos });
  }

  /**
   * Scans template text up to the closing backtick or the next `${`. Starts either at the opening
   * backtick or, when `continued`, at the `}` that closes a substitution.
   */
  private scanTemplate(start: number, continued: boolean): void {
    const t = this.text;
    let pos = start + 1;
    let value = '';
    let kind: StringKind;
    for (;;) {
      const c = t[pos];
      if (c === undefined) {
        const template = continued ? this.modes.pop() : undefined;
        const templateStart = template?.kind === 'template' ? template.start : start;
        this.error('unterminated template literal', templateStart, templateStart + 1);
        kind = continued ? 'TemplateTail' : 'Template';
        break;
      }
      if (c === '`') {
        pos++;
        if (continued) this.modes.pop();
        kind = continued ? 'TemplateTail' : 'Template';
        break;
      }
      if (c === '$' && t[pos + 1] === '{') {
        pos += 2;
        if (!continued) this.modes.push({ kind: 'template', start, braces: 0 });
        kind = continued ? 'TemplateMiddle' : 'TemplateHead';
        break;
      }
      if (c === '\\') {
        const escape = this.scanEscape(pos);
        value += escape.value;
        pos = escape.end;
      } else if (c === '\r') {
        // Line breaks inside templates are normalized to \n, as in JS.
        value += '\n';
        pos += t[pos + 1] === '\n' ? 2 : 1;
      } else {
        value += c;
        pos++;
      }
    }
    this.pos = pos;
    this.tokens.push({ kind, value, text: t.slice(start, pos), start, end: pos });
  }

  /** Decodes the escape sequence whose backslash is at `pos`. */
  private scanEscape(pos: number): { value: string; end: number } {
    const t = this.text;
    const c = t[pos + 1];
    // A backslash at the end of a line or input: the caller reports the unterminated literal.
    if (c === undefined || c === '\n' || c === '\r') return { value: '', end: pos + 1 };

    const simple = SIMPLE_ESCAPES[c];
    if (simple !== undefined) return { value: simple, end: pos + 2 };

    if (c === 'x') {
      const hex = t.slice(pos + 2, pos + 4);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        return { value: String.fromCharCode(parseInt(hex, 16)), end: pos + 4 };
      }
      this.error('expected two hex digits after "\\x"', pos, pos + 2);
      return { value: '', end: pos + 2 };
    }

    if (c === 'u') {
      if (t[pos + 2] === '{') {
        const close = t.indexOf('}', pos + 3);
        const hex = close === -1 ? '' : t.slice(pos + 3, close);
        if (/^[0-9a-fA-F]{1,6}$/.test(hex) && parseInt(hex, 16) <= 0x10ffff) {
          return { value: String.fromCodePoint(parseInt(hex, 16)), end: close + 1 };
        }
      } else {
        const hex = t.slice(pos + 2, pos + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          return { value: String.fromCharCode(parseInt(hex, 16)), end: pos + 6 };
        }
      }
      this.error('expected "\\uXXXX" or "\\u{X...}" with a valid code point', pos, pos + 2);
      return { value: '', end: pos + 2 };
    }

    const char = String.fromCodePoint(t.codePointAt(pos + 1) ?? 0);
    this.error(`unknown escape sequence "\\${char}"`, pos, pos + 1 + char.length);
    return { value: char, end: pos + 1 + char.length };
  }

  private top(): Mode | undefined {
    return this.modes.at(-1);
  }

  private braces(): number {
    const top = this.top();
    return top?.kind === 'template' || top?.kind === 'expression' ? top.braces : 0;
  }

  private push(kind: Exclude<TokenKind, 'Number' | StringKind>, start: number, end: number): void {
    this.tokens.push({ kind, text: this.text.slice(start, end), start, end });
    this.pos = end;
  }

  /** `<` starts markup where a value is expected and is "less than" after a value. */
  private startsElement(): boolean {
    const last = this.tokens.at(-1);
    if (last && ENDS_VALUE.has(last.kind)) return false;
    const next = this.text[this.pos + 1];
    return next === '>' || (next !== undefined && /^[\p{ID_Start}$_]$/u.test(next));
  }

  /** Inside `<tag ...>` or `</tag>`: names, `=`, attribute values, `{`, `>` and `/>`. */
  private scanTag(mode: MarkupMode): void {
    const t = this.text;
    while (/^\s$/.test(t[this.pos] ?? '')) this.pos++;
    const start = this.pos;
    const c = t[start];
    if (c === undefined) return;
    const opening = mode.kind === 'tag';

    if (c === '>') {
      this.push('JsxTagEnd', start, start + 1);
      // After an opening tag comes the content; a closing tag ends the element.
      if (opening) this.modes[this.modes.length - 1] = { kind: 'content', start: mode.start };
      else this.modes.pop();
    } else if (opening && c === '/' && t[start + 1] === '>') {
      this.push('JsxSelfClose', start, start + 2);
      this.modes.pop();
    } else if (opening && c === '{') {
      this.push('{', start, start + 1);
      this.modes.push({ kind: 'expression', braces: 0 });
    } else if (opening && c === '=') {
      this.push('=', start, start + 1);
    } else if (opening && (c === '"' || c === "'")) {
      // Attribute values are taken as written, as in HTML: no backslash escapes.
      const close = t.indexOf(c, start + 1);
      const end = close === -1 ? t.length : close + 1;
      if (close === -1) this.error('unterminated attribute value', start, end);
      const text = t.slice(start, end);
      const raw = text.slice(1, close === -1 ? undefined : -1);
      this.tokens.push({ kind: 'JsxString', value: decodeEntities(raw), text, start, end });
      this.pos = end;
    } else {
      JSX_NAME.lastIndex = start;
      const name = JSX_NAME.exec(t)?.[0];
      if (name !== undefined) {
        this.push('JsxName', start, start + name.length);
      } else {
        this.error(`unexpected character "${c}" in a tag`, start, start + 1);
        this.pos++;
      }
    }
  }

  /** Element content: text, `{expression}`, child elements and the closing tag. */
  private scanContent(mode: MarkupMode): void {
    const t = this.text;
    const start = this.pos;
    if (t.startsWith('</', start)) {
      this.push('JsxCloseTagOpen', start, start + 2);
      this.modes[this.modes.length - 1] = { kind: 'closingTag', start: mode.start };
    } else if (t[start] === '<') {
      this.push('JsxTagOpen', start, start + 1);
      this.modes.push({ kind: 'tag', start });
    } else if (t[start] === '{') {
      this.push('{', start, start + 1);
      this.modes.push({ kind: 'expression', braces: 0 });
    } else {
      let end = start;
      while (end < t.length && t[end] !== '<' && t[end] !== '{') end++;
      const text = t.slice(start, end);
      this.tokens.push({ kind: 'JsxText', value: decodeEntities(text), text, start, end });
      this.pos = end;
    }
  }

  private error(message: string, start: number, end: number): void {
    this.diagnostics.push({ message, start, end });
  }
}
