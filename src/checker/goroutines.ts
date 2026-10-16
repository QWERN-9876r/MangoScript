import type * as ast from '../ast.ts';
import { reach, recordCaptures } from '../goroutines.ts';
import { assignedNames, freeNames } from '../names.ts';
import { forEachChild } from '../walk.ts';
import { CallChecker } from './calls.ts';
import { awaited } from './promise.ts';
import { notCopied } from './transfer.ts';
import { UNKNOWN, type Type } from './types.ts';

// `go work(x)`: the call of a function of the module in a worker; `go func(x) { ... }(y)`: of a
// function literal, which gets copies of the local names it uses. The worker gets copies of the
// arguments and gives back a copy of the result, so both must be data that can be copied; and the
// code of the function must not need what a worker does not have: the variables of the module and
// a document.

export abstract class GoroutineChecker extends CallChecker {
  /** The functions already checked for what their code reaches, so each is reported once. */
  private readonly reached = new Set<string>();

  protected override checkGo(node: ast.GoExpression): Type {
    const { call } = node;
    const result = this.checkExpression(call, null);
    const { callee } = call;

    if (
      callee.kind !== 'FuncExpression' &&
      (callee.kind !== 'Identifier' || !this.isModuleFunction(callee.name))
    ) {
      this.error(
        '"go" calls a function declared at the top level of a module or imported, or a function literal: a worker has only those, e.g. "go work(x)" or "go func() { ... }()"',
        callee,
      );

      return UNKNOWN;
    }

    const name = callee.kind === 'Identifier' ? `"${callee.name}"` : 'the goroutine';

    call.arguments.forEach((arg, i) => {
      const value = arg.kind === 'SpreadElement' ? arg.argument : arg;
      const type = this.checkedTypes.get(value);
      const element = arg.kind === 'SpreadElement' && type?.kind === 'array' ? type.element : type;
      const reason = element && notCopied(element);

      if (reason) {
        this.error(
          `${name} runs in a worker, which gets a copy of argument ${i + 1}, but ${reason}`,
          value,
        );
      }
    });

    // An async function gives what its Promise gives, once the worker has waited for it.
    const value = awaited(result);
    const results = value.kind === 'tuple' ? value.types : value.kind === 'void' ? [] : [value];
    const reason = results.map((type) => notCopied(type)).find((found) => found !== null);

    if (reason) {
      this.error(
        `${name} runs in a worker, which sends back a copy of its result, but ${reason}`,
        node,
      );
    }

    if (callee.kind === 'Identifier') {
      if (!this.reached.has(callee.name)) {
        this.reached.add(callee.name);
        this.checkReach(name, [callee.name], node);
      }
    } else {
      this.checkLiteral(node, callee);
    }

    return this.promiseOf(results);
  }

  /** A function declared at the top level of the module, or an imported name. */
  private isModuleFunction(name: string): boolean {
    const binding = this.lookupValue(name);

    return (
      binding !== undefined &&
      binding === this.moduleScope.values.get(name) &&
      (binding.kind === 'function' || binding.kind === 'import')
    );
  }

  /**
   * The names that a literal uses from around it: those of the module go to the worker module as
   * with a function there; local ones are copied to the worker, so they must be data, and changing
   * a copy would not change them.
   */
  private checkLiteral(node: ast.GoExpression, literal: ast.FuncExpression): void {
    const captured: string[] = [];
    const module: string[] = [];
    const assigned = assignedNames(literal.body);

    for (const name of freeNames(literal)) {
      const binding = this.lookupValue(name);

      if (!binding || binding === this.globals.values.get(name)) continue;
      if (binding === this.moduleScope.values.get(name)) {
        module.push(name);
        continue;
      }

      captured.push(name);

      const reason = binding.type && notCopied(binding.type);
      const at = firstUse(literal.body, name) ?? node;

      if (reason) {
        this.error(
          `the goroutine runs in a worker, which gets a copy of "${name}", but ${reason}`,
          at,
        );
      } else if (assigned.has(name)) {
        this.error(
          `the goroutine runs in a worker, which gets a copy of "${name}", so changing it there does not change it here; send the new value through a channel or return it`,
          at,
        );
      }
    }

    recordCaptures(node, captured);
    for (const name of module)
      this.checkReach('the goroutine', [name], firstUse(literal.body, name) ?? node);
  }

  protected checkReach(name: string, names: string[], node: ast.NodeBase): void {
    const { lets, markup } = reach(this.program, names);

    for (const variable of lets) {
      this.error(
        `${name} runs in a worker, which does not share the variables of the module, but its code uses "${variable}"; pass the value as an argument, or make it a const`,
        node,
      );
    }

    if (markup !== null) {
      this.error(
        `${name} runs in a worker, which has no document, but its code uses ${markup}`,
        node,
      );
    }
  }
}

/** The first place where code uses a name, for a message about it. */
export function firstUse(node: ast.Node, name: string): ast.Identifier | null {
  if (node.kind === 'Identifier') return node.name === name ? node : null;

  let found: ast.Identifier | null = null;

  forEachChild(node, (child) => {
    found ??= firstUse(child, name);
  });

  return found;
}
