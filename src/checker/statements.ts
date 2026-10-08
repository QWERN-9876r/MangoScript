import type * as ast from '../ast.ts';
import { isUntyped, isNumeric, countValues, callName } from './helpers.ts';
import { TypeResolver } from './resolution.ts';
import {
  ANY,
  func,
  hasZeroValue,
  isAssignable,
  isNullable,
  nonNull,
  nullable,
  typeToString,
  UNKNOWN,
  type Type,
} from './types.ts';

// Statements: declarations of variables, assignments, `return`, `mount()`.

export abstract class StatementChecker extends TypeResolver {
  protected override checkStatement(node: ast.Statement): void {
    switch (node.kind) {
      case 'VariableDeclaration':
        this.checkVariableDeclaration(node);
        break;
      case 'BlockStatement':
        this.checkBlock(node.body);
        break;
      case 'ExpressionStatement':
        this.checkExpression(node.expression, null);
        break;
      case 'JsxElementStatement':
        this.checkExpression(node.element, null);
        break;
      case 'AssignmentStatement':
        this.checkAssignment(node);
        break;
      case 'IncDecStatement': {
        const type = this.checkTarget(node.target);
        if (!isNumeric(type)) {
          this.error(`"${node.operator}" needs a number, not ${typeToString(type)}`, node.target);
        }
        this.forget(node.target);
        break;
      }
      case 'ReturnStatement':
        this.checkReturn(node);
        break;
      case 'IfStatement':
        this.checkIf(node);
        break;
      case 'ForStatement':
        this.checkFor(node);
        break;
      case 'ForInStatement':
        this.checkForIn(node);
        break;
      case 'SwitchStatement':
        this.checkSwitch(node);
        break;
      case 'ThrowStatement':
        this.checkValue(node.argument);
        break;
      case 'TryStatement':
        this.checkTry(node);
        break;
      case 'DeferStatement':
        if (node.body.kind === 'BlockStatement') this.checkBlock(node.body.body);
        else this.checkExpression(node.body, null);
        break;
      case 'MountStatement':
        this.checkMount(node);
        break;
      case 'ImportDeclaration':
      case 'FuncDeclaration':
      case 'ComponentDeclaration':
      case 'ClassDeclaration':
      case 'InterfaceDeclaration':
      case 'TypeAliasDeclaration':
      case 'BreakStatement':
      case 'ContinueStatement':
        // Declarations are handled by declareStatements(); jumps were checked by the parser.
        break;
    }
  }

  /**
   * `mount() { ... }`: a function that runs once the markup is in the document, like a handler.
   * It may return the function that cleans up, or nothing.
   */
  protected checkMount(node: ast.MountStatement): void {
    const results = this.checkFunction([], func([], []), null, node.body, { closure: true });
    if (results.length === 0) return;
    const result = results.length === 1 ? nonNull(results[0]!) : null;
    const cleans =
      result !== null &&
      (isUntyped(result) ||
        result.kind === 'never' ||
        (result.kind === 'function' && result.required === 0));
    if (!cleans) {
      const returned =
        results.length === 1 ? typeToString(results[0]!) : `${results.length} values`;
      this.error(
        `mount() returns the function that cleans up, e.g. return () => clearInterval(timer), not ${returned}`,
        { start: node.start, end: node.start + 'mount'.length },
      );
    }
  }

  protected checkBlock(statements: readonly ast.Statement[]): void {
    this.withScope(() => this.checkStatementList(statements, false));
  }

  protected checkVariableDeclaration(node: ast.VariableDeclaration): void {
    const declared = node.type ? this.resolveType(node.type) : null;
    const { names, values } = node;
    let types: Type[];

    if (values.length === 0) {
      if (declared && !hasZeroValue(declared) && declared.kind !== 'unknown') {
        const type = typeToString(declared);
        this.error(
          `${type} has no zero value: give "${names[0]!.name}" a value or make it nullable with ${typeToString(nullable(declared))}`,
          node.type ?? node,
        );
      }
      types = names.map(() => declared ?? UNKNOWN);
    } else if (values.length === names.length) {
      types = values.map((value) => {
        const type = this.checkValue(value, declared);
        if (!declared) return this.inferredType(type, value);
        this.expectAssignable(type, declared, value);
        return declared;
      });
    } else {
      types = this.unpack(values[0]!, names.length, declared);
    }

    names.forEach((name, i) => {
      if (name.name === '_') return;
      const type = types[i] ?? UNKNOWN;
      // Top-level variables were declared in advance by declareStatements().
      const existing = this.scope.values.get(name.name);
      const binding =
        existing && existing.type === null && existing.kind === node.keyword
          ? existing
          : this.declareValue(name, node.keyword, null);
      binding.type = type;
      const value = values.length === names.length ? values[i] : undefined;
      if (value && isNullable(type) && !isNullable(this.typeOfChecked(value))) {
        this.flow.set(binding, nonNull(type));
      }
    });
  }

  /**
   * `a, b = f()` or `return f()`: the call must return exactly `count` values. Returns their
   * types.
   */
  protected unpack(
    value: ast.Expression,
    count: number,
    declared: Type | null,
    context: 'assignment' | 'return' = 'assignment',
  ): Type[] {
    const type = this.checkExpression(value, null);
    if (type.kind === 'unknown') return Array<Type>(count).fill(UNKNOWN);
    const returned = type.kind === 'tuple' ? type.types.length : type.kind === 'void' ? 0 : 1;
    if (type.kind !== 'tuple' || returned !== count) {
      const prefix =
        context === 'return'
          ? `wrong number of return values: expected ${count}, but`
          : `assignment mismatch: ${count} variables but`;
      this.error(`${prefix} ${callName(value)} returns ${countValues(returned)}`, value);
      return Array<Type>(count).fill(UNKNOWN);
    }
    if (declared) {
      for (const element of type.types) this.expectAssignable(element, declared, value);
      return type.types.map(() => declared);
    }
    return type.types;
  }

  protected checkAssignment(node: ast.AssignmentStatement): void {
    const { targets, values, operator } = node;
    if (operator !== '=') {
      const target = targets[0]!;
      const targetType = this.checkTarget(target);
      const valueType = this.checkValue(values[0]!, targetType);
      const result = this.binaryResult(
        operator.slice(0, -1) as ast.BinaryOperator,
        targetType,
        valueType,
        node,
      );
      this.expectAssignable(result, targetType, values[0]!);
      this.forget(target);
      return;
    }

    const targetTypes = targets.map((target) => this.checkTarget(target));
    let valueTypes: Type[];
    if (values.length === targets.length) {
      valueTypes = values.map((value, i) => {
        const type = this.checkValue(value, targetTypes[i] ?? null);
        this.expectAssignable(type, targetTypes[i]!, value);
        return type;
      });
    } else {
      valueTypes = this.unpack(values[0]!, targets.length, null);
      valueTypes.forEach((type, i) => this.expectAssignable(type, targetTypes[i]!, values[0]!));
    }

    targets.forEach((target, i) => {
      this.forget(target);
      const binding = this.narrowableBinding(target);
      const declared = binding?.type;
      if (binding && declared && isNullable(declared) && !isNullable(valueTypes[i] ?? UNKNOWN)) {
        this.flow.set(binding, nonNull(declared));
      }
    });
  }

  /** The type a value assigned to `target` must have. */
  protected checkTarget(target: ast.Expression): Type {
    switch (target.kind) {
      case 'Identifier': {
        if (target.name === '_') return ANY;
        const binding = this.lookupValue(target.name);
        if (!binding) {
          this.error(`"${target.name}" is not defined`, target);
          return UNKNOWN;
        }
        if (binding.kind === 'const') {
          this.error(`cannot assign to "${target.name}": it is a constant`, target);
        } else if (binding.kind === 'loop') {
          this.error(`cannot assign to loop variable "${target.name}"`, target);
        } else if (binding.kind === 'prop') {
          this.error(
            `cannot assign to "${target.name}": component properties are read-only; to change the parent's state, pass a function`,
            target,
          );
        } else if (
          binding.kind !== 'let' &&
          binding.kind !== 'state' &&
          binding.kind !== 'param' &&
          binding.kind !== 'catch'
        ) {
          this.error(`cannot assign to "${target.name}"`, target);
        }
        return binding.type ?? UNKNOWN;
      }
      case 'MemberExpression': {
        const object = this.nonNullValue(target.object);
        const member = this.findMember(object, target.property.name, target.property);
        if (member === 'any') return ANY;
        if (!member) return UNKNOWN;
        if (member.method) {
          this.error(`cannot assign to method "${target.property.name}"`, target);
          return UNKNOWN;
        }
        return member.type;
      }
      case 'IndexExpression': {
        const object = this.nonNullValue(target.object);
        const keyed = this.keyedIndex(object, target.index);
        if (keyed) return keyed;
        this.expectIndex(target.index);
        if (object.kind === 'array') return object.element;
        this.error(
          object.kind === 'string'
            ? 'cannot assign to a character: strings cannot be changed'
            : `cannot index ${typeToString(object)}`,
          target,
        );
        return UNKNOWN;
      }
      default:
        this.checkValue(target);
        return UNKNOWN;
    }
  }

  protected checkReturn(node: ast.ReturnStatement): void {
    const fn = this.fn;
    if (!fn) return;
    const { values } = node;

    if (fn.isComponent) {
      // A component may return early; whatever it returns is its markup.
      const [value] = values;
      if (value === undefined || values.length > 1) {
        this.error('a component returns its markup: "return <markup>"', node);
        return;
      }
      const type = this.checkValue(value);
      if (!isUntyped(type) && !isAssignable(type, this.dom.node)) {
        this.error(`a component returns markup, not ${typeToString(type)}`, value);
      }
      return;
    }

    if (fn.results === null) {
      // Results are inferred: just record what is returned.
      if (values.length === 1) {
        const type = this.checkExpression(values[0]!, null);
        fn.returns.push(type.kind === 'tuple' ? type.types : type.kind === 'void' ? [] : [type]);
      } else {
        fn.returns.push(values.map((value) => this.checkValue(value)));
      }
      return;
    }

    const expected = fn.results;
    if (values.length === 0) {
      if (expected.length > 0) {
        this.error(`missing return values: expected ${countValues(expected.length)}`, node);
      }
      return;
    }
    if (expected.length === 0) {
      this.error('too many return values: this function returns nothing', values[0]!);
      for (const value of values) this.checkExpression(value, null);
      return;
    }
    if (values.length === 1 && expected.length > 1 && values[0]!.kind === 'CallExpression') {
      const types = this.unpack(values[0], expected.length, null, 'return');
      types.forEach((type, i) =>
        this.expectAssignable(type, expected[i]!, values[0]!, ' in return'),
      );
      return;
    }
    if (values.length !== expected.length) {
      this.error(
        `wrong number of return values: expected ${expected.length}, got ${values.length}`,
        node,
      );
    }
    values.forEach((value, i) => {
      const target = expected[i];
      const type = this.checkValue(value, target ?? null);
      if (target) this.expectAssignable(type, target, value, ' in return');
    });
  }
}
