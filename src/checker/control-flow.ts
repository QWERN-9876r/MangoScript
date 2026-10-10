import type * as ast from '../ast.ts';
import { assignedNames } from '../names.ts';
import { type Binding, type Flow, type Narrowing, NARROWABLE } from './context.ts';
import {
  narrowByTypeof,
  literalValue,
  withoutLiteral,
  withNarrowing,
  mergeFlows,
  leaves,
} from './flow.ts';
import { instanceTypeOf } from './helpers.ts';
import { StatementChecker } from './statements.ts';
import {
  ANY,
  BOOL,
  isAssignable,
  isComparable,
  isNullable,
  isSubclass,
  literal,
  nonNull,
  NULL,
  NUMBER,
  STRING,
  typeToString,
  union,
  unionMembers,
  UNKNOWN,
  widenLiterals,
  type Type,
} from './types.ts';

// if, for, switch and try, and how conditions narrow the types of variables in the branches.

export abstract class ControlFlowChecker extends StatementChecker {
  protected override checkIf(node: ast.IfStatement): void {
    this.checkCondition(node.condition);

    const before = this.flow;
    // Both are found from the flow before the `if`, not from the end of a branch.
    const whenTrue = this.narrow(node.condition, true);
    const whenFalse = this.narrow(node.condition, false);

    this.flow = withNarrowing(before, whenTrue);
    this.checkBlock(node.consequent.body);

    const afterThen = this.flow;

    this.flow = withNarrowing(before, whenFalse);

    const { alternate } = node;

    if (alternate?.kind === 'IfStatement') this.checkIf(alternate);
    else if (alternate) this.checkBlock(alternate.body);

    const afterElse = this.flow;

    // A branch that always leaves (return, throw, break, continue) does not reach the code after
    // the `if`, so `if x == null { return }` narrows `x` for the rest of the block.
    const thenLeaves = leaves(node.consequent);
    const elseLeaves = alternate !== null && leaves(alternate);

    if (thenLeaves && !elseLeaves) this.flow = afterElse;
    else if (elseLeaves && !thenLeaves) this.flow = afterThen;
    else this.flow = mergeFlows(afterThen, afterElse);
  }

  protected override checkFor(node: ast.ForStatement): void {
    this.withScope(() => {
      if (node.init) this.checkSimpleStatement(node.init);
      // Variables assigned in the loop may change between iterations.
      this.dropNarrowing(assignedNames(node));

      const entry = this.flow;

      if (node.condition) this.checkCondition(node.condition);
      this.flow = withNarrowing(entry, node.condition ? this.narrow(node.condition, true) : []);
      this.checkBlock(node.body.body);
      if (node.update) this.checkSimpleStatement(node.update);
      this.flow = entry;
    });
  }

  protected checkSimpleStatement(node: ast.SimpleStatement): void {
    this.checkStatement(node);
  }

  protected override checkForIn(node: ast.ForInStatement): void {
    const iterable = this.checkValue(node.iterable);
    let value: Type = UNKNOWN;
    let key: Type = NUMBER;

    if (isNullable(iterable)) {
      this.nullError(node.iterable);
    } else if (iterable.kind === 'array') {
      value = iterable.element;
    } else if (iterable.kind === 'string') {
      value = STRING;
    } else if (iterable.kind === 'any') {
      value = ANY;
      key = ANY;
    } else if (iterable.kind !== 'unknown') {
      this.error(`cannot iterate over ${typeToString(iterable)}`, node.iterable);
    }

    this.withScope(() => {
      if (node.key) this.declareValue(node.key, 'loop', key);
      this.declareValue(node.value, 'loop', value);
      this.dropNarrowing(assignedNames(node.body));

      const entry = this.flow;

      this.flow = new Map(entry);
      this.checkBlock(node.body.body);
      this.flow = entry;
    });
  }

  protected override checkSwitch(node: ast.SwitchStatement): void {
    const discriminant = node.discriminant ? this.checkValue(node.discriminant) : null;

    this.dropNarrowing(assignedNames(node));

    const entry = this.flow;

    for (const switchCase of node.cases) {
      this.flow = entry;
      for (const test of switchCase.tests) {
        if (discriminant === null) {
          this.checkCondition(test);
          continue;
        }

        const type = this.checkValue(test, discriminant);

        if (!isComparable(type, discriminant)) {
          this.error(
            `cannot compare ${typeToString(discriminant)} with ${typeToString(type)}`,
            test,
          );
        }
      }

      const narrowing =
        discriminant === null
          ? switchCase.tests.length === 1
            ? this.narrow(switchCase.tests[0]!, true)
            : []
          : this.narrowCase(node, switchCase, entry);

      this.flow = withNarrowing(entry, narrowing);
      this.checkBlock(switchCase.body);
    }

    this.flow = entry;
  }

  /**
   * `switch filter { case "all": ... default: ... }`: in a case the discriminant has the literals
   * of its tests, in `default` the literals of no case.
   */
  protected narrowCase(
    node: ast.SwitchStatement,
    switchCase: ast.SwitchCase,
    entry: Flow,
  ): Narrowing {
    const binding = node.discriminant ? this.narrowableBinding(node.discriminant) : undefined;

    if (!binding?.type) return [];

    const current = entry.get(binding) ?? binding.type;

    if (!unionMembers(nonNull(current)).some((member) => member.kind === 'literal')) return [];
    if (switchCase.tests.length > 0) {
      const values = switchCase.tests.map(literalValue);

      if (values.some((value) => value === undefined)) return [];

      return [[binding, union(values.map((value) => literal(value!)))]];
    }

    let rest = current;

    for (const other of node.cases) {
      for (const test of other.tests) {
        const value = literalValue(test);

        if (value !== undefined) rest = withoutLiteral(rest, value);
      }
    }

    return [[binding, rest]];
  }

  protected override checkTry(node: ast.TryStatement): void {
    this.dropNarrowing(assignedNames(node));

    const entry = this.flow;

    this.flow = new Map(entry);
    this.checkBlock(node.block.body);

    const { handler, finalizer } = node;

    if (handler) {
      this.flow = new Map(entry);
      this.withScope(() => {
        if (handler.param) this.declareValue(handler.param, 'catch', ANY);
        this.checkStatementList(handler.body.body, false);
      });
    }

    if (finalizer) {
      this.flow = new Map(entry);
      this.checkBlock(finalizer.body);
    }

    this.flow = entry;
  }

  protected checkCondition(node: ast.Expression): void {
    const type = widenLiterals(this.checkValue(node, BOOL));

    if (type.kind === 'bool' || type.kind === 'any' || type.kind === 'unknown') return;

    const hint = isNullable(type)
      ? ': compare it with null, e.g. "x != null"'
      : type.kind === 'number'
        ? ': compare it, e.g. "n != 0"'
        : type.kind === 'string'
          ? ': compare it, e.g. s != ""'
          : '';

    this.error(`condition must be bool, not ${typeToString(type)}${hint}`, node);
  }

  /** Variables whose type is narrowed when `node` evaluates to `assumeTrue`. */
  protected narrow(node: ast.Expression, assumeTrue: boolean): Narrowing {
    if (node.kind === 'UnaryExpression' && node.operator === '!') {
      return this.narrow(node.argument, !assumeTrue);
    }

    if (node.kind !== 'BinaryExpression') return [];

    const { operator, left, right } = node;

    // `a && b` is true, or `a || b` is false: both sides hold, and the right one is narrowed in
    // the flow that the left one gives.
    if ((operator === '&&' && assumeTrue) || (operator === '||' && !assumeTrue)) {
      const first = this.narrow(left, assumeTrue);
      const saved = this.flow;

      this.flow = withNarrowing(saved, first);
      try {
        return [...first, ...this.narrow(right, assumeTrue)];
      } finally {
        this.flow = saved;
      }
    }

    if (operator === '&&' || operator === '||') return [];
    // `x != null` when true, `x == null` when false: `x` is not null.
    if ((operator === '!=' && assumeTrue) || (operator === '==' && !assumeTrue)) {
      const target =
        right.kind === 'NullLiteral' ? left : left.kind === 'NullLiteral' ? right : null;
      const binding = target ? this.narrowableBinding(target) : undefined;

      if (binding?.type) return [[binding, nonNull(this.flow.get(binding) ?? binding.type)]];
    }

    if (operator === 'instanceof') return this.narrowInstanceof(left, right, assumeTrue);
    if (operator !== '==' && operator !== '!=') return [];

    // Whether the comparison is found to give "equal".
    const equal = (operator === '==') === assumeTrue;

    // `typeof x == "string"`
    const [check, tag] =
      left.kind === 'UnaryExpression' && left.operator === 'typeof'
        ? [left, right]
        : right.kind === 'UnaryExpression' && right.operator === 'typeof'
          ? [right, left]
          : [null, null];

    if (check && tag?.kind === 'StringLiteral') {
      const binding = this.narrowableBinding(check.argument);

      if (!binding?.type) return [];

      const type = narrowByTypeof(this.flow.get(binding) ?? binding.type, tag.value, equal);

      return type ? [[binding, type]] : [];
    }

    // `filter == "all"`: narrows a type with literals in it.
    const value = literalValue(right) ?? literalValue(left);
    const target = literalValue(right) !== undefined ? left : right;
    const binding = value === undefined ? undefined : this.narrowableBinding(target);

    if (value === undefined || !binding?.type) return [];

    const current = this.flow.get(binding) ?? binding.type;

    if (!unionMembers(nonNull(current)).some((member) => member.kind === 'literal')) return [];

    return [[binding, equal ? literal(value) : withoutLiteral(current, value)]];
  }

  /** `x instanceof Date`: an instance of the class when true, the rest of a union when false. */
  protected narrowInstanceof(
    left: ast.Expression,
    right: ast.Expression,
    assumeTrue: boolean,
  ): Narrowing {
    const binding = this.narrowableBinding(left);
    const classType = this.typeOfChecked(right);
    const instance = instanceTypeOf(classType);

    if (!binding?.type || !instance) return [];

    const current = this.flow.get(binding) ?? binding.type;
    const members = unionMembers(nonNull(current));

    if (assumeTrue) {
      const kept = members.filter((member) => isAssignable(member, instance));

      return [[binding, kept.length > 0 ? union(kept) : instance]];
    }

    // A class keeps what is not its subclass; a DOM interface what is not assignable to it.
    const kept = members.filter((member) =>
      classType.kind === 'classValue'
        ? !(member.kind === 'class' && isSubclass(member.info, classType.info))
        : !isAssignable(member, instance),
    );

    return [[binding, union(isNullable(current) ? [...kept, NULL] : kept)]];
  }

  protected override narrowableBinding(node: ast.Expression): Binding | undefined {
    if (node.kind !== 'Identifier') return undefined;

    const binding = this.lookupValue(node.name);

    return binding && NARROWABLE.has(binding.kind) ? binding : undefined;
  }

  /** An assignment to a variable ends its narrowing. */
  protected override forget(target: ast.Expression): void {
    const binding = this.narrowableBinding(target);

    if (binding) this.flow.delete(binding);
  }

  protected dropNarrowing(names: ReadonlySet<string>): void {
    this.flow = new Map([...this.flow].filter(([binding]) => !names.has(binding.name)));
  }
}
