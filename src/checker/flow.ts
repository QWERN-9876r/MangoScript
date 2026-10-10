import type * as ast from '../ast.ts';
import { containsBreak } from '../walk.ts';
import type { Flow, Narrowing } from './context.ts';
import {
  BOOL,
  isNullable,
  nonNull,
  NULL,
  NUMBER,
  STRING,
  typesEqual,
  union,
  unionMembers,
  type Type,
} from './types.ts';

// Control flow for the checker: how conditions narrow the types of variables, and which statements
// execution never continues after.

/** What `typeof` gives for every value of a type, or `null` when it may give several things. */
export function typeofTag(type: Type): string | null {
  switch (type.kind) {
    case 'string':
    case 'number':
      return type.kind;

    case 'bool':
      return 'boolean';

    case 'literal':
      return typeof type.value;

    case 'function':
    case 'classValue':
      return 'function';

    case 'object':
      return type.call ? 'function' : 'object';

    case 'class':
    case 'array':
    case 'tuple':
    case 'null':
      return 'object';

    default:
      return null;
  }
}

/** The type after `typeof x == tag` is found true (`matches`) or false. */
export function narrowByTypeof(type: Type, tag: string, matches: boolean): Type | null {
  const base = nonNull(type);

  if (base.kind === 'any' || base.kind === 'unknown') {
    if (!matches) return null;

    return tag === 'string' ? STRING : tag === 'number' ? NUMBER : tag === 'boolean' ? BOOL : null;
  }

  const kept = unionMembers(base).filter((member) => {
    const memberTag = typeofTag(member);

    return memberTag === null || (memberTag === tag) === matches;
  });
  // typeof null is "object".
  const keepsNull = isNullable(type) && (tag === 'object') === matches;

  return union(keepsNull ? [...kept, NULL] : kept);
}

/** `"all"`, `42` or `true` written in the code: its value, or `undefined` for other expressions. */
export function literalValue(node: ast.Expression): string | number | boolean | undefined {
  switch (node.kind) {
    case 'StringLiteral':
    case 'NumberLiteral':
    case 'BooleanLiteral':
      return node.value;

    default:
      return undefined;
  }
}

/** A type without one literal value: what is left after `x != "all"`. */
export function withoutLiteral(type: Type, value: string | number | boolean): Type {
  const kept = unionMembers(nonNull(type)).filter(
    (member) => !(member.kind === 'literal' && member.value === value),
  );

  return union(isNullable(type) ? [...kept, NULL] : kept);
}

export function withNarrowing(flow: Flow, narrowing: Narrowing): Flow {
  const result = new Map(flow);

  for (const [binding, type] of narrowing) result.set(binding, type);

  return result;
}

/** Narrowing that holds after both branches: the variables narrowed the same way in both. */
export function mergeFlows(a: Flow, b: Flow): Flow {
  const result: Flow = new Map();

  for (const [binding, type] of a) {
    const other = b.get(binding);

    if (other && typesEqual(type, other)) result.set(binding, type);
  }

  return result;
}

/** Go's terminating statements: execution never continues after them. */
export function isTerminating(node: ast.Statement): boolean {
  switch (node.kind) {
    case 'ReturnStatement':
    case 'ThrowStatement':
      return true;

    case 'BlockStatement': {
      const last = node.body.at(-1);

      return last !== undefined && isTerminating(last);
    }

    case 'IfStatement':
      return (
        node.alternate !== null && isTerminating(node.consequent) && isTerminating(node.alternate)
      );

    case 'ForStatement':
      return node.condition === null && !containsBreak(node.body.body);

    case 'SwitchStatement':
      return (
        node.cases.some((switchCase) => switchCase.tests.length === 0) &&
        node.cases.every((switchCase) => {
          const last = switchCase.body.at(-1);

          return last !== undefined && isTerminating(last) && !containsBreak(switchCase.body);
        })
      );

    case 'TryStatement':
      return (
        (isTerminating(node.block) && (!node.handler || isTerminating(node.handler.body))) ||
        (node.finalizer !== null && isTerminating(node.finalizer))
      );

    default:
      return false;
  }
}

/** Whether execution never continues after the statement, counting `break` and `continue`. */
export function leaves(node: ast.Statement): boolean {
  switch (node.kind) {
    case 'BreakStatement':
    case 'ContinueStatement':
      return true;

    case 'BlockStatement': {
      const last = node.body.at(-1);

      return last !== undefined && leaves(last);
    }

    case 'IfStatement':
      return node.alternate !== null && leaves(node.consequent) && leaves(node.alternate);

    default:
      return isTerminating(node);
  }
}
