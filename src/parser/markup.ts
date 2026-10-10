import type * as ast from '../ast.ts';
import { LiteralParser } from './literals.ts';
import { describe, cleanJsxText, isHandlerReference } from './syntax.ts';

// Markup: elements, attributes, event handlers and `{...}` in markup.

export abstract class MarkupParser extends LiteralParser {
  /** `<tag attributes>children</tag>`, `<tag ... />` or a fragment `<>children</>`. */
  protected override parseJsxElement(): ast.ElementExpression {
    const start = this.expect('JsxTagOpen').start;
    const tag = this.check('JsxTagEnd') ? null : this.parseJsxName('tag name');
    const attributes: (ast.JsxAttribute | ast.JsxSpreadAttribute)[] = [];

    while (tag && !this.check('JsxTagEnd') && !this.check('JsxSelfClose')) {
      attributes.push(this.parseJsxAttribute());
    }

    if (tag && this.accept('JsxSelfClose')) {
      return { kind: 'ElementExpression', tag, attributes, children: [], ...this.span(start) };
    }

    this.expect('JsxTagEnd', tag ? '">" or "/>"' : '">"');

    const children: ast.JsxChild[] = [];

    while (!this.check('JsxCloseTagOpen')) {
      const token = this.peek();

      if (token.kind === 'JsxText') {
        this.next();

        const value = cleanJsxText(token.value);

        if (value !== '')
          children.push({ kind: 'JsxText', value, start: token.start, end: token.end });
      } else if (token.kind === 'JsxTagOpen') {
        children.push(this.parseJsxElement());
      } else if (token.kind === '{') {
        const container = this.parseJsxExpressionContainer();

        if (container) children.push(container);
      } else {
        this.fail(`expected element content or a closing tag, found ${describe(token)}`);
      }
    }

    // The closing tag must match the opening one.
    const closeStart = this.expect('JsxCloseTagOpen').start;
    const closing = this.check('JsxName') ? this.next().text : null;

    if (closing !== (tag?.name ?? null)) {
      this.failAt(
        `expected </${tag?.name ?? ''}> to close <${tag?.name ?? ''}>`,
        closeStart,
        this.span(closeStart).end,
      );
    }

    this.expect('JsxTagEnd');

    return { kind: 'ElementExpression', tag, attributes, children, ...this.span(start) };
  }

  protected parseJsxName(what: string): ast.Identifier {
    const token = this.peek();

    if (token.kind !== 'JsxName') this.fail(`expected ${what}, found ${describe(token)}`);
    this.next();

    return { kind: 'Identifier', name: token.text, start: token.start, end: token.end };
  }

  protected parseJsxAttribute(): ast.JsxAttribute | ast.JsxSpreadAttribute {
    const start = this.peek().start;

    if (this.accept('{')) {
      this.expect('...', '"..." (attributes in braces are spread: {...attrs})');

      const argument = this.nested(() => this.parseExpression());

      this.expect('}');

      return { kind: 'JsxSpreadAttribute', argument, ...this.span(start) };
    }

    const name = this.parseJsxName('attribute name');
    let value: ast.JsxAttribute['value'] = null;

    if (this.accept('=')) {
      const token = this.peek();

      if (token.kind === 'JsxString') {
        this.next();
        // Attribute strings have no escapes, so the JS literal is built from the value.
        value = {
          kind: 'StringLiteral',
          value: token.value,
          raw: JSON.stringify(token.value),
          start: token.start,
          end: token.end,
        };
      } else if (token.kind === '{') {
        this.next();
        value = /^on[A-Z]/.test(name.name)
          ? this.parseEventHandler()
          : this.nested(() => this.parseExpression());
        this.expect('}');
      } else {
        this.fail(`expected "..." or {...} after "${name.name}=", found ${describe(token)}`);
      }
    }

    return { kind: 'JsxAttribute', name, value, ...this.span(start) };
  }

  /**
   * The value of an `on*` attribute: a function is the handler itself; anything else is a list of
   * statements to run on the event, e.g. `{count++}` or `{event.preventDefault(); send()}`.
   */
  protected parseEventHandler(): ast.Expression | ast.EventHandler {
    const start = this.peek().start;
    const body: ast.SimpleStatement[] = [];

    this.withContext(
      { noObjectLiteral: false, inFunction: true, inLoop: false, inBreakable: false },
      () => {
        do {
          if (this.check('}')) break;
          body.push(this.parseSimpleStatement());
        } while (this.accept(';'));
      },
    );

    const [only] = body;

    if (body.length === 1 && only?.kind === 'ExpressionStatement') {
      if (isHandlerReference(only.expression)) return only.expression;
    }

    for (const statement of body) {
      if (statement.kind !== 'ExpressionStatement') continue;

      const { expression } = statement;

      if (expression.kind !== 'CallExpression' && expression.kind !== 'NewExpression') {
        this.error(
          'this expression does nothing: only function calls can be used as statements',
          expression.start,
          expression.end,
        );
      }
    }

    return { kind: 'EventHandler', body, ...this.span(start) };
  }

  /**
   * `{expression}` or `{if ...}` / `{for ...}` / `{switch ...}` among element children; `null` for
   * `{}` or `{/* comment *\/}`.
   */
  protected parseJsxExpressionContainer():
    ast.JsxExpressionContainer | ast.JsxStatementContainer | null {
    const start = this.expect('{').start;

    if (this.accept('}')) return null;
    if (this.check('if') || this.check('for') || this.check('switch')) {
      // `{for todo in todos { <li>{todo.title}</li> }}`: the blocks hold markup.
      const statement = this.withContext({ inMarkup: true, noObjectLiteral: false }, () =>
        this.parseOrdinaryStatement(),
      ) as ast.JsxStatementContainer['statement'];

      this.accept(';');
      this.expect('}');

      return { kind: 'JsxStatementContainer', statement, ...this.span(start) };
    }

    const expression = this.nested(() => this.parseExpression());

    this.expect('}');

    return { kind: 'JsxExpressionContainer', expression, ...this.span(start) };
  }

  protected override parseStringLiteral(what = 'string'): ast.StringLiteral {
    const token = this.peek();

    if (token.kind !== 'String') this.fail(`expected ${what}, found ${describe(token)}`);
    this.next();

    return {
      kind: 'StringLiteral',
      value: token.value,
      raw: token.text,
      start: token.start,
      end: token.end,
    };
  }
}
