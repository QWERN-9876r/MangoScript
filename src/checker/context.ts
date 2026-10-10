import type * as ast from '../ast.ts';
import type { Wrapper } from '../decorators.ts';
import type { Diagnostic } from '../diagnostics.ts';
import { GLOBAL_TYPES, GLOBAL_VALUES, LIBRARY_TYPES } from './builtins.ts';
import { type ClassInfo, type Type, type TypeParam } from './types.ts';

// What the layers of the checker share: the options and results of `check`, scopes and bindings,
// and the context of the function and the class being checked.

export interface ModuleExports {
  values: Map<string, Type>;
  types: Map<string, Type>;
  /** `export dec`: decorators have a namespace of their own. */
  decorators?: Map<string, DecoratorInfo>;
  /** `export comp`: components are used as tags, not as values. */
  components?: Map<string, ComponentInfo>;
}

/** What `importModule` found: the module's exports, an error for the import, or nothing (untyped). */
export type ImportResult = { exports: ModuleExports } | { error: string } | undefined;

/**
 * Types of the JS standard library and the DOM from TypeScript's lib files and global `@types`.
 * They extend the built-in types of builtins.ts and dom.ts, which are used without them (in the
 * browser).
 */
export interface Library {
  /** A global value, e.g. `document`. */
  value(name: string): Type | undefined;
  /** A global type, e.g. `HTMLElement`. */
  type(name: string): Type | undefined;
  /** `String`, `Number` or `Boolean`: members that the built-in types do not list. */
  primitive(kind: 'string' | 'number' | 'bool'): Type | undefined;
  /** `Array<element>`: members that the built-in array type does not list. */
  array(element: Type): Type | undefined;
  /** What `<tag>` creates: `HTMLElementTagNameMap[tag]`. */
  element(tag: string): Type | undefined;
  /** The event of `on<name>`: `HTMLElementEventMap[name]`, e.g. `MouseEvent` for `click`. */
  event(name: string): Type | undefined;
}

export interface CheckOptions {
  /** Called for imports of `.mango` modules; without it, every import is untyped (`any`). */
  importModule?: (specifier: string) => ImportResult;
  /**
   * Called for the other imports (packages, `node:` modules, `.ts` files): their types come from
   * TypeScript declarations. Without it, or for a module without types, the import is untyped.
   */
  importDeclarations?: (specifier: string) => ImportResult;
  /** Types of the standard library and the DOM beyond the built-in ones. */
  library?: Library;
}

export interface CheckResult {
  diagnostics: Diagnostic[];
  exports: ModuleExports;
  /** Types of every declaration at the top level of the module, exported or not. */
  declarations: ModuleExports;
  /** Types of checked expressions, for code generation (e.g. how to insert element children). */
  types: WeakMap<ast.Expression, Type>;
}

export type BindingKind =
  | 'let'
  | 'const'
  | 'state'
  | 'param'
  | 'prop'
  | 'function'
  | 'class'
  | 'import'
  | 'loop'
  | 'catch'
  | 'builtin'
  | 'component';

export interface Binding {
  name: string;
  kind: BindingKind;
  /** `null` while a variable is declared but its declaration has not been checked yet. */
  type: Type | null;
  /** For components, which exist only at compile time and are used as tags. */
  component?: ComponentInfo;
}

export interface ComponentInfo {
  node: ast.ComponentDeclaration;
  /** Properties by name; optional ones have a default value or a nullable type. */
  props: Map<string, { type: Type; optional: boolean }>;
  /** Names from the module that the component's code uses, computed when first needed. */
  freeNames: Set<string> | null;
  /**
   * Compiled to a function, not inlined: it uses itself, directly or through other components, it
   * is a web component (`@html-tag`), or other modules use it (`export comp`).
   */
  isFunction: boolean;
  /** The decorators applied to it that exist, in the order they are written. */
  decorators: DecoratorInfo[];
  /** The component with its decorators applied: the code that is inlined where it is used. */
  expanded: ast.ComponentDeclaration;
  /**
   * The type of `<Card />` for an exported component, found in its module: the tags of its markup
   * are names there.
   */
  result: Type | null;
}

export interface DecoratorInfo {
  node: ast.DecoratorDeclaration;
  /** The types of the parameters, resolved with the other declarations of the module. */
  params: Type[];
  /** Public state, constants and functions, known once the body is checked. */
  members: Map<string, PublicMember>;
  /** The declarations of the body and the parameters: a member that is not public is one of them. */
  names: Set<string>;
  /** Names from the module that the decorator's code uses, computed when first needed. */
  freeNames: Set<string> | null;
  /** `return (content Element) => ...`, with the type of what it gets from the component. */
  wrapper: { node: Wrapper; param: Type } | null;
  /** The decorators after `needs` that exist; they are applied above it. */
  needed: DecoratorInfo[];
  /**
   * For an exported decorator: the names of its module that its code uses, which other modules get
   * through hidden exports, and the types of its expressions, for the code generator there.
   */
  moduleNames: string[];
  expressionTypes: WeakMap<ast.Expression, Type> | null;
}

export interface PublicMember {
  kind: 'state' | 'const' | 'func';
  type: Type;
}

/** A `type` alias, resolved when first used. */
export interface AliasEntry {
  kind: 'alias';
  node: ast.TypeAliasDeclaration;
  scope: Scope;
  /** `type Pair[A, B any] ...`: references give arguments for these. */
  params: TypeParam[];
  resolved: Type | null;
  resolving: boolean;
}

export class Scope {
  readonly parent: Scope | null;
  readonly values = new Map<string, Binding>();
  readonly types = new Map<string, Type | AliasEntry>();

  constructor(parent: Scope | null) {
    this.parent = parent;
  }
}

export interface FunctionContext {
  /** Declared result types, or `null` when they are inferred from the `return` statements. */
  results: Type[] | null;
  /** Types of the `return` statements, for inferring the results. */
  returns: Type[][];
  isConstructor: boolean;
  /** The body of a component: every `return` gives markup. */
  isComponent?: boolean;
}

export interface ClassContext {
  info: ClassInfo;
  isStatic: boolean;
}

/**
 * Types of variables narrowed by the code before the current point, e.g. `?User` → `User`
 * after `if user == null { return }`.
 */
export type Flow = Map<Binding, Type>;
export type Narrowing = [Binding, Type][];

export const NARROWABLE: ReadonlySet<BindingKind> = new Set([
  'let',
  'const',
  'state',
  'param',
  'prop',
  'catch',
  'loop',
]);

/** Built-in globals. With a library, the untyped ones and the DOM types come from it instead. */
export function globalScope(library: Library | undefined): Scope {
  const scope = new Scope(null);

  for (const [name, type] of GLOBAL_VALUES) {
    if (library && type.kind === 'any') continue;
    scope.values.set(name, { name, kind: 'builtin', type });
  }

  for (const [name, type] of GLOBAL_TYPES) {
    if (library && LIBRARY_TYPES.has(name)) continue;
    scope.types.set(name, type);
  }

  return scope;
}
