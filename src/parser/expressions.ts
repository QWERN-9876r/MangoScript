import type * as ast from '../ast.ts';
import {
  BINARY_PRECEDENCE,
  isBinaryOperator,
  isUnaryOperator,
  RESERVED,
  describe,
} from './syntax.ts';
import { TypeParser } from './types.ts';

// Expressions: operators with their precedence, member access, calls and indexing.

export abstract class ExpressionParser extends TypeParser {
  protected override parseExpression(): ast.Expression {
    const test = this.parseBinary(1);

    if (!this.accept('?')) return test;

    const consequent = this.parseExpression();

    this.expect(':');

    const alternate = this.parseExpression();

    return {
      kind: 'ConditionalExpression',
      test,
      consequent,
      alternate,
      start: test.start,
      end: alternate.end,
    };
  }

  /** Precedence climbing: parses operators that bind at least as tight as `minPrecedence`. */
  protected parseBinary(minPrecedence: number): ast.Expression {
    let left = this.parseUnary();

    for (;;) {
      const operator = this.peek().kind;

      if (!isBinaryOperator(operator)) return left;

      const precedence = BINARY_PRECEDENCE[operator];

      if (precedence < minPrecedence) return left;
      this.next();

      // `**` is right-associative, all other binary operators are left-associative.
      const right = this.parseBinary(operator === '**' ? precedence : precedence + 1);

      left = this.makeBinary(operator, left, right);
    }
  }

  /** Rejects combinations that JS forbids without parentheses, since the output must be valid JS. */
  protected makeBinary(
    operator: ast.BinaryOperator,
    left: ast.Expression,
    right: ast.Expression,
  ): ast.BinaryExpression {
    if (operator === '??') {
      for (const operand of [left, right]) {
        if (
          operand.kind === 'BinaryExpression' &&
          (operand.operator === '||' || operand.operator === '&&') &&
          !this.parenthesized.has(operand)
        ) {
          this.error(
            '"??" cannot be mixed with "||" or "&&" without parentheses',
            operand.start,
            operand.end,
          );
        }
      }
    }

    if (operator === '**' && left.kind === 'UnaryExpression' && !this.parenthesized.has(left)) {
      this.error(
        'wrap the unary expression in parentheses: "(-a) ** b" or "-(a ** b)"',
        left.start,
        left.end,
      );
    }

    return { kind: 'BinaryExpression', operator, left, right, start: left.start, end: right.end };
  }

  protected parseUnary(): ast.Expression {
    const token = this.peek();

    if (isUnaryOperator(token.kind)) {
      const operator = token.kind;

      this.next();

      const argument = this.parseUnary();

      return { kind: 'UnaryExpression', operator, argument, start: token.start, end: argument.end };
    }

    if (token.kind === '++' || token.kind === '--') {
      this.fail(`"${token.kind}" must follow the variable: "i${token.kind}"`);
    }

    return this.parsePostfix(this.parsePrimary());
  }

  /** Member access, indexing and calls: `a.b`, `a?.b`, `a[i]`, `a?.[i]`, `f(x)`, `f?.(x)`. */
  protected override parsePostfix(expression: ast.Expression): ast.Expression {
    for (;;) {
      const start = expression.start;

      if (this.accept('.')) {
        const property = this.parsePropertyName();

        expression = {
          kind: 'MemberExpression',
          object: expression,
          property,
          optional: false,
          ...this.span(start),
        };
      } else if (this.accept('?.')) {
        if (this.check('(')) {
          const args = this.parseArguments();

          expression = {
            kind: 'CallExpression',
            callee: expression,
            arguments: args,
            optional: true,
            ...this.span(start),
          };
        } else if (this.accept('[')) {
          const index = this.nested(() => this.parseExpression());

          this.expect(']');
          expression = {
            kind: 'IndexExpression',
            object: expression,
            index,
            optional: true,
            ...this.span(start),
          };
        } else {
          const property = this.parsePropertyName();

          expression = {
            kind: 'MemberExpression',
            object: expression,
            property,
            optional: true,
            ...this.span(start),
          };
        }
      } else if (this.check('(')) {
        const args = this.parseArguments();

        expression = {
          kind: 'CallExpression',
          callee: expression,
          arguments: args,
          optional: false,
          ...this.span(start),
        };
      } else if (this.accept('[')) {
        const index = this.nested(() => this.parseExpression());

        this.expect(']');
        expression = {
          kind: 'IndexExpression',
          object: expression,
          index,
          optional: false,
          ...this.span(start),
        };
      } else {
        return expression;
      }
    }
  }

  protected override parsePrimary(): ast.Expression {
    const token = this.peek();
    const { start, end } = token;

    switch (token.kind) {
      case 'Identifier':
        if (this.peek(1).kind === '=>') return this.parseArrowFunction();
        if (this.isDecoratorGet()) return this.parseDecoratorGet();
        this.next();

        return { kind: 'Identifier', name: token.text, start, end };

      case 'Number':
        this.next();

        return { kind: 'NumberLiteral', value: token.value, raw: token.text, start, end };

      case 'String':
        return this.parseStringLiteral();

      case 'Template':
      case 'TemplateHead':
        return this.parseTemplate(token);

      case 'true':
      case 'false':
        this.next();

        return { kind: 'BooleanLiteral', value: token.kind === 'true', start, end };

      case 'null':
        this.next();

        return { kind: 'NullLiteral', start, end };

      case 'this':
        this.next();

        return { kind: 'ThisExpression', start, end };

      case 'super':
        this.next();
        if (!this.check('(') && !this.check('.'))
          this.fail('"super" must be followed by "(" or "."');

        return { kind: 'SuperExpression', start, end };

      case '(':
        return this.isArrowFunctionAhead() ? this.parseArrowFunction() : this.parseParenthesized();

      case '[':
        return this.parseArrayLiteral();

      case '{':
        if (this.context.noObjectLiteral) {
          this.fail('expected expression, found "{" (wrap object literals in parentheses here)');
        }

        return this.parseObjectLiteral();

      case 'func':
        return this.parseFuncExpression();

      case 'new':
        return this.parseNew();

      case 'JsxTagOpen':
        return this.parseJsxElement();

      case '@':
        return this.parseDecoratorMember();

      default:
        if (RESERVED.has(token.kind)) this.fail(`"${token.text}" is reserved for future use`);

        return this.fail(`expected expression, found ${describe(token)}`);
    }
  }
}
