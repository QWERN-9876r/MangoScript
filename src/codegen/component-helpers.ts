import type * as ast from '../ast.ts';
import { containsReturn } from '../recursion.ts';
import type { Reactive } from './reactive.ts';

// Types and small functions of component code generation.

/** How the code of a component ends: inlined into a block, or the body of a function. */
export type Ending =
  | { kind: 'inline'; setters: ReadonlyMap<string, string> }
  | { kind: 'function'; props: readonly ast.Parameter[] };

/**
 * A component with an early `return`. The body runs once, so which markup it returns is decided
 * once, when it is created. Each returned markup gets its own update, kept in `view`.
 */
export interface EarlyReturns {
  /** The function context of the body; a `return` in a nested function is that function's. */
  fn: unknown;
  result: string;
  reactive: Reactive;
  view: string;
  /** Leaves the body: `break $$body3;` or `return [$$tree4, $$setTree5];` */
  exit: string;
  /** In a function: the function that sets the properties, declared once for every return. */
  setter: string | null;
}

/** Marks where the setters of an inlined component with early returns go: before any return. */
export const SETTERS = String.fromCharCode(0xe002);

/** `f(a, undefined, undefined)` → `f(a)`: missing arguments are undefined anyway. */
export function withoutTrailingUndefined(args: string[]): string[] {
  let end = args.length;
  while (end > 0 && args[end - 1] === 'undefined') end--;
  return args.slice(0, end);
}

/** Whether a component has `mount() { ... }`. */
export function hasMount(component: ast.ComponentDeclaration): boolean {
  return component.body.body.some((statement) => statement.kind === 'MountStatement');
}

/** Whether a component returns before the end of its body. */
export function hasEarlyReturn(component: ast.ComponentDeclaration): boolean {
  return component.body.body.slice(0, -1).some(containsReturn);
}
