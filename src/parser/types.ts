import type * as ast from '../ast.ts';
import { ClassParser } from './classes.ts';
import { describe } from './syntax.ts';

// Types: `?T`, `[]T`, unions, literal types, function, component and object types, type arguments.

export abstract class TypeParser extends ClassParser {
  /** `<number, string>` after the name of a generic type. */
  protected override parseTypeArgs(): ast.TypeNode[] {
    if (!this.accept('<')) return [];

    const args = [this.parseType()];

    while (this.accept(',')) args.push(this.parseType());
    this.expectTypeClose('">" after the type arguments');

    return args;
  }

  protected override canStartType(): boolean {
    switch (this.peek().kind) {
      case 'Identifier':
      case '[':
      case '?':
      case 'func':
      case 'comp':
      case 'chan':
      case '<-':
      case '{':
      case '(':
      case 'String':
      case 'Number':
      case 'true':
      case 'false':
        return true;

      default:
        return false;
    }
  }

  /** A type, possibly a union: `string | number`. */
  protected override parseType(): ast.TypeNode {
    const start = this.peek().start;
    const first = this.parsePrimaryType();

    if (!this.check('|')) return first;

    const types = [first];

    while (this.accept('|')) types.push(this.parsePrimaryType());

    return { kind: 'UnionType', types, ...this.span(start) };
  }

  protected parsePrimaryType(): ast.TypeNode {
    const start = this.peek().start;

    switch (this.peek().kind) {
      case '(':
        return this.parseParenthesizedType();

      case 'String': {
        const value = this.parseStringLiteral();

        return { kind: 'LiteralType', value, ...this.span(start) };
      }

      case 'Number':
      case 'true':
      case 'false': {
        const value = this.parsePrimary() as ast.NumberLiteral | ast.BooleanLiteral;

        return { kind: 'LiteralType', value, ...this.span(start) };
      }

      case '?': {
        this.next();

        const type = this.parsePrimaryType();

        return { kind: 'NullableType', type, ...this.span(start) };
      }

      case '[': {
        this.next();
        this.expect(']', '"]" (array types are written as []T)');

        const element = this.parsePrimaryType();

        return { kind: 'ArrayType', element, ...this.span(start) };
      }

      case 'func': {
        this.next();
        this.expect('(');

        const params = this.parseList(')', () => this.parseType());
        const results = this.parseResults();

        return { kind: 'FuncType', params, results, ...this.span(start) };
      }

      // `chan T`, `chan<- T` that only sends, `<-chan T` that only receives.
      case 'chan': {
        this.next();

        const direction = this.accept('<-') ? 'send' : 'both';
        const element = this.parsePrimaryType();

        return { kind: 'ChanType', element, direction, ...this.span(start) };
      }

      case '<-': {
        this.next();
        this.expect('chan', '"chan" after "<-": a channel that only receives is <-chan T');

        const element = this.parsePrimaryType();

        return { kind: 'ChanType', element, direction: 'receive', ...this.span(start) };
      }

      // `comp(title string)`: the names are those of the attributes, so they are required.
      case 'comp': {
        this.next();

        const params = this.parseParams(false);

        return { kind: 'ComponentType', params, ...this.span(start) };
      }

      case '{': {
        const members = this.parseTypeMembers();

        return { kind: 'ObjectType', members, ...this.span(start) };
      }

      default: {
        const name = this.parseIdentifier('type');
        const typeArgs = this.parseTypeArgs();

        return { kind: 'TypeReference', name, typeArgs, ...this.span(start) };
      }
    }
  }

  /**
   * Grouping, `[](string | number)`, or a function type written as an arrow,
   * `(paths []string) => Shape`, the same as `func([]string) Shape`. Its parameters may have
   * names, which only document them.
   */
  protected parseParenthesizedType(): ast.TypeNode {
    const start = this.next().start;
    const params = this.parseList(')', () => {
      if (this.check('Identifier') && this.startsNamedParam()) this.next();

      return this.parseType();
    });

    if (this.accept('=>')) {
      const result = this.parseType();
      const voids = result.kind === 'TypeReference' && result.name.name === 'void';

      return { kind: 'FuncType', params, results: voids ? [] : [result], ...this.span(start) };
    }

    if (params.length !== 1) {
      this.error(
        'types in parentheses are the parameters of a function type: (a A, b B) => R',
        start,
        this.span(start).end,
      );
    }

    return (
      params[0] ?? {
        kind: 'TypeReference',
        name: { kind: 'Identifier', name: 'any', start, end: start },
        typeArgs: [],
        start,
        end: start,
      }
    );
  }

  /** `paths []string` in `(paths []string) => Shape`: a name before the type of a parameter. */
  private startsNamedParam(): boolean {
    const next = this.peek(1);

    switch (next.kind) {
      case 'Identifier':
      case '?':
      case '{':
      case '(':
      case 'func':
      case 'chan':
      case '<-':
      case 'String':
      case 'Number':
        return true;

      // `x []number` is named.
      case '[':
        return this.peek(2).kind === ']';

      default:
        return false;
    }
  }

  /** `{ name string; x, y number; area() number }`, separated by newlines, `;` or `,`. */
  protected override parseTypeMembers(): ast.TypeMember[] {
    this.expect('{');

    const members: ast.TypeMember[] = [];

    this.parseSeparated(
      () => this.check('}'),
      () => {
        members.push(...this.parseTypeMember());
        if (!this.accept(',') && !this.accept(';') && !this.check('}')) {
          this.fail(`expected newline, ";" or "}" after member, found ${describe(this.peek())}`);
        }
      },
    );
    this.expect('}');

    return members;
  }

  protected parseTypeMember(): ast.TypeMember[] {
    const start = this.peek().start;

    // `[string]: Shape`: an object used as a map.
    if (this.accept('[')) {
      const key = this.parseType();

      if (key.kind !== 'TypeReference' || !['string', 'number'].includes(key.name.name)) {
        this.error(
          'the key of [key]: T is string or number, e.g. [string]: number',
          key.start,
          key.end,
        );
      }

      this.expect(']');
      this.expect(':', '":" and the type of the values, e.g. [string]: number');

      const type = this.parseType();

      return [{ kind: 'IndexSignature', key, type, ...this.span(start) }];
    }

    const name = this.parsePropertyName('member name');

    if (this.check('(')) {
      const params = this.parseParams(false);
      const results = this.parseResults();

      return [{ kind: 'MethodSignature', name, params, results, ...this.span(start) }];
    }

    // `x, y number` declares several properties of the same type.
    const names = [name];

    while (this.accept(',')) names.push(this.parsePropertyName('member name'));

    const type = this.parseType();

    return names.map((memberName): ast.PropertySignature => ({
      kind: 'PropertySignature',
      name: memberName,
      type,
      start: memberName.start,
      end: type.end,
    }));
  }
}
