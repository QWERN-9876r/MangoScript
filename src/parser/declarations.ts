import type * as ast from '../ast.ts';
import { ControlFlowParser } from './control-flow.ts';
import { describe, FUNCTION_BODY } from './syntax.ts';

// Imports and exports, functions and components with their parameters and results.

export abstract class DeclarationParser extends ControlFlowParser {
  protected override parseImport(): ast.ImportDeclaration {
    const start = this.next().start;
    if (!this.context.topLevel) {
      this.error(
        'imports are only allowed at the top level of a module',
        start,
        this.span(start).end,
      );
    }
    let defaultImport: ast.Identifier | null = null;
    let namespaceImport: ast.Identifier | null = null;
    let namedImports: ast.ImportSpecifier[] = [];

    if (!this.check('String')) {
      const hasDefault = this.check('Identifier');
      if (hasDefault) defaultImport = this.parseIdentifier('import name');
      if (!hasDefault || this.accept(',')) {
        if (this.accept('*')) {
          this.expectWord('as');
          namespaceImport = this.parseIdentifier('namespace name');
        } else {
          this.expect('{', '"{", "*" or a name');
          namedImports = this.parseList('}', () => this.parseImportSpecifier());
        }
      }
      this.expectWord('from');
    }

    const source = this.parseStringLiteral('module path');
    const declaration: ast.ImportDeclaration = {
      kind: 'ImportDeclaration',
      defaultImport,
      namespaceImport,
      namedImports,
      source,
      ...this.span(start),
    };
    this.endStatement();
    return declaration;
  }

  protected parseImportSpecifier(): ast.ImportSpecifier {
    const token = this.peek();
    const imported = this.parsePropertyName('import name');
    let local = imported;
    if (this.acceptWord('as')) {
      local = this.parseIdentifier('import name');
    } else if (token.kind !== 'Identifier') {
      this.error(`"${token.text}" is a keyword: rename it with "as"`, token.start, token.end);
    }
    return { kind: 'ImportSpecifier', imported, local, ...this.span(token.start) };
  }

  protected override parseExport(): ast.Statement {
    const start = this.next().start;
    if (!this.context.topLevel) {
      this.error(
        '"export" is only allowed at the top level of a module',
        start,
        this.span(start).end,
      );
    }
    return (
      this.parseDeclaration(start, true) ??
      this.fail(`expected a declaration after "export", found ${describe(this.peek())}`)
    );
  }

  protected override parseFuncDeclaration(start: number, exported: boolean): ast.FuncDeclaration {
    this.expect('func');
    const name = this.parseIdentifier('function name');
    const typeParams = this.parseTypeParams();
    const params = this.parseParams(false);
    const results = this.parseResults();
    const body = this.parseFunctionBody();
    return {
      kind: 'FuncDeclaration',
      exported,
      name,
      typeParams,
      params,
      results,
      body,
      ...this.span(start),
    };
  }

  /**
   * `[T any, U Shape]` after a name, as in Go; `[K, V any]` gives both the constraint. A `[` with
   * a name after it starts them: `[]T` is an array type.
   */
  protected parseTypeParams(): ast.TypeParameter[] {
    if (!this.check('[') || this.peek(1).kind !== 'Identifier') return [];
    this.next();
    const params: ast.TypeParameter[] = [];
    let pending: ast.Identifier[] = [];
    const finish = (constraint: ast.TypeNode | null) => {
      for (const name of pending) {
        params.push({
          kind: 'TypeParameter',
          name,
          constraint,
          start: name.start,
          end: constraint?.end ?? name.end,
        });
      }
      pending = [];
    };
    do {
      pending.push(this.parseIdentifier('type parameter name'));
      if (!this.check(',') && !this.check(']')) finish(this.parseType());
    } while (this.accept(','));
    finish(null);
    this.expect(']', '"]" after the type parameters');
    return params;
  }

  /**
   * `(a, b number, c string)`. Names without a type take the type of the next typed name, as in
   * Go; only arrow functions may leave types out entirely.
   */
  protected parseParams(typesOptional: boolean, allowDefaults = false): ast.Parameter[] {
    this.expect('(');
    const params: ast.Parameter[] = [];
    let untyped = 0;
    while (!this.check(')')) {
      const name = this.parseIdentifier('parameter name');
      const type = this.canStartType() ? this.parseType() : null;
      const defaultValue = allowDefaults && this.accept('=') ? this.parseExpression() : null;
      params.push({ kind: 'Parameter', name, type, defaultValue, ...this.span(name.start) });
      if (type === null) {
        untyped++;
      } else {
        for (const param of params.slice(params.length - 1 - untyped)) param.type = type;
        untyped = 0;
      }
      if (!this.accept(',')) break;
    }
    this.expect(')');
    if (untyped > 0 && !typesOptional) {
      const param = params[params.length - untyped]!;
      this.error(`missing type for parameter "${param.name.name}"`, param.start, param.end);
    }
    return params;
  }

  /** Result types after a parameter list: nothing, `T`, or `(T1, T2)`. */
  protected parseResults(): ast.TypeNode[] {
    if (this.accept('(')) return this.parseList(')', () => this.parseType());
    // `{` after the parameters starts the body, so an object result type needs parentheses.
    if (this.canStartType() && !this.check('{')) return [this.parseType()];
    return [];
  }

  /** `comp Name(properties) { ...; return <markup> }` */
  protected override parseComponent(start: number, exported: boolean): ast.ComponentDeclaration {
    const keyword = this.expect('comp');
    if (!this.context.topLevel) {
      this.error(
        'components can only be declared at the top level of a module',
        keyword.start,
        keyword.end,
      );
    }
    const name = this.parseIdentifier('component name');
    if (!/^[A-Z]/.test(name.name)) {
      this.error(
        `component names start with a capital letter, as in <${name.name.charAt(0).toUpperCase()}${name.name.slice(1)} />`,
        name.start,
        name.end,
      );
    }
    const params = this.parseParams(false, true);
    const body = this.withContext({ ...FUNCTION_BODY, inComponent: true }, () =>
      this.parseComponentBody(),
    );
    return { kind: 'ComponentDeclaration', exported, name, params, body, ...this.span(start) };
  }

  /** Like a function body, but its own statements may also declare `state` and `mount()`. */
  protected parseComponentBody(): ast.BlockStatement {
    const start = this.expect('{').start;
    const body: ast.Statement[] = [];
    this.parseSeparated(
      () => this.check('}'),
      () => {
        if (this.isMountDeclaration()) {
          body.push(this.parseMount());
          this.endStatement();
          return;
        }
        if (!this.isStateDeclaration()) {
          body.push(this.parseStatement());
          return;
        }
        const declaration = this.parseVariableDeclaration(this.peek().start, false);
        this.endStatement();
        body.push(declaration);
      },
    );
    this.expect('}');
    return { kind: 'BlockStatement', body, ...this.span(start) };
  }
}
