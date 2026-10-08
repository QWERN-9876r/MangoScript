import type {
  ClassMember,
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
  ForInStatement,
  ForStatement,
  IfStatement,
  SimpleStatement,
  Statement,
  SwitchCase,
  SwitchStatement,
} from './statements.ts';

// Markup, type annotations, and the union of all nodes.

// ─── Markup ──────────────────────────────────────────────────────────────────────────────────────

/** `<a href="/">Link {name}</a>`: creates a DOM element. `tag` is `null` for a fragment `<>...</>`. */
export interface ElementExpression extends NodeBase {
  kind: 'ElementExpression';
  /** The tag name as written: `div`, `my-widget`. */
  tag: Identifier | null;
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
  TypeReference | ArrayType | NullableType | FuncType | ObjectType | UnionType | LiteralType;

/** A named type: `number`, `User`, `Point`, `Box[number]`. */
export interface TypeReference extends NodeBase {
  kind: 'TypeReference';
  name: Identifier;
  /** Type arguments of a generic type: `[number]` in `Box[number]`. */
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
  | TypeParameter
  | ClassMember
  | TypeMember
  | SwitchCase
  | CatchClause
  | Property
  | SpreadElement
  | TemplateElement
  | JsxText
  | JsxExpressionContainer
  | JsxStatementContainer
  | JsxAttribute
  | JsxSpreadAttribute
  | EventHandler;

export type NodeKind = Node['kind'];
