import type * as ast from '../ast.ts';
import { ClassParser } from './classes.ts';
import { describe } from './syntax.ts';

// Types: `?T`, `[]T`, unions, literal types, function and object types, type arguments.

export abstract class TypeParser extends ClassParser {
  /** `[number, string]` after the name of a generic type; `[]` would be an array type. */
  protected override parseTypeArgs(): ast.TypeNode[] {
    if (!this.check('[') || this.peek(1).kind === ']') return [];
    this.next();
    return this.parseList(']', () => this.parseType());
  }

  protected override canStartType(): boolean {
    switch (this.peek().kind) {
      case 'Identifier':
      case '[':
      case '?':
      case 'func':
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
      case '(': {
        // Grouping: `[](string | number)`, `?(A | B)`.
        this.next();
        const type = this.parseType();
        this.expect(')');
        return type;
      }
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
