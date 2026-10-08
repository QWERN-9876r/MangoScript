import { LexerBase } from './base.ts';
import {
  IDENTIFIER,
  SIMPLE_ESCAPES,
  type CharTest,
  isDigit,
  isHexDigit,
  isOctalDigit,
  isBinaryDigit,
} from './tables.ts';
import type { StringKind } from './token.ts';

// Numbers, strings, template strings and escapes.

export abstract class LiteralLexer extends LexerBase {
  protected scanNumber(start: number): void {
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
  protected scanDigits(pos: number, isValid: CharTest): number {
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

  protected scanString(start: number, quote: '"' | "'"): void {
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
  protected scanTemplate(start: number, continued: boolean): void {
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
  protected scanEscape(pos: number): { value: string; end: number } {
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
}
