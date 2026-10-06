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
]);

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

interface OpenTemplate {
  /** Offset of the opening backtick, for error messages. */
  start: number;
  /** Number of unclosed `{` inside the current substitution. */
  braces: number;
}

class Lexer {
  private readonly text: string;
  private pos = 0;
  private readonly tokens: Token[] = [];
  private readonly diagnostics: Diagnostic[] = [];
  /** Templates whose `${ ... }` substitution we are inside, innermost last. */
  private readonly templates: OpenTemplate[] = [];

  constructor(text: string) {
    this.text = text;
  }

  run(): LexResult {
    if (this.text.startsWith('﻿')) this.pos = 1;
    for (;;) {
      const sawNewline = this.skipTrivia();
      if (sawNewline && this.lastEndsStatement() && !this.nextLineContinues()) {
        this.insertSemicolon();
      }
      if (this.pos >= this.text.length) break;
      this.scanToken();
    }
    if (this.lastEndsStatement()) this.insertSemicolon();
    for (const template of this.templates) {
      this.error('unterminated template literal', template.start, template.start + 1);
    }
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
    } else if (c === '}' && this.templates.at(-1)?.braces === 0) {
      this.scanTemplate(start, true);
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
      const template = this.templates.at(-1);
      if (template && candidate === '{') template.braces++;
      if (template && candidate === '}') template.braces--;
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
        const template = continued ? this.templates.pop() : undefined;
        this.error(
          'unterminated template literal',
          template?.start ?? start,
          (template?.start ?? start) + 1,
        );
        kind = continued ? 'TemplateTail' : 'Template';
        break;
      }
      if (c === '`') {
        pos++;
        if (continued) this.templates.pop();
        kind = continued ? 'TemplateTail' : 'Template';
        break;
      }
      if (c === '$' && t[pos + 1] === '{') {
        pos += 2;
        if (!continued) this.templates.push({ start, braces: 0 });
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

  private error(message: string, start: number, end: number): void {
    this.diagnostics.push({ message, start, end });
  }
}
