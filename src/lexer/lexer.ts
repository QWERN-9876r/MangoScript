import type { Diagnostic } from '../diagnostics.ts';
import { MarkupLexer } from './markup.ts';
import { IDENTIFIER, isDigit, isMarkup } from './tables.ts';
import { isKeyword, isPunctuator, type Token } from './token.ts';

export interface LexResult {
  /** Always ends with an EOF token. */
  tokens: Token[];
  diagnostics: Diagnostic[];
}

// The lexer of a module; its layers are listed in base.ts.

class Lexer extends MarkupLexer {
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

  protected scanToken(): void {
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

  protected scanWord(start: number): boolean {
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

  protected scanPunctuator(start: number): boolean {
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
}

export function tokenize(text: string): LexResult {
  return new Lexer(text).run();
}
