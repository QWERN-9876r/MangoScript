import type * as ast from '../ast.ts';
import { ParserBase } from './base.ts';
import {
  isAssignmentOperator,
  FOREIGN_KEYWORDS,
  FUNCTION_BODY,
  describe,
  plural,
} from './syntax.ts';

// Statements: declarations of variables, assignments, blocks, `return`, `mount()`.

export abstract class StatementParser extends ParserBase {
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
      case 'interface':
        return this.parseInterface(start, exported);
      case 'type': {
        const declaration = this.parseTypeAlias(start, exported);
        this.endStatement();
        return declaration;
      }
      default:
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

  /** `x := 1` is a common habit from Go. */
  protected rejectColonEquals(): void {
    const colon = this.peek();
    const equals = this.peek(1);
    if (colon.kind === ':' && equals.kind === '=' && equals.start === colon.end) {
      this.fail('":=" is not supported: declare variables with "let" or "const"');
    }
  }

  /** Statements allowed in `for` headers: declarations, assignments, `i++` and expressions. */
  protected parseSimpleStatement(): ast.SimpleStatement {
    const start = this.peek().start;
    if (this.check('let') || this.check('const'))
      return this.parseVariableDeclaration(start, false);

    const first = this.parseExpression();
    this.rejectColonEquals();

    if (this.check(',') || isAssignmentOperator(this.peek().kind)) {
      const targets = [first];
      while (this.accept(',')) targets.push(this.parseExpression());
      this.rejectColonEquals();
      const operator = this.peek().kind;
      if (!isAssignmentOperator(operator)) {
        return this.fail(`expected "=", found ${describe(this.peek())}`);
      }
      this.next();
      if (operator !== '=' && targets.length > 1) {
        this.error(`"${operator}" works with a single variable`, start, this.span(start).end);
      }
      for (const target of targets) this.checkAssignable(target);
      const values = this.parseExpressionList();
      this.checkArity(targets.length, values, start);
      return { kind: 'AssignmentStatement', operator, targets, values, ...this.span(start) };
    }

    if (this.check('++') || this.check('--')) {
      const operator = this.next().kind === '++' ? '++' : '--';
      this.checkAssignable(first);
      return { kind: 'IncDecStatement', operator, target: first, ...this.span(start) };
    }

    return { kind: 'ExpressionStatement', expression: first, ...this.span(start) };
  }

  protected checkAssignable(target: ast.Expression): void {
    const assignable =
      target.kind === 'Identifier' ||
      ((target.kind === 'MemberExpression' || target.kind === 'IndexExpression') &&
        !target.optional);
    if (!assignable) this.error('cannot assign to this expression', target.start, target.end);
  }

  /** `a, b = 1, 2, 3`: the counts must match, unless a single call returns all the values. */
  protected checkArity(targets: number, values: ast.Expression[], start: number): void {
    if (values.length === 0 || values.length === targets) return;
    if (values.length === 1 && values[0]!.kind === 'CallExpression') return;
    this.error(
      `assignment mismatch: ${plural(targets, 'variable')} but ${plural(values.length, 'value')}`,
      start,
      this.span(start).end,
    );
  }

  protected parseExpressionList(): ast.Expression[] {
    const expressions = [this.parseExpression()];
    while (this.accept(',')) expressions.push(this.parseExpression());
    return expressions;
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

  protected parseVariableDeclaration(start: number, exported: boolean): ast.VariableDeclaration {
    const token = this.next();
    const keyword = token.kind === 'const' ? 'const' : token.text === 'state' ? 'state' : 'let';
    const names = [this.parseIdentifier('variable name')];
    while (this.accept(',')) names.push(this.parseIdentifier('variable name'));
    const type = this.canStartType() ? this.parseType() : null;
    const values = this.accept('=') ? this.parseExpressionList() : [];
    const { end } = this.span(start);

    if (values.length === 0 && type === null) {
      this.error(`"${names[0]!.name}" needs a type or a value`, start, end);
    } else if (values.length === 0 && keyword === 'const') {
      this.error('constants need a value', start, end);
    }
    this.checkArity(names.length, values, start);
    return { kind: 'VariableDeclaration', exported, keyword, names, type, values, start, end };
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
