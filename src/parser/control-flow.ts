import type * as ast from '../ast.ts';
import { StatementParser } from './statements.ts';

// if, for, switch, break and continue, throw, try and defer.

export abstract class ControlFlowParser extends StatementParser {
  protected override parseIf(): ast.IfStatement {
    const start = this.next().start;
    const condition = this.parseHeaderExpression();
    const consequent = this.parseBlock();
    let alternate: ast.BlockStatement | ast.IfStatement | null = null;

    this.checkSameLine('else');
    if (this.accept('else')) {
      alternate = this.check('if') ? this.parseIf() : this.parseBlock();
    }

    return { kind: 'IfStatement', condition, consequent, alternate, ...this.span(start) };
  }

  protected override parseFor(): ast.ForStatement | ast.ForInStatement {
    const start = this.next().start;

    if (this.isForInHeader()) return this.parseForIn(start);

    const [init, condition, update] = this.withContext({ noObjectLiteral: true }, () =>
      this.parseForHeader(),
    );
    const body = this.parseLoopBody();

    return { kind: 'ForStatement', init, condition, update, body, ...this.span(start) };
  }

  /** `for x in` or `for i, x in`. */
  protected isForInHeader(): boolean {
    if (!this.check('Identifier')) return false;
    if (this.peek(1).kind === 'in') return true;

    return (
      this.peek(1).kind === ',' && this.peek(2).kind === 'Identifier' && this.peek(3).kind === 'in'
    );
  }

  /** `{` (infinite loop), `cond {`, or `init; cond; update {`. */
  protected parseForHeader(): [
    ast.SimpleStatement | null,
    ast.Expression | null,
    ast.SimpleStatement | null,
  ] {
    if (this.check('{')) return [null, null, null];

    const init = this.check(';') ? null : this.parseSimpleStatement();

    if (init?.kind === 'ExpressionStatement' && this.check('{')) {
      return [null, init.expression, null];
    }

    this.expect(';', '";" or "{"');

    const condition = this.check(';') ? null : this.parseExpression();

    this.expect(';');

    const update = this.check('{') ? null : this.parseSimpleStatement();

    return [init, condition, update];
  }

  protected parseForIn(start: number): ast.ForInStatement {
    let key: ast.Identifier | null = null;
    let value = this.parseIdentifier('loop variable');

    if (this.accept(',')) {
      key = value;
      value = this.parseIdentifier('loop variable');
    }

    this.expect('in');

    const iterable = this.parseHeaderExpression();
    const body = this.parseLoopBody();

    return { kind: 'ForInStatement', key, value, iterable, body, ...this.span(start) };
  }

  protected parseLoopBody(): ast.BlockStatement {
    return this.withContext({ inLoop: true, inBreakable: true }, () => this.parseBlock());
  }

  protected override parseSwitch(): ast.SwitchStatement {
    const start = this.next().start;
    const discriminant = this.check('{') ? null : this.parseHeaderExpression();

    this.expect('{');

    const cases: ast.SwitchCase[] = [];
    let hasDefault = false;

    while (!this.check('}') && !this.check('EOF')) {
      if (this.accept(';')) continue;

      const caseStart = this.peek().start;
      let tests: ast.Expression[] = [];

      if (this.accept('default')) {
        if (hasDefault) {
          this.error('multiple "default" cases in switch', caseStart, this.span(caseStart).end);
        }

        hasDefault = true;
      } else {
        this.expect('case', '"case", "default" or "}"');
        tests = this.parseExpressionList();
      }

      this.expect(':');

      const body = this.withContext({ topLevel: false, inBreakable: true }, () =>
        this.parseStatements(() => this.check('case') || this.check('default') || this.check('}')),
      );

      cases.push({ kind: 'SwitchCase', tests, body, ...this.span(caseStart) });
    }

    this.expect('}');

    return { kind: 'SwitchStatement', discriminant, cases, ...this.span(start) };
  }

  protected override parseBreakOrContinue(): ast.BreakStatement | ast.ContinueStatement {
    const token = this.next();
    let statement: ast.BreakStatement | ast.ContinueStatement;

    if (token.kind === 'break') {
      if (!this.context.inBreakable) {
        this.error('"break" outside of a loop or switch', token.start, token.end);
      }

      statement = { kind: 'BreakStatement', start: token.start, end: token.end };
    } else {
      if (!this.context.inLoop) this.error('"continue" outside of a loop', token.start, token.end);
      statement = { kind: 'ContinueStatement', start: token.start, end: token.end };
    }

    this.endStatement();

    return statement;
  }

  protected override parseThrow(): ast.ThrowStatement {
    const start = this.next().start;
    const argument = this.parseExpression();
    const statement: ast.ThrowStatement = { kind: 'ThrowStatement', argument, ...this.span(start) };

    this.endStatement();

    return statement;
  }

  protected override parseTry(): ast.TryStatement {
    const start = this.next().start;
    const block = this.parseBlock();
    let handler: ast.CatchClause | null = null;
    let finalizer: ast.BlockStatement | null = null;

    this.checkSameLine('catch');
    if (this.check('catch')) {
      const catchStart = this.next().start;

      if (this.check('(')) this.fail('write "catch e {" without parentheses');

      const param = this.check('Identifier') ? this.parseIdentifier() : null;
      const body = this.parseBlock();

      handler = { kind: 'CatchClause', param, body, ...this.span(catchStart) };
    }

    this.checkSameLine('finally');
    if (this.accept('finally')) finalizer = this.parseBlock();

    if (handler === null && finalizer === null) {
      this.error('"try" needs a "catch" or "finally" block', start, block.start);
    }

    return { kind: 'TryStatement', block, handler, finalizer, ...this.span(start) };
  }

  protected override parseDefer(): ast.DeferStatement {
    const start = this.next().start;

    if (!this.context.inFunction) {
      this.error('"defer" outside of a function', start, this.span(start).end);
    }

    if (this.check('{')) {
      const body = this.withContext({ inDefer: true, inLoop: false, inBreakable: false }, () =>
        this.parseBlock(),
      );

      return { kind: 'DeferStatement', body, ...this.span(start) };
    }

    const call = this.parseExpression();

    if (call.kind !== 'CallExpression') {
      this.failAt('"defer" needs a function call or a block', call.start, call.end);
    }

    const statement: ast.DeferStatement = {
      kind: 'DeferStatement',
      body: call,
      ...this.span(start),
    };

    this.endStatement();

    return statement;
  }
}
