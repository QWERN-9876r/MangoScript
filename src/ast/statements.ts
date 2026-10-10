import type {
  ClassDeclaration,
  ComponentDeclaration,
  DecoratorDeclaration,
  FuncDeclaration,
  ImportDeclaration,
  InterfaceDeclaration,
  NodeBase,
  TypeAliasDeclaration,
  VariableDeclaration,
} from './declarations.ts';
import type { CallExpression, Expression, Identifier } from './expressions.ts';
import type { JsxElementStatement } from './markup.ts';

// ─── Statements ──────────────────────────────────────────────────────────────────────────────────

export type Statement =
  | ImportDeclaration
  | FuncDeclaration
  | ComponentDeclaration
  | DecoratorDeclaration
  | VariableDeclaration
  | ClassDeclaration
  | InterfaceDeclaration
  | TypeAliasDeclaration
  | BlockStatement
  | ExpressionStatement
  | AssignmentStatement
  | IncDecStatement
  | ReturnStatement
  | IfStatement
  | ForStatement
  | ForInStatement
  | SwitchStatement
  | BreakStatement
  | ContinueStatement
  | ThrowStatement
  | TryStatement
  | DeferStatement
  | MountStatement
  | JsxElementStatement;

/** Statements allowed in the `init` and `update` parts of a `for` header. */
export type SimpleStatement =
  VariableDeclaration | ExpressionStatement | AssignmentStatement | IncDecStatement;

export interface BlockStatement extends NodeBase {
  kind: 'BlockStatement';
  body: Statement[];
}

export interface ExpressionStatement extends NodeBase {
  kind: 'ExpressionStatement';
  expression: Expression;
}

export type AssignmentOperator =
  | '='
  | '+='
  | '-='
  | '*='
  | '/='
  | '%='
  | '**='
  | '&='
  | '|='
  | '^='
  | '<<='
  | '>>='
  | '>>>='
  | '&&='
  | '||='
  | '??=';

/**
 * `x = 1`, `a, b = b, a`, `total += v`. Assignment is a statement, as in Go, so `f(a = 1)` and
 * `a = b = c` are not valid. Compound operators take exactly one target.
 */
export interface AssignmentStatement extends NodeBase {
  kind: 'AssignmentStatement';
  operator: AssignmentOperator;
  /** Identifiers, member or index expressions. */
  targets: Expression[];
  /** One value per target, or a single call that returns several values. */
  values: Expression[];
}

/** `i++` and `i--`, statements only (as in Go). */
export interface IncDecStatement extends NodeBase {
  kind: 'IncDecStatement';
  operator: '++' | '--';
  target: Expression;
}

/** `return`, `return x`, `return q, null`. */
export interface ReturnStatement extends NodeBase {
  kind: 'ReturnStatement';
  values: Expression[];
}

export interface IfStatement extends NodeBase {
  kind: 'IfStatement';
  condition: Expression;
  consequent: BlockStatement;
  /** `else { ... }` or `else if ...`. */
  alternate: BlockStatement | IfStatement | null;
}

/**
 * Every `for` loop except `for ... in`:
 *
 *     for let i = 0; i < n; i++ { }   init, condition, update
 *     for cond { }                    condition only
 *     for { }                         nothing
 */
export interface ForStatement extends NodeBase {
  kind: 'ForStatement';
  init: SimpleStatement | null;
  condition: Expression | null;
  update: SimpleStatement | null;
  body: BlockStatement;
}

/** `for x in items { }` (key is `null`) and `for i, x in items { }`. */
export interface ForInStatement extends NodeBase {
  kind: 'ForInStatement';
  key: Identifier | null;
  value: Identifier;
  iterable: Expression;
  body: BlockStatement;
}

/** `switch cmd { ... }`, or `switch { ... }` without a discriminant as an if/else chain. */
export interface SwitchStatement extends NodeBase {
  kind: 'SwitchStatement';
  discriminant: Expression | null;
  cases: SwitchCase[];
}

/** `case "start", "run": ...`, or `default: ...` when `tests` is empty. */
export interface SwitchCase extends NodeBase {
  kind: 'SwitchCase';
  tests: Expression[];
  body: Statement[];
}

export interface BreakStatement extends NodeBase {
  kind: 'BreakStatement';
}

export interface ContinueStatement extends NodeBase {
  kind: 'ContinueStatement';
}

export interface ThrowStatement extends NodeBase {
  kind: 'ThrowStatement';
  argument: Expression;
}

export interface TryStatement extends NodeBase {
  kind: 'TryStatement';
  block: BlockStatement;
  handler: CatchClause | null;
  finalizer: BlockStatement | null;
}

/** `catch e { ... }`, or `catch { ... }` without a parameter. */
export interface CatchClause extends NodeBase {
  kind: 'CatchClause';
  param: Identifier | null;
  body: BlockStatement;
}

/** `defer f.close()` or `defer { ... }`. */
export interface DeferStatement extends NodeBase {
  kind: 'DeferStatement';
  body: CallExpression | BlockStatement;
}

/**
 * `mount() { ... }` at the top level of a component: runs once the component's markup is in the
 * document. It may return a function, which runs when `{if}`, `{switch}` or `{for}` removes the
 * markup.
 */
export interface MountStatement extends NodeBase {
  kind: 'MountStatement';
  body: BlockStatement;
}
