import type * as ast from '../ast.ts';
import { ExpressionChecker } from './expressions.ts';
import { isUntyped, isNumeric, instanceTypeOf, withNarrowing } from './helpers.ts';
import {
  ANY,
  BOOL,
  commonType,
  isAssignable,
  isComparable,
  isNullable,
  nonNull,
  nullable,
  NUMBER,
  STRING,
  typeToString,
  UNKNOWN,
  widenLiterals,
  type Type,
} from './types.ts';

// Unary, binary and conditional operators.

export abstract class OperatorChecker extends ExpressionChecker {
  protected override checkUnary(node: ast.UnaryExpression): Type {
    const type = this.checkValue(node.argument);
    switch (node.operator) {
      case 'typeof':
        return STRING;
      case '!':
        this.expectBool(type, node.argument, '"!"');
        return BOOL;
      case '-':
      case '+':
      case '~':
        if (!isNumeric(type)) {
          this.error(`"${node.operator}" needs a number, not ${typeToString(type)}`, node.argument);
        }
        return NUMBER;
    }
  }

  protected expectBool(given: Type, node: ast.NodeBase, operator: string): void {
    const type = widenLiterals(given);
    if (type.kind === 'bool' || type.kind === 'any' || type.kind === 'unknown') return;
    const hint = isNullable(type) ? ': compare it with null, e.g. "x != null"' : '';
    this.error(`${operator} needs bool, not ${typeToString(type)}${hint}`, node);
  }

  protected override checkBinary(node: ast.BinaryExpression, expected: Type | null): Type {
    const { operator } = node;
    if (operator === '&&' || operator === '||') {
      this.expectBool(this.checkValue(node.left, BOOL), node.left, `"${operator}"`);
      // `x != null && x.ok`: the right side runs only when the left side allows it.
      const saved = this.flow;
      this.flow = withNarrowing(saved, this.narrow(node.left, operator === '&&'));
      this.expectBool(this.checkValue(node.right, BOOL), node.right, `"${operator}"`);
      this.flow = saved;
      return BOOL;
    }
    if (operator === '??') {
      const left = this.checkValue(node.left, expected && nullable(expected));
      const right = this.checkValue(node.right, expected ?? nonNull(left));
      return this.binaryResult(operator, left, right, node);
    }
    const left = this.checkValue(node.left);
    const right = this.checkValue(node.right, operator === '==' || operator === '!=' ? left : null);
    return this.binaryResult(operator, left, right, node);
  }

  /** The type of `left <operator> right`, also used for compound assignments like `+=`. */
  protected override binaryResult(
    operator: ast.BinaryOperator,
    givenLeft: Type,
    givenRight: Type,
    node: ast.NodeBase,
  ): Type {
    // Literals behave as their base types, except where they are compared.
    const keepLiterals = operator === '==' || operator === '!=' || operator === '??';
    const left = keepLiterals ? givenLeft : widenLiterals(givenLeft);
    const right = keepLiterals ? givenRight : widenLiterals(givenRight);
    const untyped = isUntyped(left) || isUntyped(right);
    const nullHint =
      isNullable(left) || isNullable(right) ? ': a value may be null, check it first' : '';
    switch (operator) {
      case '+':
        if (left.kind === 'number' && right.kind === 'number') return NUMBER;
        if (left.kind === 'string' && right.kind === 'string') return STRING;
        if (untyped) return left.kind === 'string' || right.kind === 'string' ? STRING : ANY;
        this.error(
          `cannot add ${typeToString(left)} and ${typeToString(right)}` +
            (nullHint ||
              (left.kind === 'string' || right.kind === 'string'
                ? ': use a template string, e.g. `${a}${b}`'
                : '')),
          node,
        );
        return UNKNOWN;
      case '-':
      case '*':
      case '/':
      case '%':
      case '**':
      case '<<':
      case '>>':
      case '>>>':
      case '&':
      case '|':
      case '^':
        if (!isNumeric(left) || !isNumeric(right)) {
          this.error(
            `"${operator}" needs numbers, not ${typeToString(left)} and ${typeToString(right)}${nullHint}`,
            node,
          );
        }
        return NUMBER;
      case '<':
      case '>':
      case '<=':
      case '>=': {
        const ordered =
          untyped ||
          (left.kind === 'number' && right.kind === 'number') ||
          (left.kind === 'string' && right.kind === 'string');
        if (!ordered) {
          this.error(
            `cannot compare ${typeToString(left)} and ${typeToString(right)} with "${operator}"${nullHint}`,
            node,
          );
        }
        return BOOL;
      }
      case '==':
      case '!=':
        if (!isComparable(left, right)) {
          this.error(`cannot compare ${typeToString(left)} and ${typeToString(right)}`, node);
        }
        return BOOL;
      case 'instanceof':
        if (!instanceTypeOf(right) && !isUntyped(right)) {
          this.error(
            `the right side of instanceof must be a class, not ${typeToString(right)}`,
            node,
          );
        }
        return BOOL;
      case '&&':
      case '||':
        this.expectBool(left, node, `"${operator}"`);
        return BOOL;
      case '??': {
        if (isUntyped(left)) return left;
        const base = nonNull(left);
        if (isAssignable(right, base)) return isNullable(right) ? nullable(base) : base;
        return commonType(base, right);
      }
    }
  }

  protected override checkConditional(
    node: ast.ConditionalExpression,
    expected: Type | null,
  ): Type {
    this.checkCondition(node.test);
    const before = this.flow;
    const whenTrue = this.narrow(node.test, true);
    const whenFalse = this.narrow(node.test, false);
    this.flow = withNarrowing(before, whenTrue);
    const consequent = this.checkValue(node.consequent, expected);
    this.flow = withNarrowing(before, whenFalse);
    const alternate = this.checkValue(node.alternate, expected);
    this.flow = before;
    return commonType(consequent, alternate);
  }
}
