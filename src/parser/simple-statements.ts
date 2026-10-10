import type * as ast from '../ast.ts';
import { ParserBase } from './base.ts';
import { isAssignmentOperator, describe, plural } from './syntax.ts';

// Simple statements, which `for` headers allow too: declarations of variables, assignments, `i++`
// and calls.

export abstract class SimpleStatementParser extends ParserBase {
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
    // Members of decorators are read-only outside them: the checker explains it.
    const assignable =
      target.kind === 'Identifier' ||
      target.kind === 'DecoratorGet' ||
      target.kind === 'DecoratorMember' ||
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

    return {
      kind: 'VariableDeclaration',
      exported,
      isPublic: false,
      keyword,
      names,
      type,
      values,
      start,
      end,
    };
  }
}
