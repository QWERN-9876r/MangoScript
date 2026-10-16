import type * as ast from '../ast.ts';
import { arrayName, arrayUses, loopParams } from '../go-for.ts';
import { recordCaptures } from '../goroutines.ts';
import { assignedNames, freeNames } from '../names.ts';
import { forEachChild } from '../walk.ts';
import { firstUse } from './goroutines.ts';
import { LoopChecker } from './loops.ts';
import { notCopied } from './transfer.ts';
import { typedArrayOf, typeToString, type Type } from './types.ts';

// `go for i, v in items { ... }`: the parts of an array or a typed array run as goroutines. Each
// worker gets its part and copies of the local names that the body uses, so the body reaches the
// array only through its own element, `items[i]`, and changes nothing else that would stay here.

export abstract class GoForChecker extends LoopChecker {
  protected override checkForIn(node: ast.ForInStatement): void {
    super.checkForIn(node);
    if (node.go) this.checkGoFor(node);
  }

  private checkGoFor(node: ast.ForInStatement): void {
    const iterable = this.checkedTypes.get(node.iterable);

    if (iterable && !isSplit(iterable)) {
      if (iterable.kind !== 'unknown' && iterable.kind !== 'any') {
        this.error(
          `"go for" splits an array among workers, but ${typeToString(iterable)} is not an array; loop over a []T or a typed array, e.g. "go for i, v in pixels { ... }"`,
          node.iterable,
        );
      }
    } else if (iterable) {
      const reason = notCopied(iterable);

      if (reason) {
        this.error(
          `"go for" copies the parts of the array to workers, but ${reason}`,
          node.iterable,
        );
      }
    }

    const array = arrayName(node);

    for (const use of arrayUses(node).others) {
      this.error(
        node.key && node.key.name !== '_'
          ? `"go for" gives each worker only its part of "${array}", so the body uses it only as ${array}[${node.key.name}]; read other elements from another array, e.g. "go for i, _ in out { out[i] = src[i] + src[i + 1] }"`
          : `"go for" gives each worker only its part of "${array}", so the body uses it only as its own element; name the index to write it, e.g. "go for i, v in ${array} { ${array}[i] = v * 2 }"`,
        use,
      );
    }

    this.checkCaptures(node, array);
  }

  /**
   * The names that the body uses from around it: those of the module go to the worker module as
   * with a function there; local ones are copied to each worker, so they must be data. Either way
   * a worker has its own, so changes to them there would not come back.
   */
  private checkCaptures(node: ast.ForInStatement, array: string | null): void {
    const captured: string[] = [];
    const assigned = assignedNames(node.body);
    const written = writtenNames(node.body);

    for (const name of freeNames({ params: loopParams(node), body: node.body })) {
      const binding = this.lookupValue(name);

      if (name === array || !binding || binding === this.globals.values.get(name)) continue;

      const at = firstUse(node.body, name) ?? node;
      const module = binding === this.moduleScope.values.get(name);
      const reason = module ? null : binding.type && notCopied(binding.type);

      if (module) this.checkReach('the body of "go for"', [name], at);
      else captured.push(name);

      if (reason) {
        this.error(
          `the body of "go for" runs in workers, which get a copy of "${name}", but ${reason}`,
          at,
        );
      } else if (assigned.has(name)) {
        this.error(
          `the body of "go for" runs in workers, which get a copy of "${name}", so changing it there does not change it here; write the results into the array of the loop, or send them through a channel`,
          at,
        );
      } else if (written.has(name)) {
        this.error(
          `the body of "go for" runs in workers, which get a copy of "${name}", so changing it there does not change it here; loop over the array you write, e.g. "go for i, _ in ${name} { ${name}[i] = ... }"`,
          at,
        );
      }
    }

    recordCaptures(node, captured);
  }
}

/** An array or a typed array, which `go for` splits into parts. */
function isSplit(type: Type): boolean {
  return type.kind === 'array' || typedArrayOf(type) !== null;
}

/** The names whose elements or properties code writes: `out[i] = v`, `point.x++`. */
function writtenNames(node: ast.Node, names = new Set<string>()): Set<string> {
  const add = (target: ast.Expression) => {
    if (target.kind !== 'IndexExpression' && target.kind !== 'MemberExpression') return;

    let root: ast.Expression = target;

    while (root.kind === 'IndexExpression' || root.kind === 'MemberExpression') root = root.object;
    if (root.kind === 'Identifier') names.add(root.name);
  };

  if (node.kind === 'AssignmentStatement') node.targets.forEach(add);
  else if (node.kind === 'IncDecStatement') add(node.target);
  forEachChild(node, (child) => writtenNames(child, names));

  return names;
}
