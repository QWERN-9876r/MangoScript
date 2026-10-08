import type { NodeBase, Parameter } from './declarations.ts';
import type { ElementExpression, TypeNode } from './markup.ts';
import type { BlockStatement } from './statements.ts';

// ─── Expressions ─────────────────────────────────────────────────────────────────────────────────

export type Expression =
  | Identifier
  | NumberLiteral
  | StringLiteral
  | TemplateLiteral
  | BooleanLiteral
  | NullLiteral
  | ThisExpression
  | SuperExpression
  | ArrayLiteral
  | ObjectLiteral
  | FuncExpression
  | ArrowFunction
  | UnaryExpression
  | BinaryExpression
  | ConditionalExpression
  | CallExpression
  | NewExpression
  | MemberExpression
  | IndexExpression
  | ElementExpression;

export interface Identifier extends NodeBase {
  kind: 'Identifier';
  name: string;
}

export interface NumberLiteral extends NodeBase {
  kind: 'NumberLiteral';
  value: number;
  /** Source text, e.g. `0xff` or `1_000`, so code generation can keep it as written. */
  raw: string;
}

export interface StringLiteral extends NodeBase {
  kind: 'StringLiteral';
  /** Contents with escapes resolved. */
  value: string;
  /** Source text including quotes. */
  raw: string;
}

/** `` `Hello, ${name}!` ``: `quasis` always has one element more than `expressions`. */
export interface TemplateLiteral extends NodeBase {
  kind: 'TemplateLiteral';
  quasis: TemplateElement[];
  expressions: Expression[];
}

/** A text part of a template literal, without the backticks and `${` / `}` around it. */
export interface TemplateElement extends NodeBase {
  kind: 'TemplateElement';
  /** Contents with escapes resolved. */
  value: string;
  /** Contents as written in the source. */
  raw: string;
}

export interface BooleanLiteral extends NodeBase {
  kind: 'BooleanLiteral';
  value: boolean;
}

export interface NullLiteral extends NodeBase {
  kind: 'NullLiteral';
}

export interface ThisExpression extends NodeBase {
  kind: 'ThisExpression';
}

/** `super` in `super(name)` and `super.greet()`. */
export interface SuperExpression extends NodeBase {
  kind: 'SuperExpression';
}

/** `[1, 2, ...rest]` */
export interface ArrayLiteral extends NodeBase {
  kind: 'ArrayLiteral';
  elements: (Expression | SpreadElement)[];
}

/** `{ name: "Ann", age, ...defaults }` */
export interface ObjectLiteral extends NodeBase {
  kind: 'ObjectLiteral';
  properties: (Property | SpreadElement)[];
}

/** `name: value`, `"content-type": value`, or shorthand `name` (then `value` is an Identifier). */
export interface Property extends NodeBase {
  kind: 'Property';
  key: Identifier | StringLiteral;
  value: Expression;
  shorthand: boolean;
}

/** `...xs` in array literals, object literals and call arguments. */
export interface SpreadElement extends NodeBase {
  kind: 'SpreadElement';
  argument: Expression;
}

/** `func(x number) number { return x * x }` */
export interface FuncExpression extends NodeBase {
  kind: 'FuncExpression';
  params: Parameter[];
  results: TypeNode[];
  body: BlockStatement;
}

/** `x => x * 2`, `(a, b number) => a + b`, `() => { ... }`. The result type is inferred. */
export interface ArrowFunction extends NodeBase {
  kind: 'ArrowFunction';
  params: Parameter[];
  body: BlockStatement | Expression;
}

export type UnaryOperator = '!' | '-' | '+' | '~' | 'typeof';

export interface UnaryExpression extends NodeBase {
  kind: 'UnaryExpression';
  operator: UnaryOperator;
  argument: Expression;
}

export type BinaryOperator =
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '**'
  | '=='
  | '!='
  | '<'
  | '>'
  | '<='
  | '>='
  | '&&'
  | '||'
  | '??'
  | '&'
  | '|'
  | '^'
  | '<<'
  | '>>'
  | '>>>'
  | 'instanceof';

export interface BinaryExpression extends NodeBase {
  kind: 'BinaryExpression';
  operator: BinaryOperator;
  left: Expression;
  right: Expression;
}

/** `cond ? a : b` */
export interface ConditionalExpression extends NodeBase {
  kind: 'ConditionalExpression';
  test: Expression;
  consequent: Expression;
  alternate: Expression;
}

/** `f(x)`, or `f?.(x)` when `optional`. */
export interface CallExpression extends NodeBase {
  kind: 'CallExpression';
  callee: Expression;
  arguments: (Expression | SpreadElement)[];
  optional: boolean;
}

/** `new User("Ann", 30)` */
export interface NewExpression extends NodeBase {
  kind: 'NewExpression';
  callee: Expression;
  arguments: (Expression | SpreadElement)[];
}

/** `a.b`, or `a?.b` when `optional`. The property may be a keyword, e.g. `xs.map`. */
export interface MemberExpression extends NodeBase {
  kind: 'MemberExpression';
  object: Expression;
  property: Identifier;
  optional: boolean;
}

/** `a[i]`, or `a?.[i]` when `optional`. */
export interface IndexExpression extends NodeBase {
  kind: 'IndexExpression';
  object: Expression;
  index: Expression;
  optional: boolean;
}
