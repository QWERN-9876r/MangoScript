import type * as ast from '../ast.ts';
import { FunctionChecker } from './functions.ts';
import { expectsLiteral, callName } from './helpers.ts';
import {
  ANY,
  arrayOf,
  BOOL,
  commonType,
  hasUntypedBase,
  instanceMembers,
  literal,
  NEVER,
  nonNull,
  NULL,
  nullable,
  NUMBER,
  STRING,
  typeToString,
  UNKNOWN,
  type Member,
  type Type,
} from './types.ts';

// Expressions: names, `this`, literals of arrays and objects; the operators are in operators.ts.

export abstract class ExpressionChecker extends FunctionChecker {
  /** The type of an expression that must be a single value (not `void` or several results). */
  protected override checkValue(node: ast.Expression, expected: Type | null = null): Type {
    return this.single(this.checkExpression(node, expected), node);
  }

  protected single(type: Type, node: ast.Expression): Type {
    if (type.kind === 'tuple') {
      this.error(
        `${callName(node)} returns ${type.types.length} values: unpack them, e.g. "const a, b = ..."`,
        node,
      );
      return UNKNOWN;
    }
    if (type.kind === 'void') {
      this.error(`${callName(node)} does not return a value`, node);
      return UNKNOWN;
    }
    return type;
  }

  /** `expected` is the type the context wants, used to type literals and arrow functions. */
  protected override checkExpression(node: ast.Expression, expected: Type | null): Type {
    const type = this.computeType(node, expected);
    this.checkedTypes.set(node, type);
    return type;
  }

  protected computeType(node: ast.Expression, expected: Type | null): Type {
    switch (node.kind) {
      case 'Identifier':
        return this.checkIdentifier(node);
      // A literal has a literal type only where one is expected: `filter = "all"`.
      case 'NumberLiteral':
        return expectsLiteral(expected) ? literal(node.value) : NUMBER;
      case 'StringLiteral':
        return expectsLiteral(expected) ? literal(node.value) : STRING;
      case 'TemplateLiteral':
        for (const expression of node.expressions) this.checkValue(expression);
        return STRING;
      case 'BooleanLiteral':
        return expectsLiteral(expected) ? literal(node.value) : BOOL;
      case 'NullLiteral':
        return NULL;
      case 'ThisExpression':
        return this.thisType(node);
      case 'SuperExpression':
        return this.superType(node);
      case 'ArrayLiteral':
        return this.checkArrayLiteral(node, expected);
      case 'ObjectLiteral':
        return this.checkObjectLiteral(node, expected);
      case 'FuncExpression':
        return this.checkFuncExpression(node);
      case 'ArrowFunction':
        return this.checkArrowFunction(node, expected);
      case 'UnaryExpression':
        return this.checkUnary(node);
      case 'BinaryExpression':
        return this.checkBinary(node, expected);
      case 'ConditionalExpression':
        return this.checkConditional(node, expected);
      case 'NewExpression':
        return this.checkNew(node, expected);
      case 'ElementExpression':
        return this.checkElement(node);
      case 'MemberExpression':
      case 'IndexExpression':
      case 'CallExpression': {
        const [type, shortCircuits] = this.checkChain(node, expected);
        return shortCircuits && type.kind !== 'tuple' && type.kind !== 'void'
          ? nullable(type)
          : type;
      }
    }
  }

  protected checkIdentifier(node: ast.Identifier): Type {
    if (node.name === '_') {
      this.error('"_" cannot be used as a value', node);
      return UNKNOWN;
    }
    const binding = this.lookupValue(node.name);
    if (!binding) {
      this.error(
        this.lookupType(node.name)
          ? `"${node.name}" is a type, not a value`
          : `"${node.name}" is not defined`,
        node,
      );
      return UNKNOWN;
    }
    if (binding.kind === 'component') {
      this.error(`components are used as tags: <${node.name} />`, node);
      return UNKNOWN;
    }
    if (binding.type === null) {
      this.error(`"${node.name}" is used before its declaration`, node);
      return UNKNOWN;
    }
    return this.flow.get(binding) ?? binding.type;
  }

  protected thisType(node: ast.NodeBase): Type {
    if (!this.cls) {
      this.error('"this" can only be used inside a class', node);
      return UNKNOWN;
    }
    return this.cls.isStatic ? this.cls.info.value : this.cls.info.instance;
  }

  /** `super.method()`: the members of the base class. */
  protected superType(node: ast.NodeBase): Type {
    const info = this.cls?.info;
    if (!info) {
      this.error('"super" can only be used inside a class', node);
      return UNKNOWN;
    }
    if (info.superClass)
      return this.cls?.isStatic ? info.superClass.value : info.superClass.instance;
    if (hasUntypedBase(info)) return ANY;
    this.error(`class "${info.name}" has no base class`, node);
    return UNKNOWN;
  }

  protected checkArrayLiteral(node: ast.ArrayLiteral, expected: Type | null): Type {
    const context = expected ? nonNull(expected) : null;
    const expectedElement =
      context?.kind === 'array' ? context.element : context?.kind === 'any' ? ANY : null;
    let element: Type = expectedElement ?? NEVER;

    for (const item of node.elements) {
      let type: Type;
      if (item.kind === 'SpreadElement') {
        const spread = this.checkValue(item.argument, expectedElement && arrayOf(expectedElement));
        if (spread.kind === 'array') type = spread.element;
        else if (spread.kind === 'any' || spread.kind === 'unknown') type = spread;
        else {
          this.error(`cannot spread ${typeToString(spread)}: it is not an array`, item.argument);
          type = UNKNOWN;
        }
      } else {
        type = this.checkValue(item, expectedElement);
      }

      if (expectedElement) {
        this.expectAssignable(
          type,
          expectedElement,
          item.kind === 'SpreadElement' ? item.argument : item,
        );
      } else {
        element = commonType(element, type);
      }
    }
    return arrayOf(element);
  }

  protected checkObjectLiteral(node: ast.ObjectLiteral, expected: Type | null): Type {
    let target = expected ? nonNull(expected) : null;
    // `?(ScrollIntoViewOptions | bool)`: an object literal can only be the object type in it.
    if (target?.kind === 'union') {
      const objects = target.types.filter(
        (type) => type.kind === 'object' || type.kind === 'class',
      );
      target = objects.length === 1 ? objects[0]! : null;
    }
    const index = target?.kind === 'object' ? target.index : undefined;
    const targetMembers =
      target?.kind === 'object'
        ? target.members
        : target?.kind === 'class'
          ? instanceMembers(target.info)
          : null;
    const members = new Map<string, Member>();
    const written = new Set<string>();
    let untyped = false;

    for (const property of node.properties) {
      if (property.kind === 'SpreadElement') {
        const spread = this.checkValue(property.argument);
        if (spread.kind === 'object') {
          for (const [name, member] of spread.members) members.set(name, member);
        } else if (spread.kind === 'class') {
          for (const [name, member] of instanceMembers(spread.info)) {
            if (member.visibility === 'public' && !member.method) members.set(name, member);
          }
        } else if (spread.kind === 'any' || spread.kind === 'unknown') {
          untyped = true;
        } else {
          this.error(`cannot spread ${typeToString(spread)} into an object`, property.argument);
        }
        continue;
      }

      const name = property.key.kind === 'Identifier' ? property.key.name : property.key.value;
      // Fields may override those of a spread object, but not each other.
      if (written.has(name)) this.error(`duplicate field "${name}"`, property.key);
      written.add(name);
      const expectedMember =
        targetMembers?.get(name) ??
        (index && { type: index, method: false, visibility: 'public', owner: null });
      // A field that the expected type does not have is most likely a typo.
      if (targetMembers && !expectedMember && target) {
        this.error(`${typeToString(target)} has no field "${name}"`, property.key);
      }
      let type = this.checkValue(property.value, expectedMember?.type ?? null);
      if (expectedMember) {
        // Reported at the field; the literal then counts as having the expected field type.
        this.expectAssignable(type, expectedMember.type, property.value, ` for field "${name}"`);
        type = expectedMember.type;
      }
      members.set(name, { type, method: false, visibility: 'public', owner: null });
    }
    return untyped ? ANY : { kind: 'object', name: null, members, call: null };
  }
}
