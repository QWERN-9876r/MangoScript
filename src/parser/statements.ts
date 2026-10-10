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

    if (this.isStateDeclaration()) {
      this.fail(
        this.context.inComponent
          ? 'state is declared at the top level of a component, not inside blocks or functions'
          : 'state can only be declared inside a component',
      );
    }

    if (this.isMountDeclaration()) {
      this.fail(
        this.context.inComponent
          ? 'mount() is declared at the top level of a component, not inside blocks or functions'
          : 'mount() can only be declared inside a component',
      );
    }

    const statement = this.parseSimpleStatement();

    if (statement.kind === 'ExpressionStatement') {
      const { expression } = statement;

      if (expression.kind !== 'CallExpression' && expression.kind !== 'NewExpression') {
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

  /** `state count = 0`: `state` is a keyword only at the start of a statement in a component. */
  protected isStateDeclaration(): boolean {
    return this.checkWord('state') && this.peek(1).kind === 'Identifier';
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

  protected parseBlock(): ast.BlockStatement {
    const start = this.expect('{').start;
    const body = this.withContext({ topLevel: false, noObjectLiteral: false }, () =>
      this.parseStatements(() => this.check('}')),
    );

    this.expect('}');

    return { kind: 'BlockStatement', body, ...this.span(start) };
  }

  protected parseFunctionBody(): ast.BlockStatement {
    return this.withContext(FUNCTION_BODY, () => this.parseBlock());
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
