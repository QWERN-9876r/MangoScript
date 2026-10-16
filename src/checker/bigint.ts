import type * as ast from '../ast.ts';
import { isUntyped } from './helpers.ts';
import {
  ANY,
  BIGINT,
  BOOL,
  func,
  method,
  NUMBER,
  STRING,
  typeToString,
  union,
  UNKNOWN,
  widenLiterals,
  type Member,
  type ObjectType,
  type Type,
} from './types.ts';

// Operators on bigints, as JS has them: a bigint and a number do not mix in arithmetic (JS throws
// a TypeError), they compare with `<` and the like, and `==`, which is `===`, would always be false
// between them. The operator checker asks here first when one side is a bigint.

/** What an operator gives for a bigint, and the error to report if it cannot take one. */
export interface BigintResult {
  type: Type;
  error?: string;
}

const MIX_HINT = 'convert one of them, e.g. BigInt(n) or Number(b)';

const isBigint = (type: Type) => widenLiterals(type).kind === 'bigint';
const isNumber = (type: Type) => widenLiterals(type).kind === 'number';

/** `left <operator> right` when either side is a bigint, or `null` to check it as usual. */
export function bigintBinary(
  operator: ast.BinaryOperator,
  left: Type,
  right: Type,
): BigintResult | null {
  if (!isBigint(left) && !isBigint(right)) return null;

  const mixed = (isBigint(left) && isNumber(right)) || (isNumber(left) && isBigint(right));
  const untyped = isUntyped(left) || isUntyped(right);
  const both = isBigint(left) && isBigint(right);

  switch (operator) {
    case '>>>':
      return { type: UNKNOWN, error: '">>>" does not work with bigint: use ">>"' };

    case '+':
    case '-':
    case '*':
    case '/':
    case '%':
    case '**':
    case '<<':
    case '>>':
    case '&':
    case '|':
    case '^':
      if (both) return { type: BIGINT };
      if (untyped) return { type: operator === '+' ? ANY : BIGINT };
      if (mixed) {
        return {
          type: UNKNOWN,
          error: `cannot mix bigint and number in "${operator}": ${MIX_HINT}`,
        };
      }

      return null;

    case '<':
    case '>':
    case '<=':
    case '>=':
      return both || mixed || untyped ? { type: BOOL } : null;

    case '==':
    case '!=':
      return mixed
        ? {
            type: BOOL,
            error: `cannot compare ${typeToString(left)} and ${typeToString(right)} with "${operator}", it is always ${operator === '!='}: ${MIX_HINT}`,
          }
        : null;

    default:
      return null;
  }
}

/** `-b`, `~b` and `+b` of a bigint, or `null` when the value is not one. */
export function bigintUnary(operator: '-' | '+' | '~', type: Type): BigintResult | null {
  if (!isBigint(type)) return null;

  return operator === '+'
    ? { type: UNKNOWN, error: '"+" does not work with bigint: use Number(b)' }
    : { type: BIGINT };
}

/** The members of a bigint that the built-in types list; the lib files add the rest. */
export function bigintMember(name: string): Member | undefined {
  switch (name) {
    case 'toString':
      return method(func([NUMBER], [STRING], { required: 0 }));

    case 'toLocaleString':
      return method(func([ANY, ANY], [STRING], { required: 0 }));

    case 'valueOf':
      return method(func([], [BIGINT]));

    default:
      return undefined;
  }
}

/** `BigInt(x)` makes a bigint of a number, a string or a bool; `BigInt.asIntN(64, b)` wraps one. */
export const BIGINT_OBJECT: ObjectType = {
  kind: 'object',
  name: 'BigInt',
  members: new Map([
    ['asIntN', method(func([NUMBER, BIGINT], [BIGINT]))],
    ['asUintN', method(func([NUMBER, BIGINT], [BIGINT]))],
  ]),
  call: func([union([NUMBER, STRING, BOOL, BIGINT])], [BIGINT]),
};
