import type * as ast from '../ast.ts';
import { containsBreak, forEachChild } from '../walk.ts';
import { CONTENT } from './dom.ts';
import {
  BOOL,
  isAssignable,
  isNullable,
  nonNull,
  NULL,
  NUMBER,
  STRING,
  typesEqual,
  union,
  unionMembers,
  type FunctionType,
  type Type,
} from './types.ts';
import type { Scope } from './context.ts';
import { type Binding, type Flow, type Narrowing } from './context.ts';

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

/** Names a component uses as values but does not declare: those come from the module. */
export function freeNames(component: ast.ComponentDeclaration): Set<string> {
  const used = new Set<string>();
  const declared = new Set<string>(component.params.map((param) => param.name.name));
  const visit = (node: ast.Node | null): void => {
    if (node === null) return;
    switch (node.kind) {
      case 'Identifier':
        used.add(node.name);
        return;
      case 'MemberExpression':
        visit(node.object);
        return;
      case 'Property':
        visit(node.value);
        return;
      case 'ElementExpression':
        // Tags are not values: components are found by the generator itself.
        node.attributes.forEach(visit);
        node.children.forEach(visit);
        return;
      case 'JsxAttribute':
        visit(node.value);
        return;
      case 'EventHandler':
        declared.add('event');
        node.body.forEach(visit);
        return;
      case 'VariableDeclaration':
        for (const name of node.names) declared.add(name.name);
        node.values.forEach(visit);
        return;
      case 'FuncDeclaration':
      case 'ClassDeclaration':
        declared.add(node.name.name);
        forEachChild(node, visit);
        return;
      case 'Parameter':
        declared.add(node.name.name);
        visit(node.defaultValue);
        return;
      case 'ForInStatement':
        declared.add(node.value.name);
        if (node.key) declared.add(node.key.name);
        visit(node.iterable);
        visit(node.body);
        return;
      case 'CatchClause':
        if (node.param) declared.add(node.param.name);
        visit(node.body);
        return;
      case 'TypeReference':
      case 'ArrayType':
      case 'NullableType':
      case 'FuncType':
      case 'ObjectType':
      case 'UnionType':
      case 'LiteralType':
      case 'TypeParameter':
        return;
      default:
        forEachChild(node, visit);
    }
  };
  component.params.forEach(visit);
  visit(component.body);
  return new Set([...used].filter((name) => !declared.has(name)));
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
