/**
 * Syntax tree produced by the parser. Every node has a `kind` that discriminates the unions below
 * and the `start`/`end` offsets of its source text.
 *
 * For example, `const q, err = divide(10, 2)` becomes:
 *
 *     VariableDeclaration {
 *       keyword: 'const', names: [Identifier q, Identifier err], type: null,
 *       values: [CallExpression { callee: Identifier divide, arguments: [NumberLiteral 10, NumberLiteral 2] }],
 *     }
 *
 * Grouped names such as `a, b number` in parameters, fields and interface members are expanded into
 * separate nodes that share the same type node.
 */

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
  members: TypeMember[];
}

/** `type ID string`, `type Handler func(string) bool`. */
export interface TypeAliasDeclaration extends NodeBase {
  kind: 'TypeAliasDeclaration';
  exported: boolean;
  name: Identifier;
  type: TypeNode;
}

// ─── Statements ──────────────────────────────────────────────────────────────────────────────────

export type Statement =
  | ImportDeclaration
  | FuncDeclaration
  | ComponentDeclaration
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
  | DeferStatement;

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

// ─── Markup ──────────────────────────────────────────────────────────────────────────────────────

/** `<a href="/">Ссылка {name}</a>`: creates a DOM element. `tag` is `null` for a fragment `<>...</>`. */
export interface ElementExpression extends NodeBase {
  kind: 'ElementExpression';
  /** The tag name as written: `div`, `my-widget`. */
  tag: Identifier | null;
  attributes: (JsxAttribute | JsxSpreadAttribute)[];
  children: JsxChild[];
}

export type JsxChild = JsxText | JsxExpressionContainer | ElementExpression;

/** Text between tags, with whitespace already cleaned up as in JSX. */
export interface JsxText extends NodeBase {
  kind: 'JsxText';
  value: string;
}

/** `{expression}` among the children. Empty ones (`{/* comment *\/}`) are left out. */
export interface JsxExpressionContainer extends NodeBase {
  kind: 'JsxExpressionContainer';
  expression: Expression;
}

/**
 * `href="/"`, `href={url}` or just `disabled` (then `value` is `null`). Attributes `on*` hold an
 * EventHandler, unless they are given a function (a name, `obj.method` or a function literal).
 */
export interface JsxAttribute extends NodeBase {
  kind: 'JsxAttribute';
  /** The attribute name as written: `class`, `data-id`, `onClick`. */
  name: Identifier;
  value: StringLiteral | Expression | EventHandler | null;
}

/** `{...attrs}` */
export interface JsxSpreadAttribute extends NodeBase {
  kind: 'JsxSpreadAttribute';
  argument: Expression;
}

/** `onClick={count++}`: statements that run when the event happens, with `event` available. */
export interface EventHandler extends NodeBase {
  kind: 'EventHandler';
  body: SimpleStatement[];
}

// ─── Types ───────────────────────────────────────────────────────────────────────────────────────

export type TypeNode = TypeReference | ArrayType | NullableType | FuncType | ObjectType;

/** A named type: `number`, `User`, `Point`. */
export interface TypeReference extends NodeBase {
  kind: 'TypeReference';
  name: Identifier;
}

/** `[]T` */
export interface ArrayType extends NodeBase {
  kind: 'ArrayType';
  element: TypeNode;
}

/** `?T` */
export interface NullableType extends NodeBase {
  kind: 'NullableType';
  type: TypeNode;
}

/** `func(number, number) bool` */
export interface FuncType extends NodeBase {
  kind: 'FuncType';
  params: TypeNode[];
  results: TypeNode[];
}

/** `{ x, y number }` — an anonymous object type. */
export interface ObjectType extends NodeBase {
  kind: 'ObjectType';
  members: TypeMember[];
}

/** Members of interfaces and object types. */
export type TypeMember = PropertySignature | MethodSignature;

/** `label ?string`. A field with a nullable type may be omitted in object literals. */
export interface PropertySignature extends NodeBase {
  kind: 'PropertySignature';
  name: Identifier;
  type: TypeNode;
}

/** `area() number` */
export interface MethodSignature extends NodeBase {
  kind: 'MethodSignature';
  name: Identifier;
  params: Parameter[];
  results: TypeNode[];
}

// ─── All nodes ───────────────────────────────────────────────────────────────────────────────────

export type Node =
  | Program
  | Statement
  | Expression
  | TypeNode
  | ImportSpecifier
  | Parameter
  | ClassMember
  | TypeMember
  | SwitchCase
  | CatchClause
  | Property
  | SpreadElement
  | TemplateElement
  | JsxText
  | JsxExpressionContainer
  | JsxAttribute
  | JsxSpreadAttribute
  | EventHandler;

export type NodeKind = Node['kind'];
