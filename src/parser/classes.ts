import type * as ast from '../ast.ts';
import { isKeyword } from '../lexer/token.ts';
import { DeclarationParser } from './declarations.ts';
import { MODIFIERS } from './syntax.ts';

// Classes and their members, interfaces and `type` aliases.

export abstract class ClassParser extends DeclarationParser {
  protected override parseClass(start: number, exported: boolean): ast.ClassDeclaration {
    this.expect('class');
    const name = this.parseIdentifier('class name');
    const typeParams = this.parseTypeParams();

    let superClass: ast.Expression | null = null;
    if (this.accept('extends')) {
      superClass = this.withContext({ noObjectLiteral: true }, () =>
        this.parsePostfix(this.parsePrimary()),
      );
    }

    const interfaces: ast.TypeReference[] = [];
    if (this.acceptWord('implements')) {
      do {
        const interfaceName = this.parseIdentifier('interface name');
        interfaces.push({
          kind: 'TypeReference',
          name: interfaceName,
          typeArgs: this.parseTypeArgs(),
          ...this.span(interfaceName.start),
        });
      } while (this.accept(','));
    }

    this.expect('{');
    const members: ast.ClassMember[] = [];
    this.withContext({ topLevel: false }, () => {
      this.parseSeparated(
        () => this.check('}'),
        () => {
          members.push(...this.parseClassMember());
        },
      );
    });
    this.expect('}');
    return {
      kind: 'ClassDeclaration',
      exported,
      name,
      typeParams,
      superClass,
      implements: interfaces,
      members,
      ...this.span(start),
    };
  }

  protected parseClassMember(): ast.ClassMember[] {
    const start = this.peek().start;
    let visibility: ast.Visibility | null = null;
    let isStatic = false;

    // Modifiers are contextual: `static` is a modifier only when a member name follows it.
    while (this.peek().kind === 'Identifier' && MODIFIERS.has(this.peek().text)) {
      const following = this.peek(1);
      if (following.kind !== 'Identifier' && !isKeyword(following.kind)) break;
      const modifier = this.next();
      if (modifier.text === 'static') {
        if (isStatic) this.error('duplicate "static" modifier', modifier.start, modifier.end);
        isStatic = true;
      } else {
        if (visibility) this.error('duplicate visibility modifier', modifier.start, modifier.end);
        visibility = modifier.text as ast.Visibility;
      }
    }

    if (this.checkWord('constructor') && this.peek(1).kind === '(') {
      this.next();
      if (isStatic) this.error('constructors cannot be static', start, this.span(start).end);
      const params = this.parseParams(false);
      const resultsStart = this.peek().start;
      if (this.parseResults().length > 0) {
        this.error('constructors cannot have result types', resultsStart, this.span(start).end);
      }
      const body = this.parseFunctionBody();
      return [
        {
          kind: 'ConstructorDeclaration',
          visibility: visibility ?? 'public',
          params,
          body,
          ...this.span(start),
        },
      ];
    }

    const name = this.parsePropertyName('member name');
    if (this.check('(')) {
      const params = this.parseParams(false);
      const results = this.parseResults();
      const body = this.parseFunctionBody();
      return [
        {
          kind: 'MethodDeclaration',
          visibility: visibility ?? 'public',
          isStatic,
          name,
          params,
          results,
          body,
          ...this.span(start),
        },
      ];
    }

    // Fields: `name string`, `count = 0`, `x, y number`.
    const names = [name];
    while (this.accept(',')) names.push(this.parsePropertyName('field name'));
    const type = this.canStartType() ? this.parseType() : null;
    const value = this.accept('=') ? this.parseExpression() : null;
    const span = this.span(start);
    if (type === null && value === null) {
      this.error(`field "${name.name}" needs a type or a value`, span.start, span.end);
    } else if (names.length > 1 && value !== null) {
      this.error('a value can only be given to a single field', span.start, span.end);
    }
    this.endStatement();
    return names.map((fieldName): ast.FieldDeclaration => ({
      kind: 'FieldDeclaration',
      visibility: visibility ?? 'public',
      isStatic,
      name: fieldName,
      type,
      value,
      ...span,
    }));
  }

  protected override parseInterface(start: number, exported: boolean): ast.InterfaceDeclaration {
    this.expect('interface');
    const name = this.parseIdentifier('interface name');
    const typeParams = this.parseTypeParams();
    const members = this.parseTypeMembers();
    return {
      kind: 'InterfaceDeclaration',
      exported,
      name,
      typeParams,
      members,
      ...this.span(start),
    };
  }

  protected override parseTypeAlias(start: number, exported: boolean): ast.TypeAliasDeclaration {
    this.expect('type');
    const name = this.parseIdentifier('type name');
    const typeParams = this.parseTypeParams();
    const type = this.parseType();
    return {
      kind: 'TypeAliasDeclaration',
      exported,
      name,
      typeParams,
      type,
      ...this.span(start),
    };
  }
}
