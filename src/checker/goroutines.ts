import type * as ast from '../ast.ts';
import { reach } from '../goroutines.ts';
import { CallChecker } from './calls.ts';
import { awaited } from './promise.ts';
import { notCopied } from './transfer.ts';
import { UNKNOWN, type Type } from './types.ts';

// `go work(x)`: the call of a function of the module in a worker. The worker gets copies of the
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

    if (callee.kind !== 'Identifier' || !this.isModuleFunction(callee.name)) {
      this.error(
        '"go" calls a function declared at the top level of a module or imported: a worker has only those, e.g. "go work(x)"',
        callee,
      );

      return UNKNOWN;
    }

    const name = callee.name;

    call.arguments.forEach((arg, i) => {
      const value = arg.kind === 'SpreadElement' ? arg.argument : arg;
      const type = this.checkedTypes.get(value);
      const element = arg.kind === 'SpreadElement' && type?.kind === 'array' ? type.element : type;
      const reason = element && notCopied(element);

      if (reason) {
        this.error(
          `"${name}" runs in a worker, which gets a copy of argument ${i + 1}, but ${reason}`,
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
        `"${name}" runs in a worker, which sends back a copy of its result, but ${reason}`,
        node,
      );
    }

    this.checkReach(name, node);

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

  private checkReach(name: string, node: ast.GoExpression): void {
    if (this.reached.has(name)) return;
    this.reached.add(name);

    const { lets, markup } = reach(this.program, [name]);

    for (const variable of lets) {
      this.error(
        `"${name}" runs in a worker, which does not share the variables of the module, but its code uses "${variable}"; pass the value as an argument, or make it a const`,
        node,
      );
    }

    if (markup !== null) {
      this.error(
        `"${name}" runs in a worker, which has no document, but its code uses ${markup}`,
        node,
      );
    }
  }
}
