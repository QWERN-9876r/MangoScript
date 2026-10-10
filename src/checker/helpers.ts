import type * as ast from '../ast.ts';
import { forEachChild } from '../walk.ts';
import { CONTENT } from './dom.ts';
import { isAssignable, nonNull, unionMembers, type FunctionType, type Type } from './types.ts';
import type { Scope } from './context.ts';
import { type Binding } from './context.ts';

// Functions that the layers of the checker use and that need no state of their own.

// ─── Helpers ─────────────────────────────────────────────────────────────────────────────────────

/** A binding as seen from a scope and its parents. */
export function lookupIn(scope: Scope, name: string): Binding | undefined {
  for (let current: Scope | null = scope; current; current = current.parent) {
    const binding = current.values.get(name);

    if (binding) return binding;
  }

  return undefined;
}

/** Return and defer statements of a body, not counting those of nested functions. */
export function ownStatements(body: ast.BlockStatement): ast.Statement[] {
  const found: ast.Statement[] = [];
  const visit = (node: ast.Node): void => {
    if (node.kind === 'ReturnStatement' || node.kind === 'DeferStatement') found.push(node);
    if (
      node.kind === 'FuncDeclaration' ||
      node.kind === 'FuncExpression' ||
      node.kind === 'ArrowFunction' ||
      node.kind === 'ClassDeclaration' ||
      node.kind === 'MountStatement'
    )
      return;
    forEachChild(node, visit);
  };

  forEachChild(body, visit);

  return found;
}

/** Values that can be element children: text, numbers, nodes, lists of them, or null. */
/** Text, numbers, nodes (`node` is the type of a DOM node), lists of them, or null. */
export function isContent(type: Type, node: Type): boolean {
  if (type === CONTENT) return true;
  switch (type.kind) {
    case 'string':
    case 'number':
    case 'any':
    case 'unknown':
    case 'never':
    case 'null':
      return true;

    case 'nullable':
      return isContent(type.type, node);

    case 'array':
      return isContent(type.element, node);

    case 'object':
    case 'class':
      return isAssignable(type, node);

    default:
      return false;
  }
}

/** Values that setAttribute accepts: text, numbers, bools, or null to leave it out. */
export function isAttributeValue(type: Type): boolean {
  const value = nonNull(type);

  return (
    isUntyped(value) ||
    value.kind === 'string' ||
    value.kind === 'number' ||
    value.kind === 'bool' ||
    value.kind === 'null' ||
    value.kind === 'never'
  );
}

export function isUntyped(type: Type): boolean {
  return type.kind === 'any' || type.kind === 'unknown';
}

export function isNumeric(type: Type): boolean {
  return type.kind === 'number' || isUntyped(type);
}

/**
 * What `x instanceof C` makes `x`: an instance of a class, or of a constructor from a `.d.ts`,
 * like `HTMLInputElement` (`declare var HTMLInputElement: { prototype: ...; new(): ... }`).
 */
export function instanceTypeOf(type: Type): Type | null {
  if (type.kind === 'classValue') return type.info.instance;
  if (type.kind !== 'object') return null;

  const prototype = type.members.get('prototype');

  if (prototype && !isUntyped(prototype.type)) return prototype.type;

  return type.construct?.results[0] ?? null;
}

/** A function and its overloads, in the order they are declared. */
export function signaturesOf(signature: FunctionType): FunctionType[] {
  return [signature, ...(signature.overloads ?? [])];
}

export function callSignature(type: Type): FunctionType | null {
  if (type.kind === 'function') return type;
  if (type.kind === 'object') return type.call;
  if (type.kind === 'union') {
    // A union of functions can be called when they all accept and give the same: `x.toString()`.
    const signatures = type.types.map(callSignature);
    const [first] = signatures;
    const same = signatures.every(
      (each) =>
        each !== null &&
        first !== null &&
        first !== undefined &&
        isAssignable(each, first) &&
        isAssignable(first, each),
    );

    return same ? (first ?? null) : null;
  }

  return null;
}

/** Whether the expected type has literal members: then a literal gets a literal type. */
export function expectsLiteral(expected: Type | null): boolean {
  return (
    expected !== null && unionMembers(nonNull(expected)).some((type) => type.kind === 'literal')
  );
}

export function countValues(count: number): string {
  if (count === 0) return 'no values';

  return count === 1 ? '1 value' : `${count} values`;
}

/** How to name an expression in messages: `divide()`, `stats.minMax()`, or `this expression`. */
export function callName(node: ast.Expression): string {
  if (node.kind !== 'CallExpression') return 'this expression';

  const { callee } = node;

  if (callee.kind === 'Identifier') return `${callee.name}()`;
  if (callee.kind === 'MemberExpression') {
    const object = callee.object.kind === 'Identifier' ? `${callee.object.name}.` : '';

    return `${object}${callee.property.name}()`;
  }

  return 'this call';
}

export function isSuperCall(statement: ast.Statement): boolean {
  return (
    statement.kind === 'ExpressionStatement' &&
    statement.expression.kind === 'CallExpression' &&
    statement.expression.callee.kind === 'SuperExpression'
  );
}

/** `this.name = ...` at the top level of a constructor. */
export function assignsField(body: ast.BlockStatement, name: string): boolean {
  return body.body.some(
    (statement) =>
      statement.kind === 'AssignmentStatement' &&
      statement.targets.some(
        (target) =>
          target.kind === 'MemberExpression' &&
          target.object.kind === 'ThisExpression' &&
          target.property.name === name,
      ),
  );
}
