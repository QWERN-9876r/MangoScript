import type * as ast from '../ast.ts';
import { isIterator, isYieldCall } from '../iterators.ts';
import { forEachChild } from '../walk.ts';
import { GoForChecker } from './go-for.ts';
import {
  ANY,
  arrayOf,
  instantiate,
  typeToString,
  union,
  UNKNOWN,
  VOID,
  type FunctionType,
  type Type,
} from './types.ts';

// Iterators, `func(yield func(T) bool)`, as in Go 1.23 (src/iterators.ts). They compile to JS
// generators, so they keep to what a generator can do: `yield` is only called, in the body of the
// iterator itself and not in a function inside it; the iterator is not async and returns nothing;
// and it is not called with a function, as Go allows, but gone over with `for ... in`. Called
// without arguments, it gives what a generator function gives: a lazy JS iterator, with `take`,
// `map`, `filter` and the like.

const NESTED: ReadonlySet<ast.Node['kind']> = new Set([
  'FuncDeclaration',
  'FuncExpression',
  'ArrowFunction',
  'ClassDeclaration',
]);

export abstract class IteratorChecker extends GoForChecker {
  protected override checkCall(
    node: ast.CallExpression,
    callee: Type,
    expected: Type | null = null,
  ): Type {
    if (callee.kind !== 'function' || !callee.iterator) {
      return super.checkCall(node, callee, expected);
    }

    if (node.arguments.length === 0) return this.generatorOf(callee);

    this.error(
      `${typeToString(callee)} is an iterator, gone over with "for": e.g. "for value in items"; it compiles to a JS generator, which takes no function, and seq() gives it`,
      node,
    );

    return UNKNOWN;
  }

  /** `Generator<T>` of the lib files, or `Generator<[K, V]>` for a yield of two values. */
  private generatorOf(iterator: FunctionType): Type {
    const generator = this.options.library?.type('Generator');
    const yieldType = iterator.params[0];
    const taken = yieldType?.kind === 'function' ? yieldType.params : [];
    const value = taken.length === 1 ? taken[0]! : arrayOf(union(taken));

    if (generator?.kind !== 'object' || generator.typeParams?.length !== 3) return ANY;

    return instantiate(generator, [value, VOID, ANY]);
  }

  /** The rules of iterators in the whole program; Checker.run calls it. */
  protected checkIterators(): void {
    const visit = (node: ast.Node) => {
      if (
        node.kind === 'FuncDeclaration' ||
        node.kind === 'FuncExpression' ||
        node.kind === 'MethodDeclaration'
      ) {
        if (isIterator(node.params)) this.checkIterator(node);
      } else if (node.kind === 'ArrowFunction' && isIterator(node.params)) {
        this.error(
          'an iterator is written with func, not as an arrow function: JS has no arrow generators, e.g. func(yield func(number) bool) { ... }',
          node,
        );
      }

      forEachChild(node, visit);
    };

    visit(this.program);
  }

  private checkIterator(
    node: ast.FuncDeclaration | ast.FuncExpression | ast.MethodDeclaration,
  ): void {
    const param = node.params[0]!;
    const type = param.type;

    if (node.async) {
      this.error(
        'an iterator cannot be async: it compiles to a JS generator, which yields at once; wait where it is gone over instead',
        node,
      );
    }

    if (node.results.length > 0) {
      this.error('an iterator returns nothing: it gives its values to yield', node.results[0]!);
    }

    const result = type?.kind === 'FuncType' && type.results.length === 1 ? type.results[0] : null;
    const yieldsBool =
      type?.kind === 'FuncType' &&
      type.params.length >= 1 &&
      type.params.length <= 2 &&
      result?.kind === 'TypeReference' &&
      result.name.name === 'bool';

    if (!yieldsBool) {
      this.error(
        'the yield of an iterator is func(T) bool or func(K, V) bool, e.g. func(yield func(number) bool)',
        type ?? param,
      );
    }

    this.checkYields(node.body, false);
  }

  /** Where `yield` is used in the body of an iterator; `nested` inside a function in it. */
  private checkYields(node: ast.Node, nested: boolean): void {
    if (isYieldCall(node)) {
      if (nested) {
        this.error(
          'yield is called in a function inside the iterator: a JS generator yields only in its own body, so loop there, e.g. for x in items { if !yield(x) { return } }',
          node.callee,
        );
      }

      for (const argument of node.arguments) this.checkYields(argument, nested);

      return;
    }

    if (node.kind === 'Identifier' && node.name === 'yield') {
      this.error(
        'an iterator only calls yield, e.g. "if !yield(v) { return }": it compiles to a JS generator, where yield is not a value',
        node,
      );

      return;
    }

    // An iterator inside has its own yield, checked on its own.
    if (
      (node.kind === 'FuncExpression' || node.kind === 'FuncDeclaration') &&
      isIterator(node.params)
    ) {
      return;
    }

    const inner = nested || NESTED.has(node.kind);

    forEachChild(node, (child) => this.checkYields(child, inner));
  }
}
