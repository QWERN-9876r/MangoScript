import type { Expression, Identifier, StringLiteral } from './expressions.ts';
import type { TypeMember, TypeNode, TypeReference } from './markup.ts';
import type { BlockStatement, Statement } from './statements.ts';

// Nodes of the program, imports and declarations.

export interface NodeBase {
  start: number;
  end: number;
}

// ─── Program and modules ─────────────────────────────────────────────────────────────────────────

export interface Program extends NodeBase {
  kind: 'Program';
  body: Statement[];
}

/**
 * `import x from "mod"`, `import * as ns from "mod"`, `import { a, b as c } from "mod"`,
 * `import x, { a } from "mod"` and `import "mod"`.
 */
export interface ImportDeclaration extends NodeBase {
  kind: 'ImportDeclaration';
  defaultImport: Identifier | null;
  namespaceImport: Identifier | null;
  namedImports: ImportSpecifier[];
  source: StringLiteral;
}

/** `a` or `a as b` inside `import { ... }`. Without `as`, `imported` and `local` are the same node. */
export interface ImportSpecifier extends NodeBase {
  kind: 'ImportSpecifier';
  imported: Identifier;
  local: Identifier;
}

// ─── Declarations ────────────────────────────────────────────────────────────────────────────────

/** `func divide(a, b number) (number, error) { ... }` */
export interface FuncDeclaration extends NodeBase {
  kind: 'FuncDeclaration';
  exported: boolean;
  name: Identifier;
  /** `[T any, U Shape]` after the name; empty for ordinary functions. */
  typeParams: TypeParameter[];
  params: Parameter[];
  /** Result types: `[]` for no result, `[T]` for one, `[T1, T2]` for `(T1, T2)`. */
  results: TypeNode[];
  body: BlockStatement;
}

/** `name number`. The type is `null` only for arrow function parameters inferred from context. */
export interface Parameter extends NodeBase {
  kind: 'Parameter';
  name: Identifier;
  type: TypeNode | null;
  /** `kind string = "info"`: only properties of components have default values. */
  defaultValue: Expression | null;
}

/**
 * `comp Card(title string, children Content) { ...; return <section>...</section> }`. Components
 * exist only at compile time: each use is replaced by the component's code.
 */
export interface ComponentDeclaration extends NodeBase {
  kind: 'ComponentDeclaration';
  exported: boolean;
  name: Identifier;
  params: Parameter[];
  body: BlockStatement;
}

/**
 * `let x number`, `const PI = 3.14`, `let a, b = 1, 2`, `const q, err = divide(10, 2)`; inside a
 * component also `state count = 0`.
 *
 * `values` is empty (every name gets its zero value), has one value per name, or holds a single
 * call that returns several values.
 */
export interface VariableDeclaration extends NodeBase {
  kind: 'VariableDeclaration';
  exported: boolean;
  keyword: 'let' | 'const' | 'state';
  /** `_` is an ordinary identifier here; the checker treats it as "skip this value". */
  names: Identifier[];
  type: TypeNode | null;
  values: Expression[];
}

/** `class Admin extends User implements Shape { ... }` */
export interface ClassDeclaration extends NodeBase {
  kind: 'ClassDeclaration';
  exported: boolean;
  name: Identifier;
  typeParams: TypeParameter[];
  /** An expression, as in JS, so that classes from JS modules can be extended. */
  superClass: Expression | null;
  implements: TypeReference[];
  members: ClassMember[];
}

export type ClassMember = FieldDeclaration | ConstructorDeclaration | MethodDeclaration;

export type Visibility = 'public' | 'protected' | 'private';

/** `private age number`, `static count = 0`, `name = "circle"`. */
export interface FieldDeclaration extends NodeBase {
  kind: 'FieldDeclaration';
  /** `public` when no modifier is written. */
  visibility: Visibility;
  isStatic: boolean;
  name: Identifier;
  type: TypeNode | null;
  value: Expression | null;
}

/** `constructor(name string, age number) { ... }` */
export interface ConstructorDeclaration extends NodeBase {
  kind: 'ConstructorDeclaration';
  visibility: Visibility;
  params: Parameter[];
  body: BlockStatement;
}

/** `greet() string { ... }`. Methods are written without `func`, as in JS classes. */
export interface MethodDeclaration extends NodeBase {
  kind: 'MethodDeclaration';
  visibility: Visibility;
  isStatic: boolean;
  name: Identifier;
  params: Parameter[];
  results: TypeNode[];
  body: BlockStatement;
}

/** `interface Shape { name string; area() number }` */
export interface InterfaceDeclaration extends NodeBase {
  kind: 'InterfaceDeclaration';
  exported: boolean;
  name: Identifier;
  typeParams: TypeParameter[];
  members: TypeMember[];
}

/** `type ID string`, `type Handler func(string) bool`, `type Pair[A, B any] { ... }`. */
export interface TypeAliasDeclaration extends NodeBase {
  kind: 'TypeAliasDeclaration';
  exported: boolean;
  name: Identifier;
  typeParams: TypeParameter[];
  type: TypeNode;
}

/** `T any` or `T Shape` in `[T any, U Shape]`; the constraint is `null` when it is left out. */
export interface TypeParameter extends NodeBase {
  kind: 'TypeParameter';
  name: Identifier;
  constraint: TypeNode | null;
}
