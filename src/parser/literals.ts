import type * as ast from '../ast.ts';
import { isKeyword, type StringToken, type TokenKind } from '../lexer/token.ts';
import { ExpressionParser } from './expressions.ts';
import { FUNCTION_BODY, ParseError, describe, templateElement } from './syntax.ts';

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

  protected override parseArrowFunction(async = false): ast.ArrowFunction {
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

    const body = this.withContext({ ...FUNCTION_BODY, inAsync: async }, () =>
      this.check('{') ? this.parseBlock() : this.parseExpression(),
    );

    return {
      kind: 'ArrowFunction',
      ...(async ? { async } : {}),
      params,
      body,
      ...this.span(start),
    };
  }

  protected override parseParenthesized(): ast.Expression {
    this.expect('(');

    const expression = this.nested(() => this.parseExpression());

    this.expect(')');
    this.parenthesized.add(expression);

    return expression;
  }

  protected override parseFuncExpression(async = false): ast.FuncExpression {
    const start = this.expect('func').start;
    const params = this.parseParams(false);
    const results = this.parseResults();
    const body = this.parseFunctionBody(async);

    return {
      kind: 'FuncExpression',
      ...(async ? { async } : {}),
      params,
      results,
      body,
      ...this.span(start),
    };
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

  /** `make([]float64, n)` or `make([]float64, n, shared)`. */
  protected override parseMake(): ast.MakeExpression {
    const start = this.next().start;

    this.expect('(');

    const [type, length, shared] = this.nested(() => {
      const type = this.parseType();

      this.expect(',', '"," and the length: e.g. make([]float64, 100)');

      const length = this.parseExpression();
      let shared = false;

      if (this.accept(',') && !this.check(')')) {
        if (!this.checkWord('shared')) {
          this.fail('the third argument of make is the word shared: make([]float64, n, shared)');
        }

        this.next();
        shared = true;
        this.accept(',');
      }

      return [type, length, shared] as const;
    });

    this.expect(')');

    return { kind: 'MakeExpression', type, length, shared, ...this.span(start) };
  }

  /**
   * `queue<number>()` or `queue<number>(items)`. A variable may be named `queue`, so `queue < n`
   * that has no type and `(` after it is a comparison: then this gives null and reads nothing.
   */
  protected override parseQueue(): ast.QueueExpression | null {
    const { pos } = this;
    // Closing the type may split a `>>` token, and errors are reported as the type is read.
    const tokens = this.tokens.slice(pos);
    const reported = this.diagnostics.length;
    const start = this.next().start;
    let element: ast.TypeNode;

    try {
      this.expect('<');
      element = this.parseType();
      this.expectTypeClose('">" after the type of the values');
      if (!this.check('(')) throw new ParseError('not a queue');
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
      tokens.forEach((token, i) => (this.tokens[pos + i] = token));
      this.diagnostics.length = reported;
      this.pos = pos;

      return null;
    }

    this.next();

    const items = this.check(')') ? null : this.nested(() => this.parseExpression());

    this.accept(',');
    this.expect(
      ')',
      '")": a queue takes its first values as one array, e.g. queue<number>([1, 2])',
    );

    return { kind: 'QueueExpression', element, items, ...this.span(start) };
  }

  /** `chan(stream)` or `chan(stream, size)`, after `chan`. */
  protected override parseStreamChan(start: number): ast.StreamChanExpression {
    this.expect('(');

    const [stream, size] = this.nested(() => {
      const stream = this.parseExpression();
      const size = this.accept(',') && !this.check(')') ? this.parseExpression() : null;

      this.accept(',');

      return [stream, size] as const;
    });

    this.expect(')');

    return { kind: 'StreamChanExpression', stream, size, ...this.span(start) };
  }

  /** `[]byte("text")`: a type, then its value in parentheses. */
  protected override parseConversion(): ast.ConversionExpression {
    const { start } = this.peek();
    const type = this.parseType();

    this.expect('(', '"(" after the type: e.g. []byte("text") gives the bytes of a string');

    const argument = this.nested(() => this.parseExpression());

    this.expect(')');

    return { kind: 'ConversionExpression', type, argument, ...this.span(start) };
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
      while (true) {
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
