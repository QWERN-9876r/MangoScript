import type * as ast from '../ast.ts';
import { DeclarationParser } from './declarations.ts';
import { describe, FUNCTION_BODY } from './syntax.ts';

// Decorators: their declarations `dec name(...) { ... }`, the decorators written before `comp`
// (`@html-tag` and `@visible("300px")`), and the access to their members, `get(@visible.shown)`
// and `@visible.show()`.

export abstract class DecoratorParser extends DeclarationParser {
  /** `dec visible(margin string = "0px") { ... }`: `dec` is a keyword only here. */
  protected isDecoratorDeclaration(): boolean {
    return this.checkWord('dec') && this.peek(1).kind === 'Identifier';
  }

  protected override parseDecoratorDeclaration(
    start: number,
    exported: boolean,
  ): ast.DecoratorDeclaration {
    const keyword = this.next();

    if (!this.context.topLevel) {
      this.error(
        'decorators can only be declared at the top level of a module',
        keyword.start,
        keyword.end,
      );
    }

    const name = this.parseIdentifier('decorator name');
    const params = this.parseParams(false, true);
    const needs = this.parseNeeds();
    const body = this.withContext({ ...FUNCTION_BODY, inComponent: true }, () =>
      this.parseDecoratorBody(),
    );

    return {
      kind: 'DecoratorDeclaration',
      exported,
      name,
      params,
      needs,
      body,
      ...this.span(start),
    };
  }

  /** `needs cart, auth` after the parameters: `needs` is a keyword only here. */
  protected parseNeeds(): ast.Identifier[] {
    if (!this.checkWord('needs')) return [];
    if (this.peek(1).kind !== 'Identifier') {
      this.fail('"needs" is followed by the decorators this one uses, e.g. needs cart');
    }

    this.next();

    const needs = [this.parseIdentifier('decorator name')];

    while (this.accept(',')) needs.push(this.parseIdentifier('decorator name'));

    return needs;
  }

  /** Like the body of a component, but `state`, `const` and `func` may be `public`. */
  protected parseDecoratorBody(): ast.BlockStatement {
    const start = this.expect('{').start;
    const body: ast.Statement[] = [];

    this.parseSeparated(
      () => this.check('}'),
      () => {
        if (this.isPublicModifier()) body.push(this.parsePublicMember());
        else body.push(this.parseComponentStatement());
      },
    );
    this.expect('}');

    return { kind: 'BlockStatement', body, ...this.span(start) };
  }

  /** `public` followed by a declaration; `public = 1` assigns a variable named `public`. */
  protected isPublicModifier(): boolean {
    const next = this.peek(1).kind;

    return (
      this.checkWord('public') &&
      (next === 'Identifier' || next === 'let' || next === 'const' || next === 'func')
    );
  }

  protected parsePublicMember(): ast.VariableDeclaration | ast.FuncDeclaration {
    const modifier = this.next();

    if (this.check('func')) {
      const declaration = this.parseFuncDeclaration(modifier.start, false);

      declaration.isPublic = true;

      return declaration;
    }

    if (!this.check('const') && !this.check('let') && !this.isStateDeclaration()) {
      this.fail(`only state, const and func can be public, not ${describe(this.peek())}`);
    }

    const declaration = this.parseVariableDeclaration(modifier.start, false);

    this.endStatement();
    if (declaration.keyword === 'let') {
      this.error(
        'a decorator has no "public let": a value that changes and is read outside is a state, one that does not change is a const',
        modifier.start,
        declaration.end,
      );
    }

    declaration.isPublic = true;

    return declaration;
  }

  /**
   * The decorators before `comp`: `@html-tag` first, then the others in the order they apply.
   * Each is on its own line or followed by the next one.
   */
  protected override parseDecorated(start: number, exported: boolean): ast.ComponentDeclaration {
    let htmlTag: ast.HtmlTag | null = null;
    const decorators: ast.DecoratorUse[] = [];

    while (this.check('@')) {
      if (this.isHtmlTag()) {
        const node = this.parseHtmlTag();

        if (htmlTag) {
          this.error('@html-tag is written once', node.start, node.end);
        } else if (decorators.length > 0) {
          this.error(
            '@html-tag must be the first decorator: the element is built from what the others give',
            node.start,
            node.end,
          );
        }

        htmlTag ??= node;
      } else {
        decorators.push(this.parseDecoratorUse());
      }

      // A line break after the decorator inserted a semicolon.
      if (this.isImplicitSemicolon()) this.next();
    }

    const isExported = this.accept('export') || exported;

    if (!this.check('comp')) {
      this.fail(
        `decorators are written before a component, as in @${decorators[0]?.name.name ?? 'html-tag'} comp MainPage() { ... }`,
      );
    }

    return this.parseComponent(start, isExported, htmlTag, decorators);
  }

  protected isHtmlTag(): boolean {
    return (
      this.peek(1).kind === 'Identifier' &&
      this.peek(1).text === 'html' &&
      this.peek(2).kind === '-' &&
      this.peek(3).kind === 'Identifier' &&
      this.peek(3).text === 'tag'
    );
  }

  /** `@html-tag` or `@html-tag("app-page")`. */
  protected parseHtmlTag(): ast.HtmlTag {
    const at = this.expect('@');

    this.next();
    this.next();
    this.next();

    let name: ast.StringLiteral | null = null;

    if (this.accept('(')) {
      name = this.parseStringLiteral('tag name');
      this.expect(')');
    }

    return { kind: 'HtmlTag', name, ...this.span(at.start) };
  }

  /** `@visible("300px")` or `@visible`: the arguments are positional, as in a call. */
  protected parseDecoratorUse(): ast.DecoratorUse {
    const at = this.expect('@');
    const name = this.parseIdentifier('decorator name');
    const args = this.check('(') ? this.parseArguments() : [];
    const spread = args.find((arg) => arg.kind === 'SpreadElement');

    if (spread) {
      this.error('arguments of a decorator cannot be spread', spread.start, spread.end);
    }

    return {
      kind: 'DecoratorUse',
      name,
      arguments: args.filter((arg) => arg.kind !== 'SpreadElement'),
      ...this.span(at.start),
    };
  }

  /** `@visible.show`: a member of a decorator; a statement may start with it. */
  protected isDecoratorMember(): boolean {
    return this.check('@') && this.peek(1).kind === 'Identifier' && this.peek(2).kind === '.';
  }

  protected parseDecoratorMember(): ast.DecoratorMember {
    const at = this.expect('@');
    const decorator = this.parseIdentifier('decorator name');

    this.expect('.', '"." and a member, e.g. @visible.show()');

    const member = this.parsePropertyName('member name');

    return { kind: 'DecoratorMember', decorator, member, ...this.span(at.start) };
  }

  /** `get(@visible.shown)`: `get` is special only when its argument starts with `@`. */
  protected isDecoratorGet(): boolean {
    return this.checkWord('get') && this.peek(1).kind === '(' && this.peek(2).kind === '@';
  }

  protected parseDecoratorGet(): ast.DecoratorGet {
    const start = this.next().start;

    this.expect('(');

    const target = this.parseDecoratorMember();

    this.expect(')', '")": get takes one member of a decorator, e.g. get(@visible.shown)');

    return { kind: 'DecoratorGet', target, ...this.span(start) };
  }
}
