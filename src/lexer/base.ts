import type { Diagnostic } from '../diagnostics.ts';
import { ENDS_STATEMENT, isDigit, type Mode } from './tables.ts';
import type { StringKind, Token, TokenKind } from './token.ts';

// The lexer is a chain of layers: base → literals → markup → Lexer (lexer.ts). This layer keeps the
// position and the modes (code, markup tags, markup content), skips spaces and comments, and inserts
// semicolons at the ends of lines.

export abstract class LexerBase {
  protected readonly text: string;

  protected pos = 0;

  protected readonly tokens: Token[] = [];

  protected readonly diagnostics: Diagnostic[] = [];

  protected readonly modes: Mode[] = [];

  constructor(text: string) {
    this.text = text;
  }

  /** Skips whitespace and comments; returns whether a line break was skipped. */
  protected skipTrivia(): boolean {
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

  protected lastEndsStatement(): boolean {
    const last = this.tokens.at(-1);
    return last !== undefined && ENDS_STATEMENT.has(last.kind);
  }

  /**
   * Unlike Go, a line starting with `.` / `?.` continues a method chain, and a line starting with
   * a closing bracket ends a list, so no semicolon is needed before it.
   */
  protected nextLineContinues(): boolean {
    const t = this.text;
    const c = t[this.pos];
    const next = t[this.pos + 1];
    if (c === ')' || c === ']' || c === '}') return true;
    if (c === '.') return next !== '.' && !isDigit(next);
    return c === '?' && next === '.' && !isDigit(t[this.pos + 2]);
  }

  protected insertSemicolon(): void {
    const end = this.tokens.at(-1)?.end ?? 0;
    this.tokens.push({ kind: ';', text: '', start: end, end });
  }

  protected top(): Mode | undefined {
    return this.modes.at(-1);
  }

  protected braces(): number {
    const top = this.top();
    return top?.kind === 'template' || top?.kind === 'expression' ? top.braces : 0;
  }

  protected push(
    kind: Exclude<TokenKind, 'Number' | StringKind>,
    start: number,
    end: number,
  ): void {
    this.tokens.push({ kind, text: this.text.slice(start, end), start, end });
    this.pos = end;
  }

  protected error(message: string, start: number, end: number): void {
    this.diagnostics.push({ message, start, end });
  }
}
