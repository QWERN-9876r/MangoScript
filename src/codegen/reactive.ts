import type * as ast from '../ast.ts';
import type { Type } from '../checker/types.ts';
import { containsReturn, returnedMarkup } from '../recursion.ts';
import { forEachChild } from '../walk.ts';

// Reactivity of components: which markup depends on which state, and which code changes it.

/** What markup can depend on: a `state` variable, or a property that gets the parent's state. */
export interface Source {
  /** Unique in the module; marks the places that change the source in the generated code. */
  readonly id: number;
  readonly name: string;
  readonly kind: 'state' | 'prop';
  /** The function that brings dependent nodes up to date, e.g. `$$updateCount3`. */
  readonly update: string;
  /** Statements that bring the nodes depending on it up to date. */
  readonly dependents: string[];
  /** Places that change it. */
  readonly writes: Write[];
}

export interface Write {
  /** Whether it may run before the markup exists: in a function of the body, not in a handler. */
  early: boolean;
  /** A dependent it does not need: `bind:` does not update its own element. */
  skip: number | null;
}

const EMPTY: ReadonlySet<Source> = new Set();

/** Array methods that change the array. */
const ARRAY_MUTATORS: ReadonlySet<string> = new Set([
  'copyWithin',
  'fill',
  'pop',
  'push',
  'reverse',
  'shift',
  'sort',
  'splice',
  'unshift',
]);

/** Methods known to only read, for values that are not arrays or whose type is not known. */
const READ_METHODS: ReadonlySet<string> = new Set([
  'at',
  'charAt',
  'concat',
  'endsWith',
  'entries',
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flat',
  'flatMap',
  'forEach',
  'getTime',
  'includes',
  'indexOf',
  'join',
  'keys',
  'lastIndexOf',
  'map',
  'padEnd',
  'padStart',
  'reduce',
  'reduceRight',
  'repeat',
  'replace',
  'replaceAll',
  'slice',
  'some',
  'split',
  'startsWith',
  'substring',
  'toFixed',
  'toISOString',
  'toLocaleDateString',
  'toLocaleString',
  'toLocaleTimeString',
  'toLowerCase',
  'toReversed',
  'toSorted',
  'toSpliced',
  'toString',
  'toUpperCase',
  'trim',
  'trimEnd',
  'trimStart',
  'valueOf',
  'values',
  'with',
]);

/**
 * Where the updates of live markup go: the update functions of a component's state, or the update
 * of a block of `{if ...}` / `{for ...}`.
 */
export interface Live {
  /** Sources whose values an expression reads. */
  dependencies(node: ast.Node): Set<Source>;
  /** Adds a statement that brings a part of the markup up to date when the sources change. */
  depend(sources: ReadonlySet<Source>, statement: string): void;
  /** The index that the next statement for a source gets, for `bind:` to skip its own update. */
  ownIndex(source: Source): number | null;
}

/**
 * A block of markup control flow: a branch of `{if ...}` or the content for one item of
 * `{for ...}`. It is created again when needed, so its updates go into a function of its own,
 * which runs when any source that the block reads changes.
 */
export class Block implements Live {
  readonly statements: string[] = [];
  /** Sources that any statement depends on. */
  readonly sources = new Set<Source>();
  private readonly parent: Live;

  constructor(parent: Live) {
    this.parent = parent;
  }

  dependencies(node: ast.Node): Set<Source> {
    return this.parent.dependencies(node);
  }

  depend(sources: ReadonlySet<Source>, statement: string): void {
    this.statements.push(statement);
    for (const source of sources) this.sources.add(source);
  }

  ownIndex(): null {
    return null;
  }
}

/**
 * The reactivity of one inlined component. The analysis goes by names: a local variable that
 * has the name of a state variable can only cause extra updates, never a missed one.
 */
export class Reactive implements Live {
  readonly sources = new Map<string, Source>();
  /** The function context the body runs in; code in other functions runs later. */
  readonly setup: unknown;
  /** Markup declared at the top level of the body, `const input = <input />`: created once. */
  readonly topLevel = new Set<ast.ElementExpression>();
  /** Variables that refer into a source's value: `for todo in todos`, `todos.map(t => ...)`. */
  private readonly aliases = new Map<string, Set<Source>>();
  /** Local functions: what they read counts where they are mentioned. */
  private readonly functions = new Map<string, ast.Node>();
  /** Local functions that the live markup calls: they run while it is created and updated. */
  private readonly renderFunctions = new Set<ast.Node>();

  constructor(
    component: ast.ComponentDeclaration,
    setup: unknown,
    props: Iterable<string>,
    createSource: (name: string, kind: Source['kind']) => Source,
  ) {
    this.setup = setup;
    for (const name of props) this.sources.set(name, createSource(name, 'prop'));
    // Markup declared after an early return may never be created, so it is not updated.
    let returned = false;
    for (const statement of component.body.body) {
      if (statement.kind === 'VariableDeclaration') {
        for (const name of statement.names) {
          if (statement.keyword === 'state' && name.name !== '_') {
            this.sources.set(name.name, createSource(name.name, 'state'));
          }
        }
        const [value] = statement.values;
        if (statement.names.length === 1 && value?.kind === 'ElementExpression' && !returned) {
          this.topLevel.add(value);
        }
        if (
          statement.keyword === 'const' &&
          statement.names.length === 1 &&
          (value?.kind === 'ArrowFunction' || value?.kind === 'FuncExpression')
        ) {
          this.functions.set(statement.names[0]!.name, value);
        }
      } else if (statement.kind === 'FuncDeclaration') {
        this.functions.set(statement.name.name, statement);
      }
      returned ||= containsReturn(statement);
    }
    this.findAliases(component.body);

    const markup: ast.Node[] = [...this.topLevel, ...returnedMarkup(component)];
    const seen = new Set<string>();
    const visit = (node: ast.Node): void => {
      const names = new Set<string>();
      readNames(node, names);
      for (const name of names) {
        const fn = this.functions.get(name);
        if (!fn || seen.has(name)) continue;
        seen.add(name);
        this.renderFunctions.add(fn);
        visit(fn);
      }
    };
    markup.forEach(visit);
  }

  /** Whether a statement of the body declares a function that the live markup calls. */
  declaresRenderFunction(node: ast.Statement): boolean {
    if (node.kind === 'FuncDeclaration') return this.renderFunctions.has(node);
    const [value] = node.kind === 'VariableDeclaration' ? node.values : [];
    return value !== undefined && this.renderFunctions.has(value);
  }

  depend(sources: ReadonlySet<Source>, statement: string): void {
    for (const source of sources) {
      if (!source.dependents.includes(statement)) source.dependents.push(statement);
    }
  }

  ownIndex(source: Source): number {
    return source.dependents.length;
  }

  /** Sources whose values an expression reads, directly or through local functions. */
  dependencies(node: ast.Node): Set<Source> {
    const found = new Set<Source>();
    const seen = new Set<string>();
    const visit = (node: ast.Node): void => {
      const names = new Set<string>();
      readNames(node, names);
      for (const name of names) {
        if (seen.has(name)) continue;
        seen.add(name);
        const source = this.sources.get(name);
        if (source) found.add(source);
        for (const aliased of this.aliases.get(name) ?? EMPTY) found.add(aliased);
        const fn = this.functions.get(name);
        if (fn) visit(fn);
      }
    };
    visit(node);
    return found;
  }

  /**
   * `state` variables that a statement (or an expression body) changes: by assignment, `++`,
   * or a method that may change the value, such as `push`. Nested blocks and functions are not
   * included: their statements are handled on their own.
   */
  writtenBy(node: ast.Node, typeOf: (node: ast.Expression) => Type | undefined): Set<Source> {
    const found = new Set<Source>();
    const write = (target: ast.Expression) => {
      for (const source of this.rootSources(target)) {
        if (source.kind === 'state') found.add(source);
      }
    };
    const visit = (node: ast.Node): void => {
      switch (node.kind) {
        case 'BlockStatement':
        case 'EventHandler':
        case 'FuncDeclaration':
        case 'FuncExpression':
        case 'ArrowFunction':
        case 'ClassDeclaration':
          return;
        case 'SwitchCase':
          node.tests.forEach(visit);
          return;
        case 'AssignmentStatement':
          node.targets.forEach(write);
          break;
        case 'IncDecStatement':
          write(node.target);
          break;
        case 'CallExpression': {
          const { callee } = node;
          if (
            callee.kind === 'MemberExpression' &&
            mayChange(typeOf(callee.object), callee.property.name)
          ) {
            write(callee.object);
          }
          break;
        }
        default:
          break;
      }
      forEachChild(node, visit);
    };
    visit(node);
    return found;
  }

  /** Sources whose value `node` refers into: `todos`, `todos[i].tags`, `todos.find(...)`. */
  rootSources(node: ast.Expression): ReadonlySet<Source> {
    const name = rootName(node);
    if (name === null) return EMPTY;
    const source = this.sources.get(name);
    return source ? new Set([source]) : (this.aliases.get(name) ?? EMPTY);
  }

  /** Repeats until nothing changes, since an alias of an alias is an alias too. */
  private findAliases(body: ast.BlockStatement): void {
    let changed = true;
    const add = (name: string, sources: ReadonlySet<Source>) => {
      if (name === '_' || this.sources.has(name)) return;
      let set = this.aliases.get(name);
      for (const source of sources) {
        if (set?.has(source)) continue;
        set ??= new Set();
        set.add(source);
        this.aliases.set(name, set);
        changed = true;
      }
    };
    // In markup, a loop index and a `const` change with what they are computed from.
    let inMarkup = false;
    const visit = (node: ast.Node): void => {
      switch (node.kind) {
        case 'JsxStatementContainer': {
          const saved = inMarkup;
          inMarkup = true;
          visit(node.statement);
          inMarkup = saved;
          return;
        }
        case 'FuncExpression':
        case 'ArrowFunction': {
          const saved = inMarkup;
          inMarkup = false;
          forEachChild(node, visit);
          inMarkup = saved;
          return;
        }
        case 'ForInStatement':
          add(node.value.name, this.rootSources(node.iterable));
          if (node.key && inMarkup) add(node.key.name, this.dependencies(node.iterable));
          break;
        case 'VariableDeclaration':
          node.names.forEach((name, i) => {
            const value =
              node.values.length === node.names.length ? node.values[i] : node.values[0];
            if (!value) return;
            add(name.name, this.rootSources(value));
            if (inMarkup) add(name.name, this.dependencies(value));
          });
          break;
        case 'CallExpression': {
          if (node.callee.kind !== 'MemberExpression') break;
          const sources = this.rootSources(node.callee.object);
          if (sources.size === 0) break;
          for (const arg of node.arguments) {
            if (arg.kind === 'ArrowFunction' || arg.kind === 'FuncExpression') {
              for (const param of arg.params) add(param.name.name, sources);
            }
          }
          break;
        }
        default:
          break;
      }
      forEachChild(node, visit);
    };
    while (changed) {
      changed = false;
      visit(body);
    }
  }
}

/** Whether calling `method` may change a value of this type. */
function mayChange(type: Type | undefined, method: string): boolean {
  const known = type?.kind === 'nullable' ? type.type : type;
  switch (known?.kind) {
    case 'string':
    case 'number':
    case 'bool':
      return false;
    case 'array':
      return ARRAY_MUTATORS.has(method);
    default:
      return ARRAY_MUTATORS.has(method) || !READ_METHODS.has(method);
  }
}

/** The variable at the start of `a.b[i].c()`, or `null`. */
function rootName(node: ast.Expression): string | null {
  switch (node.kind) {
    case 'Identifier':
      return node.name;
    case 'MemberExpression':
    case 'IndexExpression':
      return rootName(node.object);
    case 'CallExpression':
      return rootName(node.callee);
    default:
      return null;
  }
}

/** Names whose values a node reads, not counting code that runs on events. */
function readNames(node: ast.Node, names: Set<string>): void {
  switch (node.kind) {
    case 'Identifier':
      names.add(node.name);
      return;
    case 'MemberExpression':
      readNames(node.object, names);
      return;
    case 'Property':
      readNames(node.value, names);
      return;
    case 'ElementExpression':
      for (const attribute of node.attributes) readNames(attribute, names);
      for (const child of node.children) readNames(child, names);
      return;
    case 'JsxAttribute':
      if (node.value !== null && !/^on[A-Z]/.test(node.name.name)) readNames(node.value, names);
      return;
    // Both run later, when the markup exists.
    case 'EventHandler':
    case 'MountStatement':
      return;
    default:
      forEachChild(node, (child) => readNames(child, names));
  }
}
