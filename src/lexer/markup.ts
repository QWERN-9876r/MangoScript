import { LiteralLexer } from './literals.ts';
import { ENDS_VALUE, JSX_NAME, decodeEntities, type MarkupMode } from './tables.ts';

// Markup: where an element starts, tags with their attributes, and text content.

export abstract class MarkupLexer extends LiteralLexer {
  /** `<` starts markup where a value is expected and is "less than" after a value. */
  protected startsElement(): boolean {
    const last = this.tokens.at(-1);
    if (last && ENDS_VALUE.has(last.kind)) return false;
    const next = this.text[this.pos + 1];
    return next === '>' || (next !== undefined && /^[\p{ID_Start}$_]$/u.test(next));
  }

  /** Inside `<tag ...>` or `</tag>`: names, `=`, attribute values, `{`, `>` and `/>`. */
  protected scanTag(mode: MarkupMode): void {
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
  protected scanContent(mode: MarkupMode): void {
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
}
