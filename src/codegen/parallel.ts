import type * as ast from '../ast.ts';
import { arrayName, arrayUses, partOf, writesArray } from '../go-for.ts';
import { goCaptures, goTarget } from '../goroutines.ts';
import { declaredIn } from '../names.ts';
import type { BindingKind } from './analysis.ts';
import { ControlStatementEmitter } from './control-statements.ts';
import { ARROW } from './syntax.ts';

// `go for i, v in items { ... }`: `await $$goFor("$$goroutine0", items, ...)` splits the array into
// parts and runs each as a goroutine (go-helpers.ts). In the worker module, the function of a part
// loops over it: `i` is the index in the whole array, from `$$from`, the index of the part's first
// element, and `items[i]` is `items[$$i]`, the index in the part. The part goes back if the body
// writes into it; a typed array is moved back, not copied.

export abstract class ParallelLoopEmitter extends ControlStatementEmitter {
  protected override forInStatement(node: ast.ForInStatement): void {
    const loop = partOf(node);

    if (loop) {
      this.partLoop(node, loop);

      return;
    }

    if (!node.go) {
      super.forInStatement(node);

      return;
    }

    const args = [
      JSON.stringify(goTarget(this.program, node)),
      this.expression(node.iterable, ARROW),
      ...goCaptures(this.program, node).map((name) => this.name(name)),
    ];

    this.helpers.add('goFor');
    this.helpers.add(this.inWorker ? 'goLocal' : 'go');
    this.line(`await $$goFor(${args.join(', ')});`);
  }

  /** The loop over a part, in the function of the worker module that runs it. */
  private partLoop(node: ast.ForInStatement, loop: ast.ForInStatement): void {
    const array = this.name(arrayName(loop) ?? '$$items');
    const uses = arrayUses(loop);
    const key = node.key && node.key.name !== '_' ? node.key.name : null;
    const value = node.value.name === '_' ? null : node.value.name;
    const bindings = [key, value].flatMap((name): [string, BindingKind][] =>
      name === null ? [] : [[name, 'loop']],
    );
    // A declaration of the same name in the body would clash with the loop's in one block.
    const hidden = declaredIn(node.body.body).some((name) => name === key || name === value);

    for (const element of uses.elements) this.partElements.add(element);
    this.withScope(bindings, () => {
      const body = this.withBreakTarget(null, () =>
        this.block(() => {
          if (key !== null) this.line(`const ${this.name(key)} = $$from + $$i;`);
          if (value !== null) this.line(`const ${this.name(value)} = ${array}[$$i];`);
          if (hidden) this.line(this.blockStatement(node.body));
          else this.blockStatements(node.body.body);
        }),
      );

      this.line(`for (let $$i = 0; $$i < ${array}.length; $$i++) ${body}`);
    });
    for (const element of uses.elements) this.partElements.delete(element);

    if (!writesArray(loop, uses)) return;

    // The part of a typed array moves back; without types, $$transfer leaves an array as it is.
    const plain = this.options.types?.get(loop.iterable)?.kind === 'array';

    this.line(plain ? `return ${array};` : `return $$transfer(${array});`);
  }
}
