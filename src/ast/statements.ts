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
import type { CallExpression, Expression, Identifier, UnaryExpression } from './expressions.ts';
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
  | EffectStatement
  | StyleStatement
  | DeleteStatement
  | JsxElementStatement
  | SendStatement
  | SelectStatement;

/** Statements allowed in the `init` and `update` parts of a `for` header. */
export type SimpleStatement =
  | VariableDeclaration
  | ExpressionStatement
  | AssignmentStatement
  | IncDecStatement
  | DeleteStatement
  | SendStatement;

/** `ch <- value`: waits until the channel takes the value, so only in async functions. */
export interface SendStatement extends NodeBase {
  kind: 'SendStatement';
  channel: Expression;
  value: Expression;
}

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

/**
 * `select { case v = <-ch: ... case out <- v: ... default: ... }`: waits until one of the
 * operations on channels can go on, does it and runs its case; `default` runs when none can at
 * once.
 */
export interface SelectStatement extends NodeBase {
  kind: 'SelectStatement';
  cases: SelectCase[];
}

/** A case of `select`: a receive, `<-ch`, a send, `ch <- v`, or `default` when it is null. */
export interface SelectCase extends NodeBase {
  kind: 'SelectCase';
  /** `v` or `v, ok` in `case v, ok = <-ch:`: new variables of the case. */
  names: Identifier[];
  operation: UnaryExpression | SendStatement | null;
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

/**
 * `effect { ... }` at the top level of a component: runs once the markup is created, and again
 * whenever what it reads changes. Its `defer` runs before it runs again and when the component is
 * removed.
 */
export interface EffectStatement extends NodeBase {
  kind: 'EffectStatement';
  body: BlockStatement;
}

/**
 * `style { .card { padding: 8px; color: {accent} } }` at the top level of a component or a
 * decorator: CSS for its own markup. `parts` are the raw CSS text around the values from code,
 * which appear only in the values of declarations.
 */
export interface StyleStatement extends NodeBase {
  kind: 'StyleStatement';
  parts: (CssText | Expression)[];
}

/**
 * `delete scores[name]`: removes a key of an object used as a map (`{ [string]: T }`), or a field
 * of type `?T`.
 */
export interface DeleteStatement extends NodeBase {
  kind: 'DeleteStatement';
  target: Expression;
}

/** Raw CSS text of a `style` block, as written. */
export interface CssText extends NodeBase {
  kind: 'CssText';
  value: string;
}
