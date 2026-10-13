import { MarkupLexer } from './markup.ts';
import type { Mode } from './tables.ts';

// `style { ... }` in a component: CSS. Its text becomes CssText tokens, as it is written; a value
// from code, `color: {accent}`, becomes `{`, the tokens of the expression and `}`, as in markup.
// The `}` that closes the block is an ordinary `}` token.

type CssMode = Extract<Mode, { kind: 'css' }>;

/**
 * The start of a declaration: a property name, a colon and then a space or a value, `color: ` or
 * `color:{`. With a name right after the colon it is a selector, `a:hover`, so `{` there opens a
 * nested rule.
 */
const DECLARATION = /^\s*-{0,2}[a-zA-Z_][\w-]*\s*:(?:\s|[^\w\-:\\]|$)/;

export abstract class StyleLexer extends MarkupLexer {
  /**
   * `style {` at the start of a statement starts CSS: the identifier `style` has just been read at
   * `start`. Elsewhere `style` is an ordinary name.
   */
  protected startStyle(start: number): void {
    const before = this.tokens.at(-2);
    const startsStatement =
      before === undefined || before.kind === ';' || before.kind === '{' || before.kind === '}';
    const brace = /^[ \t]*\{/.exec(this.text.slice(this.pos));

    if (!startsStatement || !brace) return;

    const open = this.pos + brace[0].length - 1;

    this.push('{', open, open + 1);
    this.modes.push({ kind: 'css', start, depth: 0, item: '' });
  }

  /** CSS text up to a value from code or to the `}` that closes the block. */
  protected scanCss(mode: CssMode): void {
    const t = this.text;
    const start = this.pos;
    let i = start;
    const flush = (end: number) => {
      if (end > start) {
        const text = t.slice(start, end);

        this.tokens.push({ kind: 'CssText', value: text, text, start, end });
      }
    };

    while (i < t.length) {
      const c = t[i];

      if (c === '/' && t[i + 1] === '*') {
        const end = t.indexOf('*/', i + 2);

        if (end === -1) {
          this.error('unterminated comment in CSS', i, i + 2);
          i = t.length;
        } else {
          i = end + 2;
        }
      } else if (c === '"' || c === "'") {
        const end = this.cssStringEnd(i);

        mode.item += t.slice(i, end);
        i = end;
      } else if (c === '{' && mode.depth > 0 && DECLARATION.test(mode.item)) {
        // A value from code: the item gets a stand-in, so that the next `{` is a value too.
        flush(i);
        this.push('{', i, i + 1);
        mode.item += '0';
        this.modes.push({ kind: 'expression', braces: 0 });

        return;
      } else if (c === '{') {
        mode.depth++;
        mode.item = '';
        i++;
      } else if (c === '}' && mode.depth === 0) {
        flush(i);
        this.push('}', i, i + 1);
        this.modes.pop();

        return;
      } else if (c === '}' || c === ';') {
        if (c === '}') mode.depth--;
        mode.item = '';
        i++;
      } else {
        mode.item += c;
        i++;
      }
    }

    flush(i);
    this.pos = i;
  }

  /** The end of a CSS string that starts at `start`, after its closing quote. */
  private cssStringEnd(start: number): number {
    const t = this.text;
    const quote = t[start];
    let i = start + 1;

    while (i < t.length && t[i] !== quote && t[i] !== '\n') i += t[i] === '\\' ? 2 : 1;
    if (t[i] !== quote) {
      this.error('unterminated string in CSS', start, i);

      return i;
    }

    return i + 1;
  }
}
