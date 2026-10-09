import type * as ast from '../ast.ts';
import type { Diagnostic } from '../diagnostics.ts';
import { assignedNames } from '../walk.ts';
import { arrayMember } from './builtins.ts';
import {
  type CheckOptions,
  type BindingKind,
  type Binding,
  type ComponentInfo,
  type AliasEntry,
  Scope,
  type FunctionContext,
  type ClassContext,
  type Flow,
  globalScope,
} from './context.ts';
import { DOCUMENT_FRAGMENT, elementType, eventType, HTML_ELEMENT, NODE } from './dom.ts';
import {
  explainMismatch,
  isAssignable,
  LazyMap,
  memberNames,
  nonNull,
  property,
  typeToString,
  UNKNOWN,
  type ClassInfo,
  type FunctionType,
  type Member,
  type Type,
  type TypeParam,
} from './types.ts';

// The type checker is a chain of layers, one per area, like the code generator: base → declarations
// → classes → resolution → initializers → statements → control flow → functions → expressions →
// operators → markup → components → members → calls → Checker (checker.ts). The checking of
// statements, expressions and markup calls itself recursively, so methods of later layers that
// earlier ones call are declared here as abstract.
//
// This layer has the state of a check, diagnostics, scopes and names, and the DOM types.

export abstract class CheckerBase {
  // Implemented by later layers: the checking of statements, expressions and markup calls each other.

  protected abstract checkClassBodies(node: ast.ClassDeclaration, info: ClassInfo): void;

  protected abstract ensureClassResolved(info: ClassInfo): void;

  protected abstract resolveClass(node: ast.ClassDeclaration, info: ClassInfo): void;

  protected abstract inferredType(type: Type, node: ast.Expression): Type;

  protected abstract resolveAlias(entry: AliasEntry): Type;

  protected abstract resolveType(node: ast.TypeNode): Type;

  protected abstract resolveTypeName(
    name: ast.Identifier,
    typeArgs?: readonly ast.TypeNode[],
  ): Type;

  protected abstract checkStatement(node: ast.Statement): void;

  protected abstract checkFor(node: ast.ForStatement): void;

  protected abstract checkForIn(node: ast.ForInStatement): void;

  protected abstract checkIf(node: ast.IfStatement): void;

  protected abstract checkSwitch(node: ast.SwitchStatement): void;

  protected abstract checkTry(node: ast.TryStatement): void;

  protected abstract forget(target: ast.Expression): void;

  protected abstract narrowableBinding(node: ast.Expression): Binding | undefined;

  protected abstract checkFunction(
    params: readonly ast.Parameter[],
    type: FunctionType,
    results: Type[] | null,
    body: ast.BlockStatement | ast.Expression,
    options?: {
      isConstructor?: boolean;
      isComponent?: boolean;
      closure?: boolean;
      paramKind?: BindingKind;
    },
  ): Type[];

  protected abstract checkExpression(node: ast.Expression, expected: Type | null): Type;

  protected abstract checkValue(node: ast.Expression, expected?: Type | null): Type;

  protected abstract binaryResult(
    operator: ast.BinaryOperator,
    givenLeft: Type,
    givenRight: Type,
    node: ast.NodeBase,
  ): Type;

  protected abstract checkBinary(node: ast.BinaryExpression, expected: Type | null): Type;

  protected abstract checkConditional(node: ast.ConditionalExpression, expected: Type | null): Type;

  protected abstract checkUnary(node: ast.UnaryExpression): Type;

  protected abstract checkElement(node: ast.ElementExpression): Type;

  protected abstract checkComponentBody(info: ComponentInfo): void;

  protected abstract checkComponentUse(node: ast.ElementExpression, tag: ast.Identifier): Type;

  protected abstract resolveProps(info: ComponentInfo): void;

  protected abstract webComponentProperty(tag: string, attribute: string): Type | null;

  protected abstract checkProp(attribute: ast.JsxAttribute, type: Type, component: string): void;

  protected abstract checkChain(
    node: ast.MemberExpression | ast.IndexExpression | ast.CallExpression,
    expected?: Type | null,
  ): [Type, boolean];

  protected abstract expectIndex(node: ast.Expression): void;

  protected abstract findMember(
    object: Type,
    name: string,
    node: ast.NodeBase,
  ): Member | 'any' | undefined;

  protected abstract keyedIndex(object: Type, index: ast.Expression): Type | null;

  protected abstract nonNullValue(node: ast.Expression): Type;

  protected abstract checkCall(
    node: ast.CallExpression,
    callee: Type,
    expected?: Type | null,
  ): Type;

  protected abstract checkNew(node: ast.NewExpression, expected?: Type | null): Type;

  protected abstract checkSuperCall(node: ast.CallExpression): Type;

  protected readonly program: ast.Program;

  protected readonly options: CheckOptions;

  protected readonly diagnostics: Diagnostic[] = [];

  protected readonly moduleScope: Scope;

  protected scope: Scope;

  protected flow: Flow = new Map();

  protected fn: FunctionContext | null = null;

  protected cls: ClassContext | null = null;

  /**
   * Type parameters of the call whose arguments are being checked: they are not known yet. Other
   * type parameters, like `T` in the body of `func first[T any]`, are types like any other.
   */
  protected inferring: ReadonlySet<TypeParam> = new Set();

  /** Names assigned somewhere in the module: their narrowing does not carry into closures. */
  protected readonly assigned: Set<string>;

  /** Classes whose members are not resolved yet, with the code that resolves them. */
  protected readonly unresolvedClasses = new Map<ClassInfo, () => void>();

  protected readonly resolvingClasses = new Set<ClassInfo>();

  /** The component whose body is being checked, if any. */
  protected component: ComponentInfo | null = null;

  protected readonly globals: Scope;

  protected domTypes: { node: Type; element: Type; fragment: Type } | null = null;

  constructor(program: ast.Program, options: CheckOptions) {
    this.program = program;
    this.options = options;
    this.globals = globalScope(options.library);
    this.moduleScope = new Scope(this.globals);
    this.scope = this.moduleScope;
    this.assigned = assignedNames(program);
  }

  protected error(message: string, node: ast.NodeBase): void {
    if (this.diagnostics.some((d) => d.start === node.start)) return;
    this.diagnostics.push({ message, start: node.start, end: node.end });
  }

  protected expectAssignable(source: Type, target: Type, node: ast.NodeBase, context = ''): void {
    if (isAssignable(source, target)) return;
    let message = `cannot use ${typeToString(source)} as ${typeToString(target)}${context}`;
    const reason = explainMismatch(nonNull(source), nonNull(target));
    if (source.kind === 'nullable' && isAssignable(nonNull(source), target)) {
      message += ': it may be null, check it first';
    } else if (reason !== null) {
      message += `: ${reason}`;
    }
    this.error(message, node);
  }

  protected nullError(node: ast.Expression): void {
    const name = node.kind === 'Identifier' ? node.name : null;
    this.error(
      name !== null
        ? `"${name}" may be null: check it with "if ${name} != null" or use "?."`
        : 'this value may be null: check it for null or use "?."',
      node,
    );
  }

  protected withScope<T>(check: () => T): T {
    const saved = this.scope;
    this.scope = new Scope(saved);
    try {
      return check();
    } finally {
      this.scope = saved;
    }
  }

  protected withClass<T>(context: ClassContext | null, check: () => T): T {
    const saved = this.cls;
    this.cls = context;
    try {
      return check();
    } finally {
      this.cls = saved;
    }
  }

  protected lookupValue(name: string): Binding | undefined {
    for (let scope: Scope | null = this.scope; scope; scope = scope.parent) {
      const binding = scope.values.get(name);
      if (binding) return binding;
    }
    const type = this.options.library?.value(name);
    if (type === undefined) return undefined;
    const binding: Binding = { name, kind: 'builtin', type };
    this.globals.values.set(name, binding);
    return binding;
  }

  protected lookupType(name: string): Type | AliasEntry | undefined {
    for (let scope: Scope | null = this.scope; scope; scope = scope.parent) {
      const entry = scope.types.get(name);
      if (entry) return entry;
    }
    const type = this.options.library?.type(name);
    if (type !== undefined) this.globals.types.set(name, type);
    return type;
  }

  /**
   * Node, HTMLElement and DocumentFragment: from the library when there is one. Found on first
   * use, after the imports, which may change the library.
   */
  protected get dom(): { node: Type; element: Type; fragment: Type } {
    if (!this.domTypes) {
      const { library } = this.options;
      this.domTypes = {
        node: library?.type('Node') ?? NODE,
        element: library?.type('HTMLElement') ?? HTML_ELEMENT,
        fragment: library?.type('DocumentFragment') ?? DOCUMENT_FRAGMENT,
      };
    }
    return this.domTypes;
  }

  /** The type of the element `<tag>` creates. */
  protected elementOf(tag: string): Type {
    return this.options.library?.element(tag) ?? elementType(tag);
  }

  /** The `event` of an `on*` attribute: its `currentTarget` is the element. */
  protected eventOf(attribute: string, element: Type): Type {
    const { library } = this.options;
    if (!library) return eventType(element);
    const event = library.event(attribute.slice(2).toLowerCase()) ?? library.type('Event');
    if (event?.kind !== 'object') return eventType(element);
    const members = new LazyMap<Member>(
      () => memberNames(event.members),
      (name) => (name === 'currentTarget' ? property(element) : event.members.get(name)),
    );
    return { ...event, members };
  }

  /** A member of a string, number or bool that the built-in types do not list. */
  protected primitiveMember(kind: 'string' | 'number' | 'bool', name: string): Member | undefined {
    const type = this.options.library?.primitive(kind);
    return type?.kind === 'object' ? type.members.get(name) : undefined;
  }

  protected arrayMemberOf(element: Type, name: string): Member | undefined {
    const builtin = arrayMember(element, name);
    if (builtin) return builtin;
    const type = this.options.library?.array(element);
    return type?.kind === 'object' ? type.members.get(name) : undefined;
  }

  protected declareValue(id: ast.Identifier, kind: BindingKind, type: Type | null): Binding {
    const binding: Binding = { name: id.name, kind, type };
    if (id.name === '_') return binding;
    if (this.scope.values.has(id.name)) {
      this.error(`"${id.name}" is already declared in this scope`, id);
    }
    this.scope.values.set(id.name, binding);
    return binding;
  }

  protected declareType(id: ast.Identifier, entry: Type | AliasEntry): void {
    if (this.scope.types.has(id.name)) this.error(`type "${id.name}" is already declared`, id);
    this.scope.types.set(id.name, entry);
  }

  /**
   * Remembers the types of checked expressions that may narrow a variable, e.g.
   * `let u ?User = new User()` makes `u` non-null until it is assigned again.
   */
  protected readonly checkedTypes = new WeakMap<ast.Expression, Type>();

  protected typeOfChecked(node: ast.Expression): Type {
    return this.checkedTypes.get(node) ?? UNKNOWN;
  }
}
