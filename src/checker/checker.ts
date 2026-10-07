import type * as ast from '../ast.ts';
import type { Diagnostic } from '../diagnostics.ts';
import { endlessRecursion, recursiveComponents } from '../recursion.ts';
import { assignedNames, containsBreak, forEachChild } from '../walk.ts';
import {
  arrayMember,
  boolMember,
  GLOBAL_TYPES,
  GLOBAL_VALUES,
  numberMember,
  stringMember,
} from './builtins.ts';
import {
  CONTENT,
  DOCUMENT_FRAGMENT,
  domProperty,
  elementType,
  eventType,
  HTML_ELEMENT,
  NODE,
} from './dom.ts';
import {
  ANY,
  arrayOf,
  BOOL,
  commonType,
  constructorOf,
  containsTypeParam,
  createClass,
  explainMismatch,
  findClassMember,
  func,
  hasUntypedBase,
  hasZeroValue,
  inferTypeParams,
  instanceMembers,
  isAssignable,
  isComparable,
  isNullable,
  isSubclass,
  literal,
  literalBase,
  NEVER,
  nonNull,
  NULL,
  nullable,
  NUMBER,
  spreadFields,
  STRING,
  substitute,
  typesEqual,
  typeToString,
  union,
  unionMembers,
  UNKNOWN,
  widenLiterals,
  VOID,
  type ClassInfo,
  type FunctionType,
  type Member,
  type ObjectType,
  type Type,
  type TypeParam,
} from './types.ts';

export interface ModuleExports {
  values: Map<string, Type>;
  types: Map<string, Type>;
}

/** What `importModule` found: the module's exports, an error for the import, or nothing (untyped). */
export type ImportResult = { exports: ModuleExports } | { error: string } | undefined;

export interface CheckOptions {
  /** Called for imports of `.mango` modules; without it, every import is untyped (`any`). */
  importModule?: (specifier: string) => ImportResult;
}

export interface CheckResult {
  diagnostics: Diagnostic[];
  exports: ModuleExports;
  /** Types of checked expressions, for code generation (e.g. how to insert element children). */
  types: WeakMap<ast.Expression, Type>;
}

export function check(program: ast.Program, options: CheckOptions = {}): CheckResult {
  return new Checker(program, options).run();
}

type BindingKind =
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

interface Binding {
  name: string;
  kind: BindingKind;
  /** `null` while a variable is declared but its declaration has not been checked yet. */
  type: Type | null;
  /** For components, which exist only at compile time and are used as tags. */
  component?: ComponentInfo;
}

interface ComponentInfo {
  node: ast.ComponentDeclaration;
  /** Properties by name; optional ones have a default value or a nullable type. */
  props: Map<string, { type: Type; optional: boolean }>;
  /** Names from the module that the component's code uses, computed when first needed. */
  freeNames: Set<string> | null;
  /** Uses itself, directly or through other components: compiled to a function, not inlined. */
  recursive: boolean;
}

/** A `type` alias, resolved when first used. */
interface AliasEntry {
  kind: 'alias';
  node: ast.TypeAliasDeclaration;
  scope: Scope;
  resolved: Type | null;
  resolving: boolean;
}

class Scope {
  readonly parent: Scope | null;
  readonly values = new Map<string, Binding>();
  readonly types = new Map<string, Type | AliasEntry>();

  constructor(parent: Scope | null) {
    this.parent = parent;
  }
}

interface FunctionContext {
  /** Declared result types, or `null` when they are inferred from the `return` statements. */
  results: Type[] | null;
  /** Types of the `return` statements, for inferring the results. */
  returns: Type[][];
  isConstructor: boolean;
  /** The body of a component: every `return` gives markup. */
  isComponent?: boolean;
}

interface ClassContext {
  info: ClassInfo;
  isStatic: boolean;
}

/**
 * Types of variables narrowed by the code before the current point, e.g. `?User` → `User`
 * after `if user == null { return }`.
 */
type Flow = Map<Binding, Type>;
type Narrowing = [Binding, Type][];

const NARROWABLE: ReadonlySet<BindingKind> = new Set([
  'let',
  'const',
  'state',
  'param',
  'prop',
  'catch',
  'loop',
]);

function globalScope(): Scope {
  const scope = new Scope(null);
  for (const [name, type] of GLOBAL_VALUES) scope.values.set(name, { name, kind: 'builtin', type });
  for (const [name, type] of GLOBAL_TYPES) scope.types.set(name, type);
  return scope;
}

class Checker {
  private readonly program: ast.Program;
  private readonly options: CheckOptions;
  private readonly diagnostics: Diagnostic[] = [];
  private readonly moduleScope: Scope;
  private scope: Scope;
  private flow: Flow = new Map();
  private fn: FunctionContext | null = null;
  private cls: ClassContext | null = null;
  /** Names assigned somewhere in the module: their narrowing does not carry into closures. */
  private readonly assigned: Set<string>;
  /** Classes whose members are not resolved yet, with the code that resolves them. */
  private readonly unresolvedClasses = new Map<ClassInfo, () => void>();
  private readonly resolvingClasses = new Set<ClassInfo>();
  /** The component whose body is being checked, if any. */
  private component: ComponentInfo | null = null;

  constructor(program: ast.Program, options: CheckOptions) {
    this.program = program;
    this.options = options;
    this.moduleScope = new Scope(globalScope());
    this.scope = this.moduleScope;
    this.assigned = assignedNames(program);
  }

  run(): CheckResult {
    this.checkStatementList(this.program.body, true);
    this.checkEndlessRecursion();
    this.diagnostics.sort((a, b) => a.start - b.start);
    return {
      diagnostics: this.diagnostics,
      exports: this.collectExports(),
      types: this.checkedTypes,
    };
  }

  // ─── Diagnostics ───────────────────────────────────────────────────────────────────────────────

  private error(message: string, node: ast.NodeBase): void {
    if (this.diagnostics.some((d) => d.start === node.start)) return;
    this.diagnostics.push({ message, start: node.start, end: node.end });
  }

  private expectAssignable(source: Type, target: Type, node: ast.NodeBase, context = ''): void {
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

  private nullError(node: ast.Expression): void {
    const name = node.kind === 'Identifier' ? node.name : null;
    this.error(
      name !== null
        ? `"${name}" may be null: check it with "if ${name} != null" or use "?."`
        : 'this value may be null: check it for null or use "?."',
      node,
    );
  }

  // ─── Scopes ────────────────────────────────────────────────────────────────────────────────────

  private withScope<T>(check: () => T): T {
    const saved = this.scope;
    this.scope = new Scope(saved);
    try {
      return check();
    } finally {
      this.scope = saved;
    }
  }

  private withClass<T>(context: ClassContext | null, check: () => T): T {
    const saved = this.cls;
    this.cls = context;
    try {
      return check();
    } finally {
      this.cls = saved;
    }
  }

  private lookupValue(name: string): Binding | undefined {
    for (let scope: Scope | null = this.scope; scope; scope = scope.parent) {
      const binding = scope.values.get(name);
      if (binding) return binding;
    }
    return undefined;
  }

  private lookupType(name: string): Type | AliasEntry | undefined {
    for (let scope: Scope | null = this.scope; scope; scope = scope.parent) {
      const entry = scope.types.get(name);
      if (entry) return entry;
    }
    return undefined;
  }

  private declareValue(id: ast.Identifier, kind: BindingKind, type: Type | null): Binding {
    const binding: Binding = { name: id.name, kind, type };
    if (id.name === '_') return binding;
    if (this.scope.values.has(id.name)) {
      this.error(`"${id.name}" is already declared in this scope`, id);
    }
    this.scope.values.set(id.name, binding);
    return binding;
  }

  private declareType(id: ast.Identifier, entry: Type | AliasEntry): void {
    if (this.scope.types.has(id.name)) this.error(`type "${id.name}" is already declared`, id);
    this.scope.types.set(id.name, entry);
  }

  // ─── Declarations ──────────────────────────────────────────────────────────────────────────────

  /**
   * Declares the names of a statement list first (so functions, classes and types can be used
   * before their declaration), then checks the statements in order. Function and method bodies are
   * checked last, when every name of the list is known.
   */
  private checkStatementList(statements: readonly ast.Statement[], topLevel: boolean): void {
    const bodies = this.declareStatements(statements, topLevel);
    for (const statement of statements) this.checkStatement(statement);
    for (const checkBody of bodies) checkBody();
  }

  private declareStatements(
    statements: readonly ast.Statement[],
    topLevel: boolean,
  ): (() => void)[] {
    const classes: [ast.ClassDeclaration, ClassInfo][] = [];
    const interfaces: [ast.InterfaceDeclaration, ObjectType][] = [];
    const functions: [ast.FuncDeclaration, Binding][] = [];
    const components: ComponentInfo[] = [];

    for (const statement of statements) {
      switch (statement.kind) {
        case 'ImportDeclaration':
          this.declareImport(statement);
          break;
        case 'ClassDeclaration': {
          const info = createClass(statement.name.name);
          this.declareType(statement.name, info.instance);
          this.declareValue(statement.name, 'class', info.value);
          classes.push([statement, info]);
          break;
        }
        case 'InterfaceDeclaration': {
          const object: ObjectType = {
            kind: 'object',
            name: statement.name.name,
            members: new Map(),
            call: null,
          };
          this.declareType(statement.name, object);
          interfaces.push([statement, object]);
          break;
        }
        case 'TypeAliasDeclaration':
          this.declareType(statement.name, {
            kind: 'alias',
            node: statement,
            scope: this.scope,
            resolved: null,
            resolving: false,
          });
          break;
        case 'FuncDeclaration':
          functions.push([statement, this.declareValue(statement.name, 'function', null)]);
          break;
        case 'ComponentDeclaration': {
          const info: ComponentInfo = {
            node: statement,
            props: new Map(),
            freeNames: null,
            recursive: false,
          };
          this.declareValue(statement.name, 'component', UNKNOWN).component = info;
          components.push(info);
          if (statement.exported) {
            this.error('exporting components is not supported yet', statement.name);
          }
          break;
        }
        case 'VariableDeclaration':
          // Top-level variables can be used in functions declared before them.
          if (topLevel) {
            for (const name of statement.names) this.declareValue(name, statement.keyword, null);
          }
          break;
        default:
          break;
      }
    }

    for (const [node, object] of interfaces) this.fillMembers(object, node.members);
    for (const statement of statements) {
      if (statement.kind === 'TypeAliasDeclaration') this.resolveTypeName(statement.name);
    }
    for (const [node, binding] of functions) {
      binding.type = this.signature(node.params, node.results);
    }
    for (const info of components) this.resolveProps(info);
    const recursive = recursiveComponents(
      new Map(components.map((info) => [info.node.name.name, info.node])),
    );
    for (const info of components) info.recursive = recursive.has(info.node);
    for (const [node, info] of classes) {
      this.unresolvedClasses.set(info, () => this.resolveClass(node, info));
    }
    for (const [, info] of classes) this.ensureClassResolved(info);

    const bodies: (() => void)[] = [];
    for (const [node, binding] of functions) {
      const type = binding.type as FunctionType;
      // A nested `func` declaration is a JS `function`: it has no `this` of its own class.
      bodies.push(() =>
        this.withClass(null, () => this.checkFunction(node.params, type, type.results, node.body)),
      );
    }
    for (const [node, info] of classes) bodies.push(() => this.checkClassBodies(node, info));
    for (const info of components) bodies.push(() => this.checkComponentBody(info));
    return bodies;
  }

  private declareImport(node: ast.ImportDeclaration): void {
    const specifier = node.source.value;
    const isMango = specifier.endsWith('.mango');
    const result = isMango ? this.options.importModule?.(specifier) : undefined;
    if (result && 'error' in result) this.error(result.error, node.source);
    const exports = result && 'exports' in result ? result.exports : null;

    if (node.defaultImport) {
      if (exports) {
        this.error(
          'MangoScript modules have no default export: use import { ... }',
          node.defaultImport,
        );
      }
      this.declareValue(node.defaultImport, 'import', exports ? UNKNOWN : ANY);
      this.scope.types.set(node.defaultImport.name, ANY);
    }
    if (node.namespaceImport) {
      const members = new Map<string, Member>();
      for (const [name, type] of exports?.values ?? []) {
        members.set(name, { type, method: false, visibility: 'public', owner: null });
      }
      const type: Type = exports ? { kind: 'object', name: specifier, members, call: null } : ANY;
      this.declareValue(node.namespaceImport, 'import', type);
    }
    for (const specifierNode of node.namedImports) {
      const name = specifierNode.imported.name;
      if (!exports) {
        this.declareValue(specifierNode.local, 'import', ANY);
        this.scope.types.set(specifierNode.local.name, ANY);
        continue;
      }
      const value = exports.values.get(name);
      const type = exports.types.get(name);
      if (value === undefined && type === undefined) {
        this.error(`"${name}" is not exported by "${specifier}"`, specifierNode.imported);
      }
      if (value !== undefined) this.declareValue(specifierNode.local, 'import', value);
      if (type !== undefined) this.declareType(specifierNode.local, type);
    }
  }

  /** Members of an interface or object type: `name string; area() number`. */
  private fillMembers(object: ObjectType, members: readonly ast.TypeMember[]): void {
    for (const member of members) {
      if (object.members.has(member.name.name)) {
        this.error(`duplicate member "${member.name.name}"`, member.name);
      }
      object.members.set(member.name.name, {
        type:
          member.kind === 'PropertySignature'
            ? this.resolveType(member.type)
            : this.signature(member.params, member.results),
        method: member.kind === 'MethodSignature',
        visibility: 'public',
        owner: null,
      });
    }
  }

  private signature(
    params: readonly ast.Parameter[],
    results: readonly ast.TypeNode[],
  ): FunctionType {
    return func(
      params.map((param) => (param.type ? this.resolveType(param.type) : UNKNOWN)),
      results.map((result) => this.resolveType(result)),
    );
  }

  private ensureClassResolved(info: ClassInfo): void {
    const resolve = this.unresolvedClasses.get(info);
    if (!resolve || this.resolvingClasses.has(info)) return;
    this.resolvingClasses.add(info);
    try {
      resolve();
    } finally {
      this.resolvingClasses.delete(info);
      this.unresolvedClasses.delete(info);
    }
  }

  /** Resolves the base class and the types of all members (but does not check method bodies). */
  private resolveClass(node: ast.ClassDeclaration, info: ClassInfo): void {
    if (node.superClass) {
      const base = this.checkValue(node.superClass);
      if (base.kind === 'classValue') {
        this.ensureClassResolved(base.info);
        if (this.resolvingClasses.has(base.info) || isSubclass(base.info, info)) {
          this.error(`class "${info.name}" cannot extend itself`, node.superClass);
        } else {
          info.superClass = base.info;
        }
      } else if (base.kind === 'any') {
        info.untypedBase = true;
      } else if (base.kind !== 'unknown') {
        this.error(`cannot extend ${typeToString(base)}: it is not a class`, node.superClass);
      }
    }

    for (const member of node.members) {
      switch (member.kind) {
        case 'FieldDeclaration': {
          const declared = member.type ? this.resolveType(member.type) : null;
          let type = declared ?? UNKNOWN;
          const { value } = member;
          if (value) {
            const valueType = this.withClass({ info, isStatic: member.isStatic }, () =>
              this.checkValue(value, declared),
            );
            if (declared) this.expectAssignable(valueType, declared, value);
            else type = this.inferredType(valueType, value);
          }
          this.declareMember(info, member.isStatic, member.name, {
            type,
            method: false,
            visibility: member.visibility,
            owner: info,
          });
          break;
        }
        case 'MethodDeclaration':
          this.declareMember(info, member.isStatic, member.name, {
            type: this.signature(member.params, member.results),
            method: true,
            visibility: member.visibility,
            owner: info,
          });
          break;
        case 'ConstructorDeclaration':
          if (info.ctor) this.error('a class can have only one constructor', member);
          info.ctor = this.signature(member.params, []);
          info.ctorVisibility = member.visibility;
          break;
      }
    }
  }

  private declareMember(
    info: ClassInfo,
    isStatic: boolean,
    name: ast.Identifier,
    member: Member,
  ): void {
    const members = isStatic ? info.statics : info.members;
    if (members.has(name.name)) this.error(`duplicate member "${name.name}"`, name);
    members.set(name.name, member);
  }

  /** Method bodies and the checks that need every member of the class. */
  private checkClassBodies(node: ast.ClassDeclaration, info: ClassInfo): void {
    let constructorNode: ast.ConstructorDeclaration | null = null;
    for (const member of node.members) {
      if (member.kind === 'MethodDeclaration') {
        const type = (member.isStatic ? info.statics : info.members).get(member.name.name)?.type;
        if (type?.kind !== 'function') continue;
        this.withClass({ info, isStatic: member.isStatic }, () =>
          this.checkFunction(member.params, type, type.results, member.body),
        );
        this.checkOverride(info, member);
      } else if (member.kind === 'ConstructorDeclaration' && info.ctor) {
        constructorNode = member;
        const type = info.ctor;
        this.withClass({ info, isStatic: false }, () =>
          this.checkFunction(member.params, type, [], member.body, { isConstructor: true }),
        );
        const derived = info.superClass !== null || info.untypedBase;
        if (derived && !member.body.body.some(isSuperCall)) {
          this.error('the constructor of a derived class must call super(...)', member);
        }
      }
    }

    // Fields without a zero value must get one at once or in the constructor.
    for (const member of node.members) {
      if (member.kind !== 'FieldDeclaration' || member.isStatic || member.value) continue;
      const type = info.members.get(member.name.name)?.type;
      if (!type || hasZeroValue(type)) continue;
      if (constructorNode && assignsField(constructorNode.body, member.name.name)) continue;
      this.error(
        `field "${member.name.name}" needs a value: ${typeToString(type)} has no zero value, ` +
          'so initialize it here or assign it in the constructor',
        member.name,
      );
    }

    for (const reference of node.implements) {
      const target = this.resolveTypeName(reference.name);
      if (target.kind === 'unknown') continue;
      if (target.kind !== 'object' && target.kind !== 'class') {
        this.error(`cannot implement ${typeToString(target)}: it is not an interface`, reference);
      } else if (!isAssignable(info.instance, target)) {
        const reason = explainMismatch(info.instance, target);
        this.error(
          `class "${info.name}" does not implement ${typeToString(target)}${reason ? `: ${reason}` : ''}`,
          reference,
        );
      }
    }
  }

  private checkOverride(info: ClassInfo, method: ast.MethodDeclaration): void {
    if (!info.superClass) return;
    const base = findClassMember(info.superClass, method.name.name, method.isStatic);
    const own = (method.isStatic ? info.statics : info.members).get(method.name.name);
    if (!base || !own || isAssignable(own.type, base.type)) return;
    this.error(
      `"${method.name.name}" overrides ${base.owner?.name ?? info.superClass.name}.${method.name.name} ` +
        `with an incompatible type: ${typeToString(own.type)} instead of ${typeToString(base.type)}`,
      method.name,
    );
  }

  private collectExports(): ModuleExports {
    const values = new Map<string, Type>();
    const types = new Map<string, Type>();
    const valueOf = (name: string) => this.moduleScope.values.get(name)?.type ?? UNKNOWN;
    const typeOf = (name: string) => {
      const entry = this.moduleScope.types.get(name);
      if (!entry) return UNKNOWN;
      return entry.kind === 'alias' ? this.resolveAlias(entry) : entry;
    };
    for (const statement of this.program.body) {
      switch (statement.kind) {
        case 'FuncDeclaration':
          if (statement.exported) values.set(statement.name.name, valueOf(statement.name.name));
          break;
        case 'VariableDeclaration':
          if (statement.exported) {
            for (const name of statement.names) values.set(name.name, valueOf(name.name));
          }
          break;
        case 'ClassDeclaration':
          if (statement.exported) {
            values.set(statement.name.name, valueOf(statement.name.name));
            types.set(statement.name.name, typeOf(statement.name.name));
          }
          break;
        case 'InterfaceDeclaration':
        case 'TypeAliasDeclaration':
          if (statement.exported) types.set(statement.name.name, typeOf(statement.name.name));
          break;
        default:
          break;
      }
    }
    return { values, types };
  }

  // ─── Types ─────────────────────────────────────────────────────────────────────────────────────

  private resolveType(node: ast.TypeNode): Type {
    switch (node.kind) {
      case 'TypeReference':
        return this.resolveTypeName(node.name);
      case 'ArrayType':
        return arrayOf(this.resolveType(node.element));
      case 'NullableType':
        return nullable(this.resolveType(node.type));
      case 'FuncType':
        return func(
          node.params.map((param) => this.resolveType(param)),
          node.results.map((result) => this.resolveType(result)),
        );
      case 'ObjectType': {
        const object: ObjectType = { kind: 'object', name: null, members: new Map(), call: null };
        this.fillMembers(object, node.members);
        return object;
      }
      case 'UnionType':
        return union(node.types.map((type) => this.resolveType(type)));
      case 'LiteralType':
        return literal(node.value.value);
    }
  }

  private resolveTypeName(name: ast.Identifier): Type {
    const entry = this.lookupType(name.name);
    if (entry === undefined) {
      this.error(
        this.lookupValue(name.name)
          ? `"${name.name}" is a value, not a type`
          : `unknown type "${name.name}"`,
        name,
      );
      return UNKNOWN;
    }
    return entry.kind === 'alias' ? this.resolveAlias(entry) : entry;
  }

  private resolveAlias(entry: AliasEntry): Type {
    if (entry.resolved) return entry.resolved;
    const { node } = entry;
    if (entry.resolving) {
      this.error(`type "${node.name.name}" refers to itself`, node.name);
      return UNKNOWN;
    }
    const saved = this.scope;
    this.scope = entry.scope;
    try {
      if (node.type.kind === 'ObjectType') {
        // Registered before its members, so that they can refer to the type itself.
        const object: ObjectType = {
          kind: 'object',
          name: node.name.name,
          members: new Map(),
          call: null,
        };
        entry.resolved = object;
        this.fillMembers(object, node.type.members);
        return object;
      }
      entry.resolving = true;
      const resolved = this.resolveType(node.type);
      // A union keeps the alias name for messages: `cannot use "activ" as Filter`.
      entry.resolved = resolved.kind === 'union' ? { ...resolved, name: node.name.name } : resolved;
      return entry.resolved;
    } finally {
      entry.resolving = false;
      this.scope = saved;
    }
  }

  /** The type of a variable initialized with a value of type `type`. */
  private inferredType(type: Type, node: ast.Expression): Type {
    if (type.kind === 'null') {
      this.error('cannot infer a type from null: declare it, e.g. "let x ?User = null"', node);
      return UNKNOWN;
    }
    if (type.kind === 'array' && type.element.kind === 'never') {
      this.error(
        'cannot infer the type of an empty array: declare it, e.g. "let xs []number"',
        node,
      );
      return UNKNOWN;
    }
    return type;
  }

  // ─── Statements ────────────────────────────────────────────────────────────────────────────────

  private checkStatement(node: ast.Statement): void {
    switch (node.kind) {
      case 'VariableDeclaration':
        this.checkVariableDeclaration(node);
        break;
      case 'BlockStatement':
        this.checkBlock(node.body);
        break;
      case 'ExpressionStatement':
        this.checkExpression(node.expression, null);
        break;
      case 'JsxElementStatement':
        this.checkExpression(node.element, null);
        break;
      case 'AssignmentStatement':
        this.checkAssignment(node);
        break;
      case 'IncDecStatement': {
        const type = this.checkTarget(node.target);
        if (!isNumeric(type)) {
          this.error(`"${node.operator}" needs a number, not ${typeToString(type)}`, node.target);
        }
        this.forget(node.target);
        break;
      }
      case 'ReturnStatement':
        this.checkReturn(node);
        break;
      case 'IfStatement':
        this.checkIf(node);
        break;
      case 'ForStatement':
        this.checkFor(node);
        break;
      case 'ForInStatement':
        this.checkForIn(node);
        break;
      case 'SwitchStatement':
        this.checkSwitch(node);
        break;
      case 'ThrowStatement':
        this.checkValue(node.argument);
        break;
      case 'TryStatement':
        this.checkTry(node);
        break;
      case 'DeferStatement':
        if (node.body.kind === 'BlockStatement') this.checkBlock(node.body.body);
        else this.checkExpression(node.body, null);
        break;
      case 'ImportDeclaration':
      case 'FuncDeclaration':
      case 'ComponentDeclaration':
      case 'ClassDeclaration':
      case 'InterfaceDeclaration':
      case 'TypeAliasDeclaration':
      case 'BreakStatement':
      case 'ContinueStatement':
        // Declarations are handled by declareStatements(); jumps were checked by the parser.
        break;
    }
  }

  private checkBlock(statements: readonly ast.Statement[]): void {
    this.withScope(() => this.checkStatementList(statements, false));
  }

  private checkVariableDeclaration(node: ast.VariableDeclaration): void {
    const declared = node.type ? this.resolveType(node.type) : null;
    const { names, values } = node;
    let types: Type[];

    if (values.length === 0) {
      if (declared && !hasZeroValue(declared) && declared.kind !== 'unknown') {
        const type = typeToString(declared);
        this.error(
          `${type} has no zero value: give "${names[0]!.name}" a value or make it nullable with ${typeToString(nullable(declared))}`,
          node.type ?? node,
        );
      }
      types = names.map(() => declared ?? UNKNOWN);
    } else if (values.length === names.length) {
      types = values.map((value) => {
        const type = this.checkValue(value, declared);
        if (!declared) return this.inferredType(type, value);
        this.expectAssignable(type, declared, value);
        return declared;
      });
    } else {
      types = this.unpack(values[0]!, names.length, declared);
    }

    names.forEach((name, i) => {
      if (name.name === '_') return;
      const type = types[i] ?? UNKNOWN;
      // Top-level variables were declared in advance by declareStatements().
      const existing = this.scope.values.get(name.name);
      const binding =
        existing && existing.type === null && existing.kind === node.keyword
          ? existing
          : this.declareValue(name, node.keyword, null);
      binding.type = type;
      const value = values.length === names.length ? values[i] : undefined;
      if (value && isNullable(type) && !isNullable(this.typeOfChecked(value))) {
        this.flow.set(binding, nonNull(type));
      }
    });
  }

  /**
   * Remembers the types of checked expressions that may narrow a variable, e.g.
   * `let u ?User = new User()` makes `u` non-null until it is assigned again.
   */
  private readonly checkedTypes = new WeakMap<ast.Expression, Type>();

  private typeOfChecked(node: ast.Expression): Type {
    return this.checkedTypes.get(node) ?? UNKNOWN;
  }

  /**
   * `a, b = f()` or `return f()`: the call must return exactly `count` values. Returns their
   * types.
   */
  private unpack(
    value: ast.Expression,
    count: number,
    declared: Type | null,
    context: 'assignment' | 'return' = 'assignment',
  ): Type[] {
    const type = this.checkExpression(value, null);
    if (type.kind === 'unknown') return Array<Type>(count).fill(UNKNOWN);
    const returned = type.kind === 'tuple' ? type.types.length : type.kind === 'void' ? 0 : 1;
    if (type.kind !== 'tuple' || returned !== count) {
      const prefix =
        context === 'return'
          ? `wrong number of return values: expected ${count}, but`
          : `assignment mismatch: ${count} variables but`;
      this.error(`${prefix} ${callName(value)} returns ${countValues(returned)}`, value);
      return Array<Type>(count).fill(UNKNOWN);
    }
    if (declared) {
      for (const element of type.types) this.expectAssignable(element, declared, value);
      return type.types.map(() => declared);
    }
    return type.types;
  }

  private checkAssignment(node: ast.AssignmentStatement): void {
    const { targets, values, operator } = node;
    if (operator !== '=') {
      const target = targets[0]!;
      const targetType = this.checkTarget(target);
      const valueType = this.checkValue(values[0]!, targetType);
      const result = this.binaryResult(
        operator.slice(0, -1) as ast.BinaryOperator,
        targetType,
        valueType,
        node,
      );
      this.expectAssignable(result, targetType, values[0]!);
      this.forget(target);
      return;
    }

    const targetTypes = targets.map((target) => this.checkTarget(target));
    let valueTypes: Type[];
    if (values.length === targets.length) {
      valueTypes = values.map((value, i) => {
        const type = this.checkValue(value, targetTypes[i] ?? null);
        this.expectAssignable(type, targetTypes[i]!, value);
        return type;
      });
    } else {
      valueTypes = this.unpack(values[0]!, targets.length, null);
      valueTypes.forEach((type, i) => this.expectAssignable(type, targetTypes[i]!, values[0]!));
    }

    targets.forEach((target, i) => {
      this.forget(target);
      const binding = this.narrowableBinding(target);
      const declared = binding?.type;
      if (binding && declared && isNullable(declared) && !isNullable(valueTypes[i] ?? UNKNOWN)) {
        this.flow.set(binding, nonNull(declared));
      }
    });
  }

  /** The type a value assigned to `target` must have. */
  private checkTarget(target: ast.Expression): Type {
    switch (target.kind) {
      case 'Identifier': {
        if (target.name === '_') return ANY;
        const binding = this.lookupValue(target.name);
        if (!binding) {
          this.error(`"${target.name}" is not defined`, target);
          return UNKNOWN;
        }
        if (binding.kind === 'const') {
          this.error(`cannot assign to "${target.name}": it is a constant`, target);
        } else if (binding.kind === 'loop') {
          this.error(`cannot assign to loop variable "${target.name}"`, target);
        } else if (binding.kind === 'prop') {
          this.error(
            `cannot assign to "${target.name}": component properties are read-only; to change the parent's state, pass a function`,
            target,
          );
        } else if (
          binding.kind !== 'let' &&
          binding.kind !== 'state' &&
          binding.kind !== 'param' &&
          binding.kind !== 'catch'
        ) {
          this.error(`cannot assign to "${target.name}"`, target);
        }
        return binding.type ?? UNKNOWN;
      }
      case 'MemberExpression': {
        const object = this.nonNullValue(target.object);
        const member = this.findMember(object, target.property.name, target.property);
        if (member === 'any') return ANY;
        if (!member) return UNKNOWN;
        if (member.method) {
          this.error(`cannot assign to method "${target.property.name}"`, target);
          return UNKNOWN;
        }
        return member.type;
      }
      case 'IndexExpression': {
        const object = this.nonNullValue(target.object);
        this.expectIndex(target.index);
        if (object.kind === 'array') return object.element;
        if (object.kind === 'any' || object.kind === 'unknown') return object;
        this.error(
          object.kind === 'string'
            ? 'cannot assign to a character: strings cannot be changed'
            : `cannot index ${typeToString(object)}`,
          target,
        );
        return UNKNOWN;
      }
      default:
        this.checkValue(target);
        return UNKNOWN;
    }
  }

  private checkReturn(node: ast.ReturnStatement): void {
    const fn = this.fn;
    if (!fn) return;
    const { values } = node;

    if (fn.isComponent) {
      // A component may return early; whatever it returns is its markup.
      const [value] = values;
      if (value === undefined || values.length > 1) {
        this.error('a component returns its markup: "return <markup>"', node);
        return;
      }
      const type = this.checkValue(value);
      if (!isUntyped(type) && !isAssignable(type, NODE)) {
        this.error(`a component returns markup, not ${typeToString(type)}`, value);
      }
      return;
    }

    if (fn.results === null) {
      // Results are inferred: just record what is returned.
      if (values.length === 1) {
        const type = this.checkExpression(values[0]!, null);
        fn.returns.push(type.kind === 'tuple' ? type.types : type.kind === 'void' ? [] : [type]);
      } else {
        fn.returns.push(values.map((value) => this.checkValue(value)));
      }
      return;
    }

    const expected = fn.results;
    if (values.length === 0) {
      if (expected.length > 0) {
        this.error(`missing return values: expected ${countValues(expected.length)}`, node);
      }
      return;
    }
    if (expected.length === 0) {
      this.error('too many return values: this function returns nothing', values[0]!);
      for (const value of values) this.checkExpression(value, null);
      return;
    }
    if (values.length === 1 && expected.length > 1 && values[0]!.kind === 'CallExpression') {
      const types = this.unpack(values[0], expected.length, null, 'return');
      types.forEach((type, i) =>
        this.expectAssignable(type, expected[i]!, values[0]!, ' in return'),
      );
      return;
    }
    if (values.length !== expected.length) {
      this.error(
        `wrong number of return values: expected ${expected.length}, got ${values.length}`,
        node,
      );
    }
    values.forEach((value, i) => {
      const target = expected[i];
      const type = this.checkValue(value, target ?? null);
      if (target) this.expectAssignable(type, target, value, ' in return');
    });
  }

  private checkIf(node: ast.IfStatement): void {
    this.checkCondition(node.condition);
    const before = this.flow;
    // Both are found from the flow before the `if`, not from the end of a branch.
    const whenTrue = this.narrow(node.condition, true);
    const whenFalse = this.narrow(node.condition, false);

    this.flow = withNarrowing(before, whenTrue);
    this.checkBlock(node.consequent.body);
    const afterThen = this.flow;

    this.flow = withNarrowing(before, whenFalse);
    const { alternate } = node;
    if (alternate?.kind === 'IfStatement') this.checkIf(alternate);
    else if (alternate) this.checkBlock(alternate.body);
    const afterElse = this.flow;

    // A branch that always leaves (return, throw, break, continue) does not reach the code after
    // the `if`, so `if x == null { return }` narrows `x` for the rest of the block.
    const thenLeaves = leaves(node.consequent);
    const elseLeaves = alternate !== null && leaves(alternate);
    if (thenLeaves && !elseLeaves) this.flow = afterElse;
    else if (elseLeaves && !thenLeaves) this.flow = afterThen;
    else this.flow = mergeFlows(afterThen, afterElse);
  }

  private checkFor(node: ast.ForStatement): void {
    this.withScope(() => {
      if (node.init) this.checkSimpleStatement(node.init);
      // Variables assigned in the loop may change between iterations.
      this.dropNarrowing(assignedNames(node));
      const entry = this.flow;
      if (node.condition) this.checkCondition(node.condition);
      this.flow = withNarrowing(entry, node.condition ? this.narrow(node.condition, true) : []);
      this.checkBlock(node.body.body);
      if (node.update) this.checkSimpleStatement(node.update);
      this.flow = entry;
    });
  }

  private checkSimpleStatement(node: ast.SimpleStatement): void {
    this.checkStatement(node);
  }

  private checkForIn(node: ast.ForInStatement): void {
    const iterable = this.checkValue(node.iterable);
    let value: Type = UNKNOWN;
    let key: Type = NUMBER;
    if (isNullable(iterable)) {
      this.nullError(node.iterable);
    } else if (iterable.kind === 'array') {
      value = iterable.element;
    } else if (iterable.kind === 'string') {
      value = STRING;
    } else if (iterable.kind === 'any') {
      value = ANY;
      key = ANY;
    } else if (iterable.kind !== 'unknown') {
      this.error(`cannot iterate over ${typeToString(iterable)}`, node.iterable);
    }

    this.withScope(() => {
      if (node.key) this.declareValue(node.key, 'loop', key);
      this.declareValue(node.value, 'loop', value);
      this.dropNarrowing(assignedNames(node.body));
      const entry = this.flow;
      this.flow = new Map(entry);
      this.checkBlock(node.body.body);
      this.flow = entry;
    });
  }

  private checkSwitch(node: ast.SwitchStatement): void {
    const discriminant = node.discriminant ? this.checkValue(node.discriminant) : null;
    this.dropNarrowing(assignedNames(node));
    const entry = this.flow;
    for (const switchCase of node.cases) {
      this.flow = entry;
      for (const test of switchCase.tests) {
        if (discriminant === null) {
          this.checkCondition(test);
          continue;
        }
        const type = this.checkValue(test, discriminant);
        if (!isComparable(type, discriminant)) {
          this.error(
            `cannot compare ${typeToString(discriminant)} with ${typeToString(type)}`,
            test,
          );
        }
      }
      const narrowing =
        discriminant === null
          ? switchCase.tests.length === 1
            ? this.narrow(switchCase.tests[0]!, true)
            : []
          : this.narrowCase(node, switchCase, entry);
      this.flow = withNarrowing(entry, narrowing);
      this.checkBlock(switchCase.body);
    }
    this.flow = entry;
  }

  /**
   * `switch filter { case "all": ... default: ... }`: in a case the discriminant has the literals
   * of its tests, in `default` the literals of no case.
   */
  private narrowCase(
    node: ast.SwitchStatement,
    switchCase: ast.SwitchCase,
    entry: Flow,
  ): Narrowing {
    const binding = node.discriminant ? this.narrowableBinding(node.discriminant) : undefined;
    if (!binding?.type) return [];
    const current = entry.get(binding) ?? binding.type;
    if (!unionMembers(nonNull(current)).some((member) => member.kind === 'literal')) return [];
    if (switchCase.tests.length > 0) {
      const values = switchCase.tests.map(literalValue);
      if (values.some((value) => value === undefined)) return [];
      return [[binding, union(values.map((value) => literal(value!)))]];
    }
    let rest = current;
    for (const other of node.cases) {
      for (const test of other.tests) {
        const value = literalValue(test);
        if (value !== undefined) rest = withoutLiteral(rest, value);
      }
    }
    return [[binding, rest]];
  }

  private checkTry(node: ast.TryStatement): void {
    this.dropNarrowing(assignedNames(node));
    const entry = this.flow;
    this.flow = new Map(entry);
    this.checkBlock(node.block.body);
    const { handler, finalizer } = node;
    if (handler) {
      this.flow = new Map(entry);
      this.withScope(() => {
        if (handler.param) this.declareValue(handler.param, 'catch', ANY);
        this.checkStatementList(handler.body.body, false);
      });
    }
    if (finalizer) {
      this.flow = new Map(entry);
      this.checkBlock(finalizer.body);
    }
    this.flow = entry;
  }

  private checkCondition(node: ast.Expression): void {
    const type = widenLiterals(this.checkValue(node, BOOL));
    if (type.kind === 'bool' || type.kind === 'any' || type.kind === 'unknown') return;
    const hint = isNullable(type)
      ? ': compare it with null, e.g. "x != null"'
      : type.kind === 'number'
        ? ': compare it, e.g. "n != 0"'
        : type.kind === 'string'
          ? ': compare it, e.g. s != ""'
          : '';
    this.error(`condition must be bool, not ${typeToString(type)}${hint}`, node);
  }

  // ─── Functions ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Checks a function body and returns its result types: the declared ones, or those inferred from
   * the `return` statements when `results` is `null`.
   */
  private checkFunction(
    params: readonly ast.Parameter[],
    type: FunctionType,
    results: Type[] | null,
    body: ast.BlockStatement | ast.Expression,
    options: {
      isConstructor?: boolean;
      isComponent?: boolean;
      closure?: boolean;
      paramKind?: BindingKind;
    } = {},
  ): Type[] {
    const saved = { scope: this.scope, flow: this.flow, fn: this.fn };
    this.scope = new Scope(this.scope);
    // A closure keeps the narrowing of variables that cannot change before it runs.
    this.flow = options.closure ? this.stableFlow() : new Map<Binding, Type>();
    this.fn = {
      results,
      returns: [],
      isConstructor: options.isConstructor ?? false,
      isComponent: options.isComponent ?? false,
    };
    try {
      params.forEach((param, i) =>
        this.declareValue(param.name, options.paramKind ?? 'param', type.params[i] ?? UNKNOWN),
      );
      if (body.kind === 'BlockStatement') {
        this.checkStatementList(body.body, false);
        if (results && results.length > 0 && !isTerminating(body)) {
          this.error('missing return at the end of the function', {
            start: body.end - 1,
            end: body.end,
          });
        }
        return results ?? this.inferResults(this.fn.returns, body);
      }
      return this.checkExpressionBody(body, results);
    } finally {
      this.scope = saved.scope;
      this.flow = saved.flow;
      this.fn = saved.fn;
    }
  }

  /** The body of `x => x * 2`. */
  private checkExpressionBody(body: ast.Expression, results: Type[] | null): Type[] {
    if (results === null || results.length === 0) {
      const type = this.checkExpression(body, null);
      if (results !== null) return [];
      return type.kind === 'tuple' ? type.types : type.kind === 'void' ? [] : [type];
    }
    if (results.length === 1) {
      const type = this.checkValue(body, results[0] ?? null);
      this.expectAssignable(type, results[0]!, body, ' in return');
      return results;
    }
    const types = this.unpack(body, results.length, null, 'return');
    types.forEach((type, i) => this.expectAssignable(type, results[i]!, body, ' in return'));
    return results;
  }

  private inferResults(returns: Type[][], body: ast.BlockStatement): Type[] {
    const first = returns[0];
    if (first === undefined) return [];
    const results = [...first];
    for (const types of returns.slice(1)) {
      if (types.length !== results.length) {
        this.error('return statements return different numbers of values', body);
        return results;
      }
      types.forEach((type, i) => {
        // Different types of returns make a union, as in TypeScript.
        results[i] = commonType(results[i]!, type);
      });
    }
    return results;
  }

  private stableFlow(): Flow {
    const flow: Flow = new Map();
    for (const [binding, type] of this.flow) {
      if (binding.kind === 'const' || !this.assigned.has(binding.name)) flow.set(binding, type);
    }
    return flow;
  }

  private checkArrowFunction(node: ast.ArrowFunction, expected: Type | null): Type {
    const context = expected ? callSignature(nonNull(expected)) : null;
    // Callbacks passed to untyped JS functions get untyped parameters.
    const untypedContext = expected !== null && isUntyped(nonNull(expected));
    const params = node.params.map((param, i) => {
      if (param.type) return this.resolveType(param.type);
      const fromContext = context ? (context.params[i] ?? context.rest) : null;
      if (fromContext && !containsTypeParam(fromContext)) return fromContext;
      if (untypedContext) return nonNull(expected);
      this.error(`cannot infer the type of parameter "${param.name.name}": add a type`, param);
      return UNKNOWN;
    });
    // Known result types from the context are checked; otherwise they are inferred.
    const contextResults =
      context && context.results.length > 0 && !context.results.some(containsTypeParam)
        ? context.results
        : null;
    const type = func(params, []);
    type.results = this.checkFunction(node.params, type, contextResults, node.body, {
      closure: true,
    });
    return type;
  }

  private checkFuncExpression(node: ast.FuncExpression): Type {
    const type = this.signature(node.params, node.results);
    this.checkFunction(node.params, type, type.results, node.body, { closure: true });
    return type;
  }

  // ─── Narrowing ─────────────────────────────────────────────────────────────────────────────────

  /** Variables whose type is narrowed when `node` evaluates to `assumeTrue`. */
  private narrow(node: ast.Expression, assumeTrue: boolean): Narrowing {
    if (node.kind === 'UnaryExpression' && node.operator === '!') {
      return this.narrow(node.argument, !assumeTrue);
    }
    if (node.kind !== 'BinaryExpression') return [];
    const { operator, left, right } = node;
    // `a && b` is true, or `a || b` is false: both sides hold, and the right one is narrowed in
    // the flow that the left one gives.
    if ((operator === '&&' && assumeTrue) || (operator === '||' && !assumeTrue)) {
      const first = this.narrow(left, assumeTrue);
      const saved = this.flow;
      this.flow = withNarrowing(saved, first);
      try {
        return [...first, ...this.narrow(right, assumeTrue)];
      } finally {
        this.flow = saved;
      }
    }
    if (operator === '&&' || operator === '||') return [];
    // `x != null` when true, `x == null` when false: `x` is not null.
    if ((operator === '!=' && assumeTrue) || (operator === '==' && !assumeTrue)) {
      const target =
        right.kind === 'NullLiteral' ? left : left.kind === 'NullLiteral' ? right : null;
      const binding = target ? this.narrowableBinding(target) : undefined;
      if (binding?.type) return [[binding, nonNull(this.flow.get(binding) ?? binding.type)]];
    }
    if (operator === 'instanceof') return this.narrowInstanceof(left, right, assumeTrue);
    if (operator !== '==' && operator !== '!=') return [];
    // Whether the comparison is found to give "equal".
    const equal = (operator === '==') === assumeTrue;

    // `typeof x == "string"`
    const [check, tag] =
      left.kind === 'UnaryExpression' && left.operator === 'typeof'
        ? [left, right]
        : right.kind === 'UnaryExpression' && right.operator === 'typeof'
          ? [right, left]
          : [null, null];
    if (check && tag?.kind === 'StringLiteral') {
      const binding = this.narrowableBinding(check.argument);
      if (!binding?.type) return [];
      const type = narrowByTypeof(this.flow.get(binding) ?? binding.type, tag.value, equal);
      return type ? [[binding, type]] : [];
    }

    // `filter == "all"`: narrows a type with literals in it.
    const value = literalValue(right) ?? literalValue(left);
    const target = literalValue(right) !== undefined ? left : right;
    const binding = value === undefined ? undefined : this.narrowableBinding(target);
    if (value === undefined || !binding?.type) return [];
    const current = this.flow.get(binding) ?? binding.type;
    if (!unionMembers(nonNull(current)).some((member) => member.kind === 'literal')) return [];
    return [[binding, equal ? literal(value) : withoutLiteral(current, value)]];
  }

  /** `x instanceof Date`: an instance of the class when true, the rest of a union when false. */
  private narrowInstanceof(
    left: ast.Expression,
    right: ast.Expression,
    assumeTrue: boolean,
  ): Narrowing {
    const binding = this.narrowableBinding(left);
    const classType = this.typeOfChecked(right);
    if (!binding?.type || classType.kind !== 'classValue') return [];
    const current = this.flow.get(binding) ?? binding.type;
    const { info } = classType;
    const members = unionMembers(nonNull(current));
    if (assumeTrue) {
      const kept = members.filter((member) => isAssignable(member, info.instance));
      return [[binding, kept.length > 0 ? union(kept) : info.instance]];
    }
    const kept = members.filter(
      (member) => !(member.kind === 'class' && isSubclass(member.info, info)),
    );
    return [[binding, union(isNullable(current) ? [...kept, NULL] : kept)]];
  }

  private narrowableBinding(node: ast.Expression): Binding | undefined {
    if (node.kind !== 'Identifier') return undefined;
    const binding = this.lookupValue(node.name);
    return binding && NARROWABLE.has(binding.kind) ? binding : undefined;
  }

  /** An assignment to a variable ends its narrowing. */
  private forget(target: ast.Expression): void {
    const binding = this.narrowableBinding(target);
    if (binding) this.flow.delete(binding);
  }

  private dropNarrowing(names: ReadonlySet<string>): void {
    this.flow = new Map([...this.flow].filter(([binding]) => !names.has(binding.name)));
  }

  // ─── Expressions ───────────────────────────────────────────────────────────────────────────────

  /** The type of an expression that must be a single value (not `void` or several results). */
  private checkValue(node: ast.Expression, expected: Type | null = null): Type {
    return this.single(this.checkExpression(node, expected), node);
  }

  private single(type: Type, node: ast.Expression): Type {
    if (type.kind === 'tuple') {
      this.error(
        `${callName(node)} returns ${type.types.length} values: unpack them, e.g. "const a, b = ..."`,
        node,
      );
      return UNKNOWN;
    }
    if (type.kind === 'void') {
      this.error(`${callName(node)} does not return a value`, node);
      return UNKNOWN;
    }
    return type;
  }

  /** `expected` is the type the context wants, used to type literals and arrow functions. */
  private checkExpression(node: ast.Expression, expected: Type | null): Type {
    const type = this.computeType(node, expected);
    this.checkedTypes.set(node, type);
    return type;
  }

  private computeType(node: ast.Expression, expected: Type | null): Type {
    switch (node.kind) {
      case 'Identifier':
        return this.checkIdentifier(node);
      // A literal has a literal type only where one is expected: `filter = "all"`.
      case 'NumberLiteral':
        return expectsLiteral(expected) ? literal(node.value) : NUMBER;
      case 'StringLiteral':
        return expectsLiteral(expected) ? literal(node.value) : STRING;
      case 'TemplateLiteral':
        for (const expression of node.expressions) this.checkValue(expression);
        return STRING;
      case 'BooleanLiteral':
        return expectsLiteral(expected) ? literal(node.value) : BOOL;
      case 'NullLiteral':
        return NULL;
      case 'ThisExpression':
        return this.thisType(node);
      case 'SuperExpression':
        return this.superType(node);
      case 'ArrayLiteral':
        return this.checkArrayLiteral(node, expected);
      case 'ObjectLiteral':
        return this.checkObjectLiteral(node, expected);
      case 'FuncExpression':
        return this.checkFuncExpression(node);
      case 'ArrowFunction':
        return this.checkArrowFunction(node, expected);
      case 'UnaryExpression':
        return this.checkUnary(node);
      case 'BinaryExpression':
        return this.checkBinary(node, expected);
      case 'ConditionalExpression':
        return this.checkConditional(node, expected);
      case 'NewExpression':
        return this.checkNew(node);
      case 'ElementExpression':
        return this.checkElement(node);
      case 'MemberExpression':
      case 'IndexExpression':
      case 'CallExpression': {
        const [type, shortCircuits] = this.checkChain(node);
        return shortCircuits && type.kind !== 'tuple' && type.kind !== 'void'
          ? nullable(type)
          : type;
      }
    }
  }

  private checkIdentifier(node: ast.Identifier): Type {
    if (node.name === '_') {
      this.error('"_" cannot be used as a value', node);
      return UNKNOWN;
    }
    const binding = this.lookupValue(node.name);
    if (!binding) {
      this.error(
        this.lookupType(node.name)
          ? `"${node.name}" is a type, not a value`
          : `"${node.name}" is not defined`,
        node,
      );
      return UNKNOWN;
    }
    if (binding.kind === 'component') {
      this.error(`components are used as tags: <${node.name} />`, node);
      return UNKNOWN;
    }
    if (binding.type === null) {
      this.error(`"${node.name}" is used before its declaration`, node);
      return UNKNOWN;
    }
    return this.flow.get(binding) ?? binding.type;
  }

  private thisType(node: ast.NodeBase): Type {
    if (!this.cls) {
      this.error('"this" can only be used inside a class', node);
      return UNKNOWN;
    }
    return this.cls.isStatic ? this.cls.info.value : this.cls.info.instance;
  }

  /** `super.method()`: the members of the base class. */
  private superType(node: ast.NodeBase): Type {
    const info = this.cls?.info;
    if (!info) {
      this.error('"super" can only be used inside a class', node);
      return UNKNOWN;
    }
    if (info.superClass)
      return this.cls?.isStatic ? info.superClass.value : info.superClass.instance;
    if (hasUntypedBase(info)) return ANY;
    this.error(`class "${info.name}" has no base class`, node);
    return UNKNOWN;
  }

  private checkArrayLiteral(node: ast.ArrayLiteral, expected: Type | null): Type {
    const context = expected ? nonNull(expected) : null;
    const expectedElement =
      context?.kind === 'array' ? context.element : context?.kind === 'any' ? ANY : null;
    let element: Type = expectedElement ?? NEVER;

    for (const item of node.elements) {
      let type: Type;
      if (item.kind === 'SpreadElement') {
        const spread = this.checkValue(item.argument, expectedElement && arrayOf(expectedElement));
        if (spread.kind === 'array') type = spread.element;
        else if (spread.kind === 'any' || spread.kind === 'unknown') type = spread;
        else {
          this.error(`cannot spread ${typeToString(spread)}: it is not an array`, item.argument);
          type = UNKNOWN;
        }
      } else {
        type = this.checkValue(item, expectedElement);
      }

      if (expectedElement) {
        this.expectAssignable(
          type,
          expectedElement,
          item.kind === 'SpreadElement' ? item.argument : item,
        );
      } else {
        element = commonType(element, type);
      }
    }
    return arrayOf(element);
  }

  private checkObjectLiteral(node: ast.ObjectLiteral, expected: Type | null): Type {
    const target = expected ? nonNull(expected) : null;
    const targetMembers =
      target?.kind === 'object'
        ? target.members
        : target?.kind === 'class'
          ? instanceMembers(target.info)
          : null;
    const members = new Map<string, Member>();
    const written = new Set<string>();
    let untyped = false;

    for (const property of node.properties) {
      if (property.kind === 'SpreadElement') {
        const spread = this.checkValue(property.argument);
        if (spread.kind === 'object') {
          for (const [name, member] of spread.members) members.set(name, member);
        } else if (spread.kind === 'class') {
          for (const [name, member] of instanceMembers(spread.info)) {
            if (member.visibility === 'public' && !member.method) members.set(name, member);
          }
        } else if (spread.kind === 'any' || spread.kind === 'unknown') {
          untyped = true;
        } else {
          this.error(`cannot spread ${typeToString(spread)} into an object`, property.argument);
        }
        continue;
      }

      const name = property.key.kind === 'Identifier' ? property.key.name : property.key.value;
      // Fields may override those of a spread object, but not each other.
      if (written.has(name)) this.error(`duplicate field "${name}"`, property.key);
      written.add(name);
      const expectedMember = targetMembers?.get(name);
      // A field that the expected type does not have is most likely a typo.
      if (targetMembers && !expectedMember && target) {
        this.error(`${typeToString(target)} has no field "${name}"`, property.key);
      }
      let type = this.checkValue(property.value, expectedMember?.type ?? null);
      if (expectedMember) {
        // Reported at the field; the literal then counts as having the expected field type.
        this.expectAssignable(type, expectedMember.type, property.value, ` for field "${name}"`);
        type = expectedMember.type;
      }
      members.set(name, { type, method: false, visibility: 'public', owner: null });
    }
    return untyped ? ANY : { kind: 'object', name: null, members, call: null };
  }

  private checkUnary(node: ast.UnaryExpression): Type {
    const type = this.checkValue(node.argument);
    switch (node.operator) {
      case 'typeof':
        return STRING;
      case '!':
        this.expectBool(type, node.argument, '"!"');
        return BOOL;
      case '-':
      case '+':
      case '~':
        if (!isNumeric(type)) {
          this.error(`"${node.operator}" needs a number, not ${typeToString(type)}`, node.argument);
        }
        return NUMBER;
    }
  }

  private expectBool(given: Type, node: ast.NodeBase, operator: string): void {
    const type = widenLiterals(given);
    if (type.kind === 'bool' || type.kind === 'any' || type.kind === 'unknown') return;
    const hint = isNullable(type) ? ': compare it with null, e.g. "x != null"' : '';
    this.error(`${operator} needs bool, not ${typeToString(type)}${hint}`, node);
  }

  private checkBinary(node: ast.BinaryExpression, expected: Type | null): Type {
    const { operator } = node;
    if (operator === '&&' || operator === '||') {
      this.expectBool(this.checkValue(node.left, BOOL), node.left, `"${operator}"`);
      // `x != null && x.ok`: the right side runs only when the left side allows it.
      const saved = this.flow;
      this.flow = withNarrowing(saved, this.narrow(node.left, operator === '&&'));
      this.expectBool(this.checkValue(node.right, BOOL), node.right, `"${operator}"`);
      this.flow = saved;
      return BOOL;
    }
    if (operator === '??') {
      const left = this.checkValue(node.left, expected && nullable(expected));
      const right = this.checkValue(node.right, expected ?? nonNull(left));
      return this.binaryResult(operator, left, right, node);
    }
    const left = this.checkValue(node.left);
    const right = this.checkValue(node.right, operator === '==' || operator === '!=' ? left : null);
    return this.binaryResult(operator, left, right, node);
  }

  /** The type of `left <operator> right`, also used for compound assignments like `+=`. */
  private binaryResult(
    operator: ast.BinaryOperator,
    givenLeft: Type,
    givenRight: Type,
    node: ast.NodeBase,
  ): Type {
    // Literals behave as their base types, except where they are compared.
    const keepLiterals = operator === '==' || operator === '!=' || operator === '??';
    const left = keepLiterals ? givenLeft : widenLiterals(givenLeft);
    const right = keepLiterals ? givenRight : widenLiterals(givenRight);
    const untyped = isUntyped(left) || isUntyped(right);
    const nullHint =
      isNullable(left) || isNullable(right) ? ': a value may be null, check it first' : '';
    switch (operator) {
      case '+':
        if (left.kind === 'number' && right.kind === 'number') return NUMBER;
        if (left.kind === 'string' && right.kind === 'string') return STRING;
        if (untyped) return left.kind === 'string' || right.kind === 'string' ? STRING : ANY;
        this.error(
          `cannot add ${typeToString(left)} and ${typeToString(right)}` +
            (nullHint ||
              (left.kind === 'string' || right.kind === 'string'
                ? ': use a template string, e.g. `${a}${b}`'
                : '')),
          node,
        );
        return UNKNOWN;
      case '-':
      case '*':
      case '/':
      case '%':
      case '**':
      case '<<':
      case '>>':
      case '>>>':
      case '&':
      case '|':
      case '^':
        if (!isNumeric(left) || !isNumeric(right)) {
          this.error(
            `"${operator}" needs numbers, not ${typeToString(left)} and ${typeToString(right)}${nullHint}`,
            node,
          );
        }
        return NUMBER;
      case '<':
      case '>':
      case '<=':
      case '>=': {
        const ordered =
          untyped ||
          (left.kind === 'number' && right.kind === 'number') ||
          (left.kind === 'string' && right.kind === 'string');
        if (!ordered) {
          this.error(
            `cannot compare ${typeToString(left)} and ${typeToString(right)} with "${operator}"${nullHint}`,
            node,
          );
        }
        return BOOL;
      }
      case '==':
      case '!=':
        if (!isComparable(left, right)) {
          this.error(`cannot compare ${typeToString(left)} and ${typeToString(right)}`, node);
        }
        return BOOL;
      case 'instanceof':
        if (right.kind !== 'classValue' && !isUntyped(right)) {
          this.error(
            `the right side of instanceof must be a class, not ${typeToString(right)}`,
            node,
          );
        }
        return BOOL;
      case '&&':
      case '||':
        this.expectBool(left, node, `"${operator}"`);
        return BOOL;
      case '??': {
        if (isUntyped(left)) return left;
        const base = nonNull(left);
        if (isAssignable(right, base)) return isNullable(right) ? nullable(base) : base;
        return commonType(base, right);
      }
    }
  }

  private checkConditional(node: ast.ConditionalExpression, expected: Type | null): Type {
    this.checkCondition(node.test);
    const before = this.flow;
    const whenTrue = this.narrow(node.test, true);
    const whenFalse = this.narrow(node.test, false);
    this.flow = withNarrowing(before, whenTrue);
    const consequent = this.checkValue(node.consequent, expected);
    this.flow = withNarrowing(before, whenFalse);
    const alternate = this.checkValue(node.alternate, expected);
    this.flow = before;
    return commonType(consequent, alternate);
  }

  // ─── Markup ────────────────────────────────────────────────────────────────────────────────────

  private checkElement(node: ast.ElementExpression): Type {
    if (node.tag && /^[A-Z]/.test(node.tag.name)) return this.checkComponentUse(node, node.tag);
    const tag = node.tag?.name ?? null;
    const type = tag === null ? DOCUMENT_FRAGMENT : elementType(tag);
    for (const attribute of node.attributes) {
      if (attribute.kind === 'JsxSpreadAttribute') {
        const spread = this.checkValue(attribute.argument);
        if (!isUntyped(spread) && spread.kind !== 'object') {
          this.error(`cannot spread ${typeToString(spread)} into attributes`, attribute.argument);
        }
      } else if (tag !== null && attribute.name.name.startsWith('bind:')) {
        this.checkBinding(attribute, tag, node.attributes);
      } else if (tag !== null) {
        this.checkAttribute(attribute, tag, type);
      }
    }
    for (const attribute of node.attributes) {
      if (attribute.kind !== 'JsxAttribute' || !attribute.name.name.startsWith('bind:')) continue;
      const property = attribute.name.name.slice('bind:'.length);
      const plain = node.attributes.some(
        (other) => other.kind === 'JsxAttribute' && other.name.name === property,
      );
      if (plain) {
        this.error(
          `"${property}" and "bind:${property}" set the same property: keep one of them`,
          attribute.name,
        );
      }
    }
    this.checkChildren(node.children);
    return type;
  }

  private checkChildren(children: readonly ast.JsxChild[]): void {
    for (const child of children) {
      if (child.kind === 'JsxText') continue;
      if (child.kind === 'JsxStatementContainer') {
        // Checked like any if/for/switch, so conditions narrow types in the blocks.
        this.checkStatement(child.statement);
        continue;
      }
      if (child.kind === 'ElementExpression') {
        this.checkExpression(child, null);
        continue;
      }
      const content = this.checkValue(child.expression);
      if (!isContent(content)) {
        this.error(
          `cannot use ${typeToString(content)} as element content` +
            (content.kind === 'bool' ? ': use a condition, e.g. {ok ? <b>yes</b> : null}' : ''),
          child.expression,
        );
      }
    }
  }

  private checkAttribute(attribute: ast.JsxAttribute, tag: string, element: Type): void {
    const name = attribute.name.name;
    const { value } = attribute;
    if (/^on[A-Z]/.test(name)) {
      this.checkEventAttribute(attribute, eventType(element));
      return;
    }
    if (value?.kind === 'EventHandler') return;
    const valueType =
      value === null ? BOOL : value.kind === 'StringLiteral' ? STRING : this.checkValue(value);

    if (name === 'style') {
      if (!isUntyped(valueType) && valueType.kind !== 'string' && valueType.kind !== 'object') {
        this.error(
          `style must be a string or an object, not ${typeToString(valueType)}`,
          attribute,
        );
      }
      return;
    }
    // `<a download>` without a value sets an empty attribute, whatever the property type is.
    if (value === null) return;
    const property = domProperty(tag, name);
    if (property) {
      this.expectAssignable(valueType, property.type, value, ` for attribute "${name}"`);
    } else if (!isAttributeValue(valueType)) {
      this.error(
        `attribute "${name}" needs a string, number or bool, not ${typeToString(valueType)}`,
        value,
      );
    }
  }

  /**
   * `bind:value={name}`: the element shows the variable, and what the user enters is written back
   * to it. So the value must be something that can be assigned.
   */
  private checkBinding(
    attribute: ast.JsxAttribute,
    tag: string,
    attributes: readonly (ast.JsxAttribute | ast.JsxSpreadAttribute)[],
  ): void {
    const name = attribute.name.name;
    const property = name.slice('bind:'.length);
    const { value } = attribute;
    if (property !== 'value' && property !== 'checked') {
      this.error(`unknown binding "${name}": use bind:value or bind:checked`, attribute.name);
      return;
    }
    const tags = property === 'value' ? ['input', 'textarea', 'select'] : ['input'];
    if (!tags.includes(tag)) {
      this.error(
        property === 'value'
          ? 'bind:value works with <input>, <textarea> and <select>'
          : 'bind:checked works with <input>',
        attribute.name,
      );
    }
    if (value === null || value.kind === 'StringLiteral' || value.kind === 'EventHandler') {
      this.error(`"${name}" needs a variable in braces, e.g. ${name}={title}`, attribute);
      return;
    }
    const bindable =
      (value.kind === 'Identifier' && value.name !== '_') ||
      ((value.kind === 'MemberExpression' || value.kind === 'IndexExpression') && !value.optional);
    if (!bindable) {
      this.checkValue(value);
      this.error(`"${name}" needs a variable or a field to write to`, value);
      return;
    }
    const type = this.checkTarget(value);
    this.checkedTypes.set(value, type);
    if (isUntyped(type)) return;
    if (property === 'checked' && type.kind !== 'bool') {
      this.error(`bind:checked needs a bool, not ${typeToString(type)}`, value);
    } else if (property === 'value' && type.kind === 'number' && tag === 'input') {
      // A number is read with valueAsNumber, which only number and range inputs have.
      const typeAttribute = attributes.find(
        (other): other is ast.JsxAttribute =>
          other.kind === 'JsxAttribute' && other.name.name === 'type',
      )?.value;
      const inputType = typeAttribute?.kind === 'StringLiteral' ? typeAttribute.value : null;
      if (inputType !== 'number' && inputType !== 'range') {
        this.error(
          'a number can be bound to <input type="number"> or <input type="range">',
          attribute.name,
        );
      }
    } else if (
      property === 'value' &&
      type.kind !== 'string' &&
      !(type.kind === 'number' && tag === 'input')
    ) {
      const allowed = tag === 'input' ? 'a string or a number' : 'a string';
      this.error(`bind:value needs ${allowed}, not ${typeToString(type)}`, value);
    }
  }

  /** `onClick={...}`: code to run on the event, or a function that gets the event. */
  private checkEventAttribute(attribute: ast.JsxAttribute, event: Type): void {
    const name = attribute.name.name;
    const { value } = attribute;
    if (value === null || value.kind === 'StringLiteral') {
      this.error(`"${name}" needs code or a function in braces, e.g. ${name}={save()}`, attribute);
    } else if (value.kind === 'EventHandler') {
      this.checkEventHandler(value, event);
    } else {
      const handler = func([event], []);
      const type = this.checkValue(value, handler);
      this.expectAssignable(type, handler, value, ` as the "${name}" handler`);
    }
  }

  /** The statements of `onClick={count++}`, with `event` declared when there is one. */
  private checkEventHandler(handler: ast.EventHandler, event: Type | null): void {
    const saved = { scope: this.scope, flow: this.flow, fn: this.fn };
    this.scope = new Scope(this.scope);
    this.flow = this.stableFlow();
    this.fn = { results: [], returns: [], isConstructor: false };
    try {
      const name: ast.Identifier = {
        kind: 'Identifier',
        name: 'event',
        start: handler.start,
        end: handler.start,
      };
      if (event) this.declareValue(name, 'param', event);
      for (const statement of handler.body) this.checkStatement(statement);
    } finally {
      this.scope = saved.scope;
      this.flow = saved.flow;
      this.fn = saved.fn;
    }
  }

  // ─── Components ────────────────────────────────────────────────────────────────────────────────

  private resolveProps(info: ComponentInfo): void {
    for (const param of info.node.params) {
      const name = param.name.name;
      const type = param.type ? this.resolveType(param.type) : UNKNOWN;
      if (name === 'children' && type !== CONTENT && type.kind !== 'unknown') {
        this.error('the "children" property has the type Content', param.type ?? param);
      }
      if (info.props.has(name)) this.error(`duplicate property "${name}"`, param.name);
      const optional = param.defaultValue !== null || isNullable(type) || name === 'children';
      info.props.set(name, { type, optional });
    }
  }

  /** The body runs once where the component is used and must end with `return <markup>`. */
  private checkComponentBody(info: ComponentInfo): void {
    const { node } = info;
    const last = node.body.body.at(-1);
    if (last?.kind !== 'ReturnStatement' || last.values.length !== 1) {
      this.error('a component ends with "return <markup>"', {
        start: node.body.end - 1,
        end: node.body.end,
      });
    }
    for (const statement of ownStatements(node.body)) {
      if (statement.kind === 'DeferStatement') {
        this.error('defer is not supported in components yet', statement);
      }
    }

    const types: Type[] = [];
    for (const param of node.params) {
      const prop = info.props.get(param.name.name);
      const type = prop?.type ?? UNKNOWN;
      types.push(type);
      if (param.defaultValue) {
        const value = this.checkValue(param.defaultValue, type);
        this.expectAssignable(value, type, param.defaultValue);
      }
    }

    const saved = this.component;
    this.component = info;
    try {
      this.withClass(null, () =>
        this.checkFunction(node.params, func(types, []), null, node.body, {
          paramKind: 'prop',
          isComponent: true,
        }),
      );
    } finally {
      this.component = saved;
    }
  }

  /** `<Card title="Профиль">...</Card>`: properties are checked like the arguments of a call. */
  private checkComponentUse(node: ast.ElementExpression, tag: ast.Identifier): Type {
    const binding = this.lookupValue(tag.name);
    const info = binding?.component;
    if (!info) {
      this.error(
        binding ? `"${tag.name}" is not a component` : `unknown component <${tag.name}>`,
        tag,
      );
      return UNKNOWN;
    }
    // A recursive component is a function: its code is not inlined here.
    if (!info.recursive) this.checkHygiene(info, tag);

    const given = new Set<string>();
    const spread = new Set<string>();
    for (const attribute of node.attributes) {
      if (attribute.kind === 'JsxSpreadAttribute') {
        this.checkSpreadProps(attribute.argument, info, tag.name, spread);
        continue;
      }
      const name = attribute.name.name;
      const prop = info.props.get(name);
      if (given.has(name)) this.error(`duplicate property "${name}"`, attribute.name);
      given.add(name);
      if (name === 'children' && prop) {
        this.error(
          `pass children between the tags: <${tag.name}>...</${tag.name}>`,
          attribute.name,
        );
      } else if (!prop) {
        this.error(`<${tag.name}> has no property "${name}"`, attribute.name);
      } else {
        this.checkProp(attribute, prop.type, tag.name);
      }
    }
    for (const [name, prop] of info.props) {
      if (!prop.optional && !given.has(name) && !spread.has(name)) {
        this.error(`<${tag.name}> needs the property "${name}"`, tag);
      }
    }
    if (node.children.length > 0 && !info.props.has('children')) {
      this.error(`<${tag.name}> takes no children`, node.children[0]!);
    }
    this.checkChildren(node.children);
    return this.componentResult(info, new Set());
  }

  /**
   * `<Product {...product} />`: fields of the object with the names of properties are passed as
   * those properties; other fields are ignored. Adds the names of the given properties to `given`.
   */
  private checkSpreadProps(
    argument: ast.Expression,
    info: ComponentInfo,
    component: string,
    given: Set<string>,
  ): void {
    const type = this.checkValue(argument);
    if (isUntyped(type)) {
      for (const name of info.props.keys()) given.add(name);
      return;
    }
    const fields = isNullable(type) ? null : spreadFields(type);
    if (!fields) {
      if (isNullable(type)) this.nullError(argument);
      else {
        this.error(
          `cannot spread ${typeToString(type)} into the properties of <${component}>`,
          argument,
        );
      }
      // After the error, missing properties would only repeat it.
      for (const name of info.props.keys()) given.add(name);
      return;
    }
    for (const [name, prop] of info.props) {
      const field = fields.get(name);
      if (field === undefined || name === 'children') continue;
      given.add(name);
      this.expectAssignable(field, prop.type, argument, ` for "${name}" of <${component}>`);
    }
  }

  private checkProp(attribute: ast.JsxAttribute, type: Type, component: string): void {
    const name = attribute.name.name;
    const { value } = attribute;
    if (value?.kind === 'EventHandler') {
      // Code for a callback property; `event` is the callback's first argument, if it has one.
      const signature = callSignature(nonNull(type));
      if (!signature && !isUntyped(type)) {
        this.error(`"${name}" of <${component}> is not a function, so it needs a value`, value);
        return;
      }
      this.checkEventHandler(value, signature?.params[0] ?? null);
      return;
    }
    const valueType =
      value === null
        ? BOOL
        : value.kind === 'StringLiteral'
          ? STRING
          : this.checkValue(value, type);
    this.expectAssignable(valueType, type, value ?? attribute, ` for "${name}" of <${component}>`);
  }

  /**
   * The component's code is inlined where it is used, so the names of the module that it uses
   * must not be hidden there by local declarations.
   */
  private checkHygiene(info: ComponentInfo, tag: ast.Identifier): void {
    info.freeNames ??= freeNames(info.node);
    for (const name of info.freeNames) {
      if (this.lookupValue(name) !== lookupIn(this.moduleScope, name)) {
        this.error(
          `<${tag.name}> uses "${name}" of the module, but here "${name}" is another declaration: rename one of them`,
          tag,
        );
        return;
      }
    }
  }

  /** The type of `<Card />`: what its markup creates. */
  private componentResult(info: ComponentInfo, seen: Set<ComponentInfo>): Type {
    seen.add(info);
    // With early returns, the result is what all the returned elements have in common.
    const types = ownStatements(info.node.body)
      .filter((statement) => statement.kind === 'ReturnStatement')
      .map((statement) => this.markupType(statement.values[0], seen));
    const [first] = types;
    if (first === undefined) return NODE;
    if (types.every((type) => typesEqual(type, first))) return first;
    return types.every((type) => isAssignable(type, HTML_ELEMENT)) ? HTML_ELEMENT : NODE;
  }

  /** The type of the markup a component returns, found without checking it again. */
  private markupType(value: ast.Expression | undefined, seen: Set<ComponentInfo>): Type {
    if (value?.kind !== 'ElementExpression') return NODE;
    if (value.tag === null) return DOCUMENT_FRAGMENT;
    if (!/^[A-Z]/.test(value.tag.name)) return elementType(value.tag.name);
    const other = lookupIn(this.moduleScope, value.tag.name)?.component;
    if (!other || seen.has(other)) return NODE;
    return this.componentResult(other, new Set(seen));
  }

  /**
   * A component may use itself, but some use on the cycle must be under a condition (if, for, a
   * branch of `?:`...), or creating the component never ends.
   */
  private checkEndlessRecursion(): void {
    const components = new Map<string, ast.ComponentDeclaration>();
    for (const statement of this.program.body) {
      if (statement.kind === 'ComponentDeclaration') components.set(statement.name.name, statement);
    }
    for (const { cycle, tag } of endlessRecursion(components)) {
      this.error(
        `endless recursion: ${cycle.join(' → ')} always creates itself again; put the use inside if or for`,
        tag,
      );
    }
  }

  // ─── Member access and calls ───────────────────────────────────────────────────────────────────

  /**
   * Member access, indexing and calls. Returns the type and whether an optional link (`?.`)
   * may short-circuit the chain: `a?.b.c()` is null as a whole when `a` is null.
   */
  private checkChain(
    node: ast.MemberExpression | ast.IndexExpression | ast.CallExpression,
  ): [Type, boolean] {
    if (node.kind === 'CallExpression') {
      if (node.callee.kind === 'SuperExpression') return [this.checkSuperCall(node), false];
      let [callee, shortCircuits] = this.chainPart(node.callee);
      if (isNullable(callee)) {
        if (node.optional) shortCircuits = true;
        else this.nullError(node.callee);
        callee = nonNull(callee);
      }
      return [this.checkCall(node, callee), shortCircuits];
    }

    let [object, shortCircuits] =
      node.object.kind === 'SuperExpression'
        ? [this.superType(node.object), false]
        : this.chainPart(node.object);
    if (isNullable(object)) {
      if (node.optional) shortCircuits = true;
      else this.nullError(node.object);
      object = nonNull(object);
    }

    if (node.kind === 'MemberExpression') {
      const member = this.findMember(object, node.property.name, node.property);
      return [member === 'any' ? ANY : (member?.type ?? UNKNOWN), shortCircuits];
    }
    this.expectIndex(node.index);
    if (object.kind === 'array') return [object.element, shortCircuits];
    if (object.kind === 'string') return [STRING, shortCircuits];
    if (isUntyped(object)) return [object, shortCircuits];
    this.error(`cannot index ${typeToString(object)}`, node);
    return [UNKNOWN, shortCircuits];
  }

  private chainPart(node: ast.Expression): [Type, boolean] {
    if (
      node.kind === 'MemberExpression' ||
      node.kind === 'IndexExpression' ||
      node.kind === 'CallExpression'
    ) {
      const [type, shortCircuits] = this.checkChain(node);
      return [this.single(type, node), shortCircuits];
    }
    return [this.checkValue(node), false];
  }

  /** The value of an object that must not be null, e.g. before a member assignment. */
  private nonNullValue(node: ast.Expression): Type {
    const [type] = this.chainPart(node);
    if (isNullable(type)) this.nullError(node);
    return nonNull(type);
  }

  private expectIndex(node: ast.Expression): void {
    const type = this.checkValue(node, NUMBER);
    if (!isNumeric(type)) this.error(`index must be a number, not ${typeToString(type)}`, node);
  }

  /** The member `name` of a value of type `object`; `'any'` for untyped values. */
  private findMember(object: Type, name: string, node: ast.NodeBase): Member | 'any' | undefined {
    let member: Member | undefined;
    switch (object.kind) {
      case 'any':
      case 'unknown':
      case 'never':
        return 'any';
      case 'literal':
        return this.findMember(literalBase(object), name, node);
      case 'union': {
        // A member of a union is one that every type in it has.
        const found = object.types.map((type) => this.memberOf(type, name));
        if (found.includes('any')) return 'any';
        const members = found.filter((each): each is Member => each !== undefined);
        if (members.length < found.length) {
          this.error(
            `${typeToString(object)} has no member "${name}" in every type: narrow it with typeof or instanceof`,
            node,
          );
          return undefined;
        }
        return {
          type: union(members.map((each) => each.type)),
          method: members.every((each) => each.method),
          visibility: 'public',
          owner: null,
        };
      }
      case 'number':
        member = numberMember(name);
        break;
      case 'string':
        member = stringMember(name);
        break;
      case 'bool':
        member = boolMember(name);
        break;
      case 'array':
        member = arrayMember(object.element, name);
        break;
      case 'object':
        member = object.members.get(name);
        break;
      case 'class':
        this.ensureClassResolved(object.info);
        member = findClassMember(object.info, name, false);
        if (!member && hasUntypedBase(object.info)) return 'any';
        break;
      case 'classValue':
        this.ensureClassResolved(object.info);
        member = findClassMember(object.info, name, true);
        if (!member && hasUntypedBase(object.info)) return 'any';
        break;
      default:
        break;
    }
    if (!member) {
      this.error(`${typeToString(object)} has no member "${name}"`, node);
      return undefined;
    }
    const { owner, visibility } = member;
    if (owner && visibility !== 'public') {
      const current = this.cls?.info;
      const allowed =
        visibility === 'private'
          ? current === owner
          : current !== undefined && isSubclass(current, owner);
      if (!allowed) this.error(`"${name}" is ${visibility} in ${owner.name}`, node);
    }
    return member;
  }

  /** The public member `name` of a type, without reporting anything; for members of unions. */
  private memberOf(type: Type, name: string): Member | 'any' | undefined {
    switch (type.kind) {
      case 'any':
      case 'unknown':
      case 'never':
        return 'any';
      case 'literal':
        return this.memberOf(literalBase(type), name);
      case 'number':
        return numberMember(name);
      case 'string':
        return stringMember(name);
      case 'bool':
        return boolMember(name);
      case 'array':
        return arrayMember(type.element, name);
      case 'object':
        return type.members.get(name);
      case 'class': {
        this.ensureClassResolved(type.info);
        const member = findClassMember(type.info, name, false);
        if (!member && hasUntypedBase(type.info)) return 'any';
        return member?.visibility === 'public' ? member : undefined;
      }
      default:
        return undefined;
    }
  }

  private checkCall(node: ast.CallExpression, callee: Type): Type {
    if (isUntyped(callee)) {
      this.checkArgumentsLoosely(node.arguments);
      return callee;
    }
    if (callee.kind === 'classValue') {
      this.error(`use "new ${callee.info.name}(...)" to create a ${callee.info.name}`, node);
      this.checkArgumentsLoosely(node.arguments);
      return callee.info.instance;
    }
    const signature = callSignature(callee);
    if (!signature) {
      this.error(`${typeToString(callee)} cannot be called`, node.callee);
      this.checkArgumentsLoosely(node.arguments);
      return UNKNOWN;
    }
    const results = this.checkArguments(signature, node.arguments, node);
    if (results.length === 0) return VOID;
    if (results.length === 1) return results[0]!;
    return { kind: 'tuple', types: results };
  }

  private checkSuperCall(node: ast.CallExpression): Type {
    const info = this.cls?.info;
    if (!info || !this.fn?.isConstructor) {
      this.error('"super(...)" can only be called in a constructor', node);
      this.checkArgumentsLoosely(node.arguments);
      return VOID;
    }
    if (!info.superClass) {
      if (!hasUntypedBase(info)) this.error(`class "${info.name}" has no base class`, node);
      this.checkArgumentsLoosely(node.arguments);
      return VOID;
    }
    this.checkArguments(constructorOf(info.superClass).type, node.arguments, node);
    return VOID;
  }

  private checkNew(node: ast.NewExpression): Type {
    const callee = this.checkValue(node.callee);
    if (isUntyped(callee)) {
      this.checkArgumentsLoosely(node.arguments);
      return callee;
    }
    if (callee.kind !== 'classValue') {
      this.error(`${typeToString(callee)} is not a class`, node.callee);
      this.checkArgumentsLoosely(node.arguments);
      return UNKNOWN;
    }
    const { info } = callee;
    this.ensureClassResolved(info);
    const { type, owner } = constructorOf(info);
    if (owner && owner.ctorVisibility !== 'public') {
      const current = this.cls?.info;
      const allowed =
        owner.ctorVisibility === 'private'
          ? current === owner
          : current !== undefined && isSubclass(current, owner);
      if (!allowed) {
        this.error(`the constructor of ${owner.name} is ${owner.ctorVisibility}`, node);
      }
    }
    this.checkArguments(type, node.arguments, node);
    return info.instance;
  }

  private checkArgumentsLoosely(args: readonly (ast.Expression | ast.SpreadElement)[]): void {
    for (const arg of args) this.checkValue(arg.kind === 'SpreadElement' ? arg.argument : arg, ANY);
  }

  /** Checks call arguments against a signature and returns the result types. */
  private checkArguments(
    signature: FunctionType,
    args: readonly (ast.Expression | ast.SpreadElement)[],
    node: ast.NodeBase,
  ): Type[] {
    const inferred = new Map<TypeParam, Type>();
    const hasSpread = args.some((arg) => arg.kind === 'SpreadElement');
    if (!hasSpread) {
      if (args.length < signature.required) {
        this.error(
          `not enough arguments: expected ${signature.required}, got ${args.length}`,
          node,
        );
      } else if (args.length > signature.params.length && signature.rest === null) {
        this.error(
          `too many arguments: expected ${signature.params.length}, got ${args.length}`,
          args[signature.params.length]!,
        );
      }
    }

    // Arrow functions without parameter types are checked last: their parameter types may depend
    // on type parameters inferred from the other arguments (e.g. `reduce(f, initial)`).
    const needsContext = (arg: ast.Expression | ast.SpreadElement) =>
      arg.kind === 'ArrowFunction' && arg.params.some((param) => param.type === null);
    for (const contextPass of [false, true]) {
      args.forEach((arg, i) => {
        if (needsContext(arg) !== contextPass) return;
        if (arg.kind === 'SpreadElement') {
          const type = this.checkValue(arg.argument);
          if (isUntyped(type)) return;
          if (type.kind !== 'array') {
            this.error(`cannot spread ${typeToString(type)}: it is not an array`, arg.argument);
          } else if (signature.rest === null) {
            this.error('a spread argument needs a "...rest" parameter', arg);
          } else {
            this.expectAssignable(type.element, signature.rest, arg.argument);
          }
          return;
        }
        const param = signature.params[i] ?? signature.rest;
        if (!param) {
          this.checkValue(arg);
          return;
        }
        const type = this.checkValue(arg, substitute(param, inferred));
        inferTypeParams(param, type, inferred);
        this.expectAssignable(type, substitute(param, inferred), arg, ` in argument ${i + 1}`);
      });
    }
    return signature.results.map((result) => substitute(result, inferred, UNKNOWN));
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────────────────────────

/** A binding as seen from a scope and its parents. */
function lookupIn(scope: Scope, name: string): Binding | undefined {
  for (let current: Scope | null = scope; current; current = current.parent) {
    const binding = current.values.get(name);
    if (binding) return binding;
  }
  return undefined;
}

/** Return and defer statements of a body, not counting those of nested functions. */
function ownStatements(body: ast.BlockStatement): ast.Statement[] {
  const found: ast.Statement[] = [];
  const visit = (node: ast.Node): void => {
    if (node.kind === 'ReturnStatement' || node.kind === 'DeferStatement') found.push(node);
    if (
      node.kind === 'FuncDeclaration' ||
      node.kind === 'FuncExpression' ||
      node.kind === 'ArrowFunction' ||
      node.kind === 'ClassDeclaration'
    )
      return;
    forEachChild(node, visit);
  };
  forEachChild(body, visit);
  return found;
}

/** Names a component uses as values but does not declare: those come from the module. */
function freeNames(component: ast.ComponentDeclaration): Set<string> {
  const used = new Set<string>();
  const declared = new Set<string>(component.params.map((param) => param.name.name));
  const visit = (node: ast.Node | null): void => {
    if (node === null) return;
    switch (node.kind) {
      case 'Identifier':
        used.add(node.name);
        return;
      case 'MemberExpression':
        visit(node.object);
        return;
      case 'Property':
        visit(node.value);
        return;
      case 'ElementExpression':
        // Tags are not values: components are found by the generator itself.
        node.attributes.forEach(visit);
        node.children.forEach(visit);
        return;
      case 'JsxAttribute':
        visit(node.value);
        return;
      case 'EventHandler':
        declared.add('event');
        node.body.forEach(visit);
        return;
      case 'VariableDeclaration':
        for (const name of node.names) declared.add(name.name);
        node.values.forEach(visit);
        return;
      case 'FuncDeclaration':
      case 'ClassDeclaration':
        declared.add(node.name.name);
        forEachChild(node, visit);
        return;
      case 'Parameter':
        declared.add(node.name.name);
        visit(node.defaultValue);
        return;
      case 'ForInStatement':
        declared.add(node.value.name);
        if (node.key) declared.add(node.key.name);
        visit(node.iterable);
        visit(node.body);
        return;
      case 'CatchClause':
        if (node.param) declared.add(node.param.name);
        visit(node.body);
        return;
      case 'TypeReference':
      case 'ArrayType':
      case 'NullableType':
      case 'FuncType':
      case 'ObjectType':
      case 'UnionType':
      case 'LiteralType':
        return;
      default:
        forEachChild(node, visit);
    }
  };
  component.params.forEach(visit);
  visit(component.body);
  return new Set([...used].filter((name) => !declared.has(name)));
}

/** Values that can be element children: text, numbers, nodes, lists of them, or null. */
function isContent(type: Type): boolean {
  if (type === CONTENT) return true;
  switch (type.kind) {
    case 'string':
    case 'number':
    case 'any':
    case 'unknown':
    case 'never':
    case 'null':
      return true;
    case 'nullable':
      return isContent(type.type);
    case 'array':
      return isContent(type.element);
    case 'object':
    case 'class':
      return isAssignable(type, NODE);
    default:
      return false;
  }
}

/** Values that setAttribute accepts: text, numbers, bools, or null to leave it out. */
function isAttributeValue(type: Type): boolean {
  const value = nonNull(type);
  return (
    isUntyped(value) ||
    value.kind === 'string' ||
    value.kind === 'number' ||
    value.kind === 'bool' ||
    value.kind === 'null' ||
    value.kind === 'never'
  );
}

function isUntyped(type: Type): boolean {
  return type.kind === 'any' || type.kind === 'unknown';
}

function isNumeric(type: Type): boolean {
  return type.kind === 'number' || isUntyped(type);
}

function callSignature(type: Type): FunctionType | null {
  if (type.kind === 'function') return type;
  if (type.kind === 'object') return type.call;
  if (type.kind === 'union') {
    // A union of functions can be called when they all accept and give the same: `x.toString()`.
    const signatures = type.types.map(callSignature);
    const [first] = signatures;
    const same = signatures.every(
      (each) =>
        each !== null &&
        first !== null &&
        first !== undefined &&
        isAssignable(each, first) &&
        isAssignable(first, each),
    );
    return same ? (first ?? null) : null;
  }
  return null;
}

/** Whether the expected type has literal members: then a literal gets a literal type. */
function expectsLiteral(expected: Type | null): boolean {
  return (
    expected !== null && unionMembers(nonNull(expected)).some((type) => type.kind === 'literal')
  );
}

/** What `typeof` gives for every value of a type, or `null` when it may give several things. */
function typeofTag(type: Type): string | null {
  switch (type.kind) {
    case 'string':
    case 'number':
      return type.kind;
    case 'bool':
      return 'boolean';
    case 'literal':
      return typeof type.value;
    case 'function':
    case 'classValue':
      return 'function';
    case 'object':
      return type.call ? 'function' : 'object';
    case 'class':
    case 'array':
    case 'tuple':
    case 'null':
      return 'object';
    default:
      return null;
  }
}

/** The type after `typeof x == tag` is found true (`matches`) or false. */
function narrowByTypeof(type: Type, tag: string, matches: boolean): Type | null {
  const base = nonNull(type);
  if (base.kind === 'any' || base.kind === 'unknown') {
    if (!matches) return null;
    return tag === 'string' ? STRING : tag === 'number' ? NUMBER : tag === 'boolean' ? BOOL : null;
  }
  const kept = unionMembers(base).filter((member) => {
    const memberTag = typeofTag(member);
    return memberTag === null || (memberTag === tag) === matches;
  });
  // typeof null is "object".
  const keepsNull = isNullable(type) && (tag === 'object') === matches;
  return union(keepsNull ? [...kept, NULL] : kept);
}

/** `"all"`, `42` or `true` written in the code: its value, or `undefined` for other expressions. */
function literalValue(node: ast.Expression): string | number | boolean | undefined {
  switch (node.kind) {
    case 'StringLiteral':
    case 'NumberLiteral':
    case 'BooleanLiteral':
      return node.value;
    default:
      return undefined;
  }
}

/** A type without one literal value: what is left after `x != "all"`. */
function withoutLiteral(type: Type, value: string | number | boolean): Type {
  const kept = unionMembers(nonNull(type)).filter(
    (member) => !(member.kind === 'literal' && member.value === value),
  );
  return union(isNullable(type) ? [...kept, NULL] : kept);
}

function countValues(count: number): string {
  if (count === 0) return 'no values';
  return count === 1 ? '1 value' : `${count} values`;
}

/** How to name an expression in messages: `divide()`, `stats.minMax()`, or `this expression`. */
function callName(node: ast.Expression): string {
  if (node.kind !== 'CallExpression') return 'this expression';
  const { callee } = node;
  if (callee.kind === 'Identifier') return `${callee.name}()`;
  if (callee.kind === 'MemberExpression') {
    const object = callee.object.kind === 'Identifier' ? `${callee.object.name}.` : '';
    return `${object}${callee.property.name}()`;
  }
  return 'this call';
}

function withNarrowing(flow: Flow, narrowing: Narrowing): Flow {
  const result = new Map(flow);
  for (const [binding, type] of narrowing) result.set(binding, type);
  return result;
}

/** Narrowing that holds after both branches: the variables narrowed the same way in both. */
function mergeFlows(a: Flow, b: Flow): Flow {
  const result: Flow = new Map();
  for (const [binding, type] of a) {
    const other = b.get(binding);
    if (other && typesEqual(type, other)) result.set(binding, type);
  }
  return result;
}

/** Go's terminating statements: execution never continues after them. */
function isTerminating(node: ast.Statement): boolean {
  switch (node.kind) {
    case 'ReturnStatement':
    case 'ThrowStatement':
      return true;
    case 'BlockStatement': {
      const last = node.body.at(-1);
      return last !== undefined && isTerminating(last);
    }
    case 'IfStatement':
      return (
        node.alternate !== null && isTerminating(node.consequent) && isTerminating(node.alternate)
      );
    case 'ForStatement':
      return node.condition === null && !containsBreak(node.body.body);
    case 'SwitchStatement':
      return (
        node.cases.some((switchCase) => switchCase.tests.length === 0) &&
        node.cases.every((switchCase) => {
          const last = switchCase.body.at(-1);
          return last !== undefined && isTerminating(last) && !containsBreak(switchCase.body);
        })
      );
    case 'TryStatement':
      return (
        (isTerminating(node.block) && (!node.handler || isTerminating(node.handler.body))) ||
        (node.finalizer !== null && isTerminating(node.finalizer))
      );
    default:
      return false;
  }
}

/** Whether execution never continues after the statement, counting `break` and `continue`. */
function leaves(node: ast.Statement): boolean {
  switch (node.kind) {
    case 'BreakStatement':
    case 'ContinueStatement':
      return true;
    case 'BlockStatement': {
      const last = node.body.at(-1);
      return last !== undefined && leaves(last);
    }
    case 'IfStatement':
      return node.alternate !== null && leaves(node.consequent) && leaves(node.alternate);
    default:
      return isTerminating(node);
  }
}

function isSuperCall(statement: ast.Statement): boolean {
  return (
    statement.kind === 'ExpressionStatement' &&
    statement.expression.kind === 'CallExpression' &&
    statement.expression.callee.kind === 'SuperExpression'
  );
}

/** `this.name = ...` at the top level of a constructor. */
function assignsField(body: ast.BlockStatement, name: string): boolean {
  return body.body.some(
    (statement) =>
      statement.kind === 'AssignmentStatement' &&
      statement.targets.some(
        (target) =>
          target.kind === 'MemberExpression' &&
          target.object.kind === 'ThisExpression' &&
          target.property.name === name,
      ),
  );
}
