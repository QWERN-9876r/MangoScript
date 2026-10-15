import type * as ast from '../ast.ts';
import { SimpleStatementParser } from './simple-statements.ts';
import { FOREIGN_KEYWORDS, FUNCTION_BODY, describe } from './syntax.ts';

// Statements: blocks, `return`, `mount()`, and which statement a token starts.

export abstract class StatementParser extends SimpleStatementParser {
  protected parseStatements(isEnd: () => boolean): ast.Statement[] {
    const body: ast.Statement[] = [];

    this.parseSeparated(isEnd, () => {
      body.push(this.parseStatement());
    });

    return body;
  }

  protected parseStatement(): ast.Statement {
    if (!this.context.inMarkup) return this.parseOrdinaryStatement();

    const start = this.peek().start;

    if (this.check('JsxTagOpen')) {
      const element = this.parseJsxElement();

      this.endStatement();

      return { kind: 'JsxElementStatement', element, ...this.span(start) };
    }

    const statement = this.parseOrdinaryStatement();
    const allowed =
      statement.kind === 'IfStatement' ||
      statement.kind === 'ForStatement' ||
      statement.kind === 'ForInStatement' ||
      statement.kind === 'SwitchStatement' ||
      (statement.kind === 'VariableDeclaration' && statement.keyword === 'const');

    if (statement.kind === 'BreakStatement' || statement.kind === 'ContinueStatement') {
      const word = statement.kind === 'BreakStatement' ? 'break' : 'continue';

      this.error(
        `"${word}" cannot be used inside markup: put the content in an if instead`,
        statement.start,
        statement.end,
      );
    } else if (!allowed) {
      this.error(
        'inside markup only elements, if, for, switch and const can be written',
        statement.start,
        statement.end,
      );
    }

    return statement;
  }

  protected parseOrdinaryStatement(): ast.Statement {
    const token = this.peek();
    const declaration = this.parseDeclaration(token.start, false);

    if (declaration) return declaration;

    switch (token.kind) {
      case 'import':
        return this.parseImport();

      case 'export':
        return this.parseExport();

      case '{':
        return this.parseBlock();

      case 'return':
        return this.parseReturn();

      case 'if':
        return this.parseIf();

      case 'for':
        return this.parseFor();

      case 'switch':
        return this.parseSwitch();

      case 'break':
      case 'continue':
        return this.parseBreakOrContinue();

      case 'throw':
        return this.parseThrow();

      case 'try':
        return this.parseTry();

      case 'defer':
        return this.parseDefer();

      default:
        break;
    }

    const hint = token.kind === 'Identifier' ? FOREIGN_KEYWORDS.get(token.text) : undefined;

    if (hint !== undefined && this.peek(1).kind === 'Identifier') {
      this.fail(`"${token.text}" is not a MangoScript keyword: ${hint}`);
    }

    if (this.isStyleBlock()) {
      // The lexer has read the block as CSS, so it is parsed as one to report a single error.
      const style = this.parseStyle();

      this.error(
        this.context.inComponent
          ? 'style is declared at the top level of a component, not inside blocks or functions'
          : 'style can only be declared inside a component',
        style.start,
        style.start + 'style'.length,
      );
      this.endStatement();

      return style;
    }

    const misplaced =
      this.isStateDeclaration() || this.isRefDeclaration()
        ? this.peek().text
        : this.isMountDeclaration()
          ? 'mount()'
          : this.isEffectDeclaration()
            ? 'effect'
            : null;

    if (misplaced !== null) {
      this.fail(
        this.context.inComponent
          ? `${misplaced} is declared at the top level of a component, not inside blocks or functions`
          : `${misplaced} can only be declared inside a component`,
      );
    }

    const statement = this.parseSimpleStatement();

    if (statement.kind === 'ExpressionStatement') {
      const { expression } = statement;

      const awaited = expression.kind === 'UnaryExpression' && expression.operator === 'await';

      if (expression.kind !== 'CallExpression' && expression.kind !== 'NewExpression' && !awaited) {
        this.error(
          'this expression does nothing: only function calls can be used as statements',
          expression.start,
          expression.end,
        );
      }
    }

    this.endStatement();

    return statement;
  }

  /** Parses a declaration if the current token starts one, otherwise returns `undefined`. */
  protected parseDeclaration(start: number, exported: boolean): ast.Statement | undefined {
    switch (this.peek().kind) {
      case 'func':
        // `func(...)` without a name is a function literal, e.g. one that is called right away.
        if (this.peek(1).kind !== 'Identifier') return undefined;

        return this.parseFuncDeclaration(start, exported);

      case 'async':
        if (this.peek(1).kind === 'comp') {
          this.fail('a component cannot be async: load the data in mount() or in an async func');
        }

        if (this.peek(1).kind !== 'func' || this.peek(2).kind !== 'Identifier') return undefined;

        return this.parseFuncDeclaration(start, exported);

      case 'let':
      case 'const': {
        const declaration = this.parseVariableDeclaration(start, exported);

        this.endStatement();

        return declaration;
      }

      case 'class':
        return this.parseClass(start, exported);

      case 'comp':
        return this.parseComponent(start, exported);

      case '@':
        // `@visible.show()` is a call; `@html-tag comp Page() {...}` and
        // `@visible("300px") export comp Page() {...}` are components with decorators.
        if (this.isDecoratorMember()) return undefined;

        return this.parseDecorated(start, exported);

      case 'interface':
        return this.parseInterface(start, exported);

      case 'type': {
        const declaration = this.parseTypeAlias(start, exported);

        this.endStatement();

        return declaration;
      }

      default:
        if (this.isDecoratorDeclaration()) return this.parseDecoratorDeclaration(start, exported);

        return undefined;
    }
  }

  /** A statement ends with a newline or `;`, or right before the `}` that closes its block. */
  protected endStatement(): void {
    if (this.accept(';') || this.check('}') || this.check('EOF')) return;

    const token = this.peek();

    if (token.kind === '++' || token.kind === '--') {
      this.fail(`"${token.kind}" is a statement and cannot be used inside an expression`);
    }

    this.fail(`expected newline or ";" after statement, found ${describe(token)}`);
  }

  /**
   * `state count = 0` or `derived double = count * 2`: `state` and `derived` are keywords only at
   * the start of a statement in a component.
   */
  protected isStateDeclaration(): boolean {
    return (
      (this.checkWord('state') || this.checkWord('derived')) && this.peek(1).kind === 'Identifier'
    );
  }

  /** `ref input`: like `state`, a keyword only at the start of a statement in a component. */
  protected isRefDeclaration(): boolean {
    return this.checkWord('ref') && this.peek(1).kind === 'Identifier';
  }

  /** `style {`: the lexer reads the block as CSS where it starts a statement. */
  protected isStyleBlock(): boolean {
    return this.checkWord('style') && this.peek(1).kind === '{';
  }

  /** `style { ... }`: CSS text and, in the values of declarations, `{expression}`. */
  protected parseStyle(): ast.StyleStatement {
    const { start } = this.next();
    const parts: ast.StyleStatement['parts'] = [];

    this.expect('{');
    while (!this.check('}') && !this.check('EOF')) {
      const token = this.peek();

      if (token.kind === 'CssText') {
        this.next();
        parts.push({ kind: 'CssText', value: token.value, start: token.start, end: token.end });
      } else {
        this.expect('{');
        parts.push(this.withContext({ noObjectLiteral: false }, () => this.parseExpression()));
        this.expect('}');
      }
    }

    this.expect('}');

    return { kind: 'StyleStatement', parts, ...this.span(start) };
  }

  /** `effect {`: like `state`, a keyword only at the start of a statement in a component. */
  protected isEffectDeclaration(): boolean {
    return this.checkWord('effect') && this.peek(1).kind === '{';
  }

  /** `mount() {`: like `state`, a keyword only at the start of a statement in a component. */
  protected isMountDeclaration(): boolean {
    return (
      this.checkWord('mount') &&
      this.peek(1).kind === '(' &&
      this.peek(2).kind === ')' &&
      this.peek(3).kind === '{'
    );
  }

  /** `mount() { ... }`; its body is a function that runs later, so `return` is its own. */
  protected parseMount(): ast.MountStatement {
    const { start } = this.next();

    this.expect('(');
    this.expect(')');

    const body = this.withContext({ ...FUNCTION_BODY, inComponent: true }, () => this.parseBlock());

    return { kind: 'MountStatement', body, ...this.span(start) };
  }

  /** `effect { ... }`: its body runs again later, so `return` and `defer` are its own. */
  protected parseEffect(): ast.EffectStatement {
    const { start } = this.next();
    const body = this.withContext({ ...FUNCTION_BODY, inComponent: true }, () => this.parseBlock());

    return { kind: 'EffectStatement', body, ...this.span(start) };
  }

  protected parseBlock(): ast.BlockStatement {
    const start = this.expect('{').start;
    const body = this.withContext({ topLevel: false, noObjectLiteral: false }, () =>
      this.parseStatements(() => this.check('}')),
    );

    this.expect('}');

    return { kind: 'BlockStatement', body, ...this.span(start) };
  }

  protected parseFunctionBody(async = false): ast.BlockStatement {
    return this.withContext({ ...FUNCTION_BODY, inAsync: async }, () => this.parseBlock());
  }

  /** An if/for/switch header, where `{` starts the block rather than an object literal. */
  protected parseHeaderExpression(): ast.Expression {
    return this.withContext({ noObjectLiteral: true }, () => this.parseExpression());
  }

  protected parseReturn(): ast.ReturnStatement {
    const start = this.next().start;

    if (!this.context.inFunction) {
      this.error('"return" outside of a function', start, this.span(start).end);
    } else if (this.context.inDefer) {
      this.error('"return" is not allowed inside "defer"', start, this.span(start).end);
    }

    const values =
      this.check(';') || this.check('}') || this.check('EOF') ? [] : this.parseExpressionList();
    const statement: ast.ReturnStatement = { kind: 'ReturnStatement', values, ...this.span(start) };

    this.endStatement();

    return statement;
  }

  /** `}` + newline + `else`: the newline ends the `if`, so explain the error instead of failing. */
  protected checkSameLine(keyword: 'else' | 'catch' | 'finally'): void {
    if (this.isImplicitSemicolon() && this.peek(1).kind === keyword) {
      const token = this.peek(1);

      this.error(
        `"${keyword}" must be on the same line as the closing "}"`,
        token.start,
        token.end,
      );
      this.next();
    }
  }
}
