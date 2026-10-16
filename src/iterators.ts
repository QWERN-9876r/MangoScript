import type * as ast from './ast.ts';
import { forEachChild } from './walk.ts';

// Iterators, as in Go 1.23: a function whose one parameter is `yield`, `func(yield func(T) bool)`.
// It compiles to a JS generator: `yield(v)` yields `v`, and when the loop that goes over it stops,
// the generator is closed, so the iterator returns there, with its `defer`s run. The checker
// (src/checker/iterators.ts) and the code generator both tell iterators by this parameter.

/** Whether a function with these parameters is an iterator. */
export function isIterator(params: readonly ast.Parameter[]): boolean {
  return params.length === 1 && params[0]!.name.name === 'yield';
}

/** `yield(v)` or `yield(k, v)`: a call of the parameter of an iterator. */
export function isYieldCall(node: ast.Node): node is ast.CallExpression {
  return (
    node.kind === 'CallExpression' &&
    node.callee.kind === 'Identifier' &&
    node.callee.name === 'yield'
  );
}

/**
 * Whether a body uses `this` of the code around it. A func literal is an arrow function, which
 * has it; an iterator literal becomes a generator function, which needs it bound.
 */
export function usesThis(node: ast.Node): boolean {
  if (node.kind === 'ThisExpression') return true;
  if (
    node.kind === 'FuncDeclaration' ||
    node.kind === 'ClassDeclaration' ||
    (node.kind === 'FuncExpression' && isIterator(node.params))
  ) {
    return false;
  }

  let found = false;

  forEachChild(node, (child) => {
    found ||= usesThis(child);
  });

  return found;
}
