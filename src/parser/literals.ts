import type * as ast from '../ast.ts';
import { isKeyword, type StringToken, type TokenKind } from '../lexer/token.ts';
import { ExpressionParser } from './expressions.ts';
import { FUNCTION_BODY, describe, templateElement } from './syntax.ts';

// Functions, `new`, literals of arrays, objects and templates, names.

export abstract class LiteralParser extends ExpressionParser {
  /** Whether the `(` at the current position opens arrow function parameters: `(...) =>`. */
  protected override isArrowFunctionAhead(): boolean {
    let depth = 0;
    for (let i = this.pos; i < this.tokens.length; i++) {
      const kind = this.tokens[i]!.kind;
      if (kind === '(' || kind === '[' || kind === '{') {
        depth++;
      } else if (kind === ')' || kind === ']' || kind === '}') {
        depth--;
        if (depth === 0) return this.tokens[i + 1]?.kind === '=>';
      } else if (kind === 'EOF') {
        return false;
      }
    }
    return false;
  }

  protected override parseArrowFunction(): ast.ArrowFunction {
    const start = this.peek().start;
    let params: ast.Parameter[];
    if (this.check('Identifier')) {
      const name = this.parseIdentifier();
      params = [
        {
          kind: 'Parameter',
          name,
          type: null,
          defaultValue: null,
          start: name.start,
          end: name.end,
        },
      ];
    } else {
      params = this.parseParams(true);
    }
    this.expect('=>');
    const body = this.withContext(FUNCTION_BODY, () =>
      this.check('{') ? this.parseBlock() : this.parseExpression(),
    );
    return { kind: 'ArrowFunction', params, body, ...this.span(start) };
  }

  protected override parseParenthesized(): ast.Expression {
    this.expect('(');
    const expression = this.nested(() => this.parseExpression());
    this.expect(')');
    this.parenthesized.add(expression);
    return expression;
  }

  protected override parseFuncExpression(): ast.FuncExpression {
    const start = this.expect('func').start;
    const params = this.parseParams(false);
    const results = this.parseResults();
    const body = this.parseFunctionBody();
    return { kind: 'FuncExpression', params, results, body, ...this.span(start) };
  }

  protected override parseNew(): ast.NewExpression {
    const start = this.expect('new').start;
    // The class is a name or a member chain (`new ns.User()`); the parentheses are the arguments.
    let callee = this.parsePrimary();
    while (this.accept('.')) {
      const property = this.parsePropertyName();
      callee = {
        kind: 'MemberExpression',
        object: callee,
        property,
        optional: false,
        ...this.span(callee.start),
      };
    }
    const args = this.check('(') ? this.parseArguments() : [];
    return { kind: 'NewExpression', callee, arguments: args, ...this.span(start) };
  }

  protected override parseArguments(): (ast.Expression | ast.SpreadElement)[] {
    this.expect('(');
    return this.nested(() => this.parseList(')', () => this.parseElement()));
  }

  /** An expression or `...spread` in array literals and call arguments. */
  protected parseElement(): ast.Expression | ast.SpreadElement {
    if (!this.check('...')) return this.parseExpression();
    const start = this.next().start;
    const argument = this.parseExpression();
    return { kind: 'SpreadElement', argument, ...this.span(start) };
  }

  protected override parseArrayLiteral(): ast.ArrayLiteral {
    const start = this.expect('[').start;
    const elements = this.nested(() => this.parseList(']', () => this.parseElement()));
    return { kind: 'ArrayLiteral', elements, ...this.span(start) };
  }

  protected override parseObjectLiteral(): ast.ObjectLiteral {
    const start = this.expect('{').start;
    const properties = this.nested(() => this.parseList('}', () => this.parseProperty()));
    return { kind: 'ObjectLiteral', properties, ...this.span(start) };
  }

  protected parseProperty(): ast.Property | ast.SpreadElement {
    const token = this.peek();
    if (token.kind === '...') return this.parseElement() as ast.SpreadElement;
    const key = token.kind === 'String' ? this.parseStringLiteral() : this.parsePropertyName();
    if (this.accept(':')) {
      const value = this.parseExpression();
      return { kind: 'Property', key, value, shorthand: false, ...this.span(token.start) };
    }
    // Shorthand `{ name }` means `{ name: name }`, so the key must be a plain name.
    if (key.kind !== 'Identifier' || token.kind !== 'Identifier') {
      this.fail(`expected ":" after property name, found ${describe(this.peek())}`);
    }
    return { kind: 'Property', key, value: { ...key }, shorthand: true, ...this.span(token.start) };
  }

  protected override parseTemplate(first: StringToken): ast.TemplateLiteral {
    this.next();
    const quasis = [templateElement(first)];
    const expressions: ast.Expression[] = [];
    if (first.kind === 'TemplateHead') {
      for (;;) {
        expressions.push(this.nested(() => this.parseExpression()));
        const part = this.peek();
        if (part.kind !== 'TemplateMiddle' && part.kind !== 'TemplateTail') {
          this.fail(`expected "}" to close the template substitution, found ${describe(part)}`);
        }
        this.next();
        quasis.push(templateElement(part));
        if (part.kind === 'TemplateTail') break;
      }
    }
    return { kind: 'TemplateLiteral', quasis, expressions, ...this.span(first.start) };
  }

  /** Parses `item, item, ...` up to `close`, which is consumed. A trailing comma is allowed. */
  protected override parseList<T>(close: TokenKind, parseItem: () => T): T[] {
    const items: T[] = [];
    while (!this.check(close)) {
      items.push(parseItem());
      if (!this.accept(',')) break;
    }
    this.expect(close);
    return items;
  }

  protected override parseIdentifier(what = 'name'): ast.Identifier {
    const token = this.peek();
    if (token.kind !== 'Identifier') this.fail(`expected ${what}, found ${describe(token)}`);
    this.next();
    return { kind: 'Identifier', name: token.text, start: token.start, end: token.end };
  }

  /** Names after `.`, object keys and member names, where keywords are allowed too. */
  protected override parsePropertyName(what = 'property name'): ast.Identifier {
    const token = this.peek();
    if (token.kind !== 'Identifier' && !isKeyword(token.kind)) {
      this.fail(`expected ${what}, found ${describe(token)}`);
    }
    this.next();
    return { kind: 'Identifier', name: token.text, start: token.start, end: token.end };
  }
}
