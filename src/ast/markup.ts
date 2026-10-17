import type {
  ClassMember,
  DecoratorUse,
  ImportSpecifier,
  NodeBase,
  Parameter,
  Program,
  TypeParameter,
} from './declarations.ts';
import type {
  BooleanLiteral,
  Expression,
  Identifier,
  NumberLiteral,
  Property,
  SpreadElement,
  StringLiteral,
  TemplateElement,
} from './expressions.ts';
import type {
  CatchClause,
  CssText,
  ForInStatement,
  ForStatement,
  IfStatement,
  SimpleStatement,
  Statement,
  SelectCase,
  SwitchCase,
  SwitchStatement,
} from './statements.ts';

// Markup, type annotations, and the union of all nodes.

// ─── Markup ──────────────────────────────────────────────────────────────────────────────────────

/** `<a href="/">Link {name}</a>`: creates a DOM element. `tag` is `null` for a fragment `<>...</>`. */
export interface ElementExpression extends NodeBase {
  kind: 'ElementExpression';
  /** The tag name as written: `div`, `my-widget`, `section.content`. */
  tag: Identifier | null;
  /**
   * A tag with a dot takes its component from a value: `section.content` in
   * `<section.content />`. A capitalized tag, `<Page />`, does so when `Page` is a variable rather
   * than a component; that depends on the scope, so this is `null` for it unless the code was
   * copied from another module and the variable renamed.
   */
  value: Expression | null;
  attributes: (JsxAttribute | JsxSpreadAttribute)[];
  children: JsxChild[];
}

export type JsxChild = JsxText | JsxExpressionContainer | JsxStatementContainer | ElementExpression;

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
 * `{for todo in todos { <li>{todo.title}</li> }}`: control flow among the children. Its blocks
 * hold markup statements: elements, nested if/for/switch and `const` declarations.
 */
export interface JsxStatementContainer extends NodeBase {
  kind: 'JsxStatementContainer';
  statement: IfStatement | ForStatement | ForInStatement | SwitchStatement;
}

/** An element written as a statement inside markup control flow: it becomes content. */
export interface JsxElementStatement extends NodeBase {
  kind: 'JsxElementStatement';
  element: ElementExpression;
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

export type TypeNode =
  | TypeReference
  | ArrayType
  | NullableType
  | FuncType
  | ComponentType
  | ObjectType
  | UnionType
  | LiteralType
  | ChanType
  | QueueType;

/**
 * `chan number`: a channel of numbers, made by `chan<number>(size)`; `chan<- number` only sends
 * and `<-chan number` only receives.
 */
export interface ChanType extends NodeBase {
  kind: 'ChanType';
  element: TypeNode;
  direction: 'both' | 'send' | 'receive';
}

/** `queue number`: a queue of numbers, made by `queue<number>()`. */
export interface QueueType extends NodeBase {
  kind: 'QueueType';
  element: TypeNode;
}

/** A named type: `number`, `User`, `Point`, `Box<number>`. */
export interface TypeReference extends NodeBase {
  kind: 'TypeReference';
  name: Identifier;
  /** Type arguments of a generic type: `<number>` in `Box<number>`. */
  typeArgs: TypeNode[];
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
  /** `func(yield func(T) bool)`: its one parameter is named `yield`, so it is an iterator. */
  iterator?: boolean;
}

/** `comp(title string, kind ?Kind)`: a component as a value, used as a tag: `<section.content />`. */
export interface ComponentType extends NodeBase {
  kind: 'ComponentType';
  params: Parameter[];
}

/** `string | number`; a member may be in parentheses: `[](string | number)`. */
export interface UnionType extends NodeBase {
  kind: 'UnionType';
  types: TypeNode[];
}

/** `"all"`, `42` or `true` as a type: the only value of the type. */
export interface LiteralType extends NodeBase {
  kind: 'LiteralType';
  value: StringLiteral | NumberLiteral | BooleanLiteral;
}

/** `{ x, y number }` — an anonymous object type. */
export interface ObjectType extends NodeBase {
  kind: 'ObjectType';
  members: TypeMember[];
}

/** Members of interfaces and object types. */
export type TypeMember = PropertySignature | MethodSignature | IndexSignature;

/** `[string]: Shape`: the type of the fields an object has besides the ones listed. */
export interface IndexSignature extends NodeBase {
  kind: 'IndexSignature';
  /** `string` or `number`. */
  key: TypeNode;
  type: TypeNode;
}

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
  | DecoratorUse
  | TypeParameter
  | ClassMember
  | TypeMember
  | SwitchCase
  | SelectCase
  | CatchClause
  | Property
  | SpreadElement
  | TemplateElement
  | CssText
  | JsxText
  | JsxExpressionContainer
  | JsxStatementContainer
  | JsxAttribute
  | JsxSpreadAttribute
  | EventHandler;

export type NodeKind = Node['kind'];
