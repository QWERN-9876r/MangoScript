import type * as ast from '../ast.ts';
import type { Type } from '../checker/types.ts';
import { decorate, type DecoratorSource } from '../decorators.ts';
import { htmlTagName } from '../html-tag.ts';
import type { InlinePackage } from '../inline-packages.ts';
import { type ImportedComponent, type LocalizedPackage, localize } from './imported.ts';
import { assignedNames } from '../names.ts';
import { recursiveComponents } from '../recursion.ts';
import { forEachChild } from '../walk.ts';
import { collectValueNames, type BindingKind } from './analysis.ts';
import type { Helper } from './helpers.ts';
import { JS_RESERVED, JS_UNDECLARABLE } from './syntax.ts';

export interface JsOptions {
  /** The MangoScript source, used to keep the blank lines between statements. */
  source: string;
  /** Replace `.mango` with `.js` in relative import paths, for output written next to the sources. */
  rewriteImports: boolean;
  /** Types from the checker, when it ran; without them the generated code is more general. */
  types?: WeakMap<ast.Expression, Type> | undefined;
  /** Decorators imported from other modules, by name: their code is inlined here. */
  decorators?: ReadonlyMap<string, ImportedDecorator> | undefined;
  /** Components imported from other modules, by name: called, or inlined when they are small. */
  components?: ReadonlyMap<string, ImportedComponent> | undefined;
  /** Components of the module that become functions, since inlining them adds too many lines. */
  functions?: ReadonlySet<string> | undefined;
}

/** A decorator of another module, with the types of the expressions of that module. */
export interface ImportedDecorator extends DecoratorSource {
  types: WeakMap<ast.Expression, Type> | null;
  /** The components of that module its code uses, which go with it into the components here. */
  inline: InlinePackage | null;
}

/** How a function implements its `defer` statements. */
export type DeferMode =
  | 'none'
  // Every `defer` is at the top level of the body: nested try/finally blocks.
  | 'try'
  // Some `defer` is inside an if/loop/switch: a stack of closures run by $$runDeferred.
  | 'stack'
  // The body of `effect`: the closures wait for the next run of the effect or its removal.
  | 'effect';

interface FunctionContext {
  deferMode: DeferMode;
  /** Where `defer` puts its closures in 'stack' and 'effect' modes. */
  deferList: string;
  /** Counter for `$$0`, `$$1`, ... temporaries. */
  temps: number;
  /** Innermost last: `null` for loops and switches, a label for a switch compiled to if/else. */
  breakTargets: (string | null)[];
}

/**
 * The base of the JS generator: the output buffer, scopes of declared names and the state of the
 * current function. The generator is split into layers, each adding to the previous one:
 *
 *     Emitter → ExpressionEmitter → StatementEmitter → UpdateEmitter → ElementEmitter
 *       → ControlFlowEmitter → ComponentEmitter → FunctionEmitter → JsGenerator
 */
export abstract class Emitter {
  protected readonly program: ast.Program;
  protected readonly options: JsOptions;
  protected lines: string[] = [];
  private level = 0;

  private readonly scopes: Map<string, BindingKind>[] = [];
  protected fn: FunctionContext = {
    deferMode: 'none',
    deferList: '$$defer',
    temps: 0,
    breakTargets: [],
  };
  /** Helpers that the module must define, such as $$runDeferred. */
  protected readonly helpers = new Set<Helper>();
  /**
   * Whether code for the current expression may be written before the statement that contains it.
   * Elements use this to be created in statements of their own; it is off where an expression is
   * not always evaluated exactly once (branches of `?:`, loop conditions and so on).
   */
  protected hoist = false;

  /** Top-level `type` aliases, to find the zero value of `let id ID`. */
  protected readonly typeAliases = new Map<string, ast.TypeNode>();
  /** Names that are assigned somewhere in the module; others keep their value. */
  protected readonly assigned: Set<string>;
  /** Names used as values; imports used only as types are dropped. */
  protected readonly valueNames = new Set<string>();
  /** Components of the module with their decorators applied, inlined where they are used. */
  protected readonly components = new Map<string, ast.ComponentDeclaration>();
  /**
   * Components that become functions: recursive ones cannot be inlined, and web components
   * (`@html-tag`) create their markup in the element's class.
   */
  protected readonly functionComponents: ReadonlySet<ast.ComponentDeclaration>;
  /** Web components of the module by their tags: `<app-card count={3} />` sets their properties. */
  protected readonly webComponents = new Map<string, ast.ComponentDeclaration>();
  /** The JS functions of components of other modules: `$$Card`, imported from their modules. */
  protected readonly functionNames = new Map<ast.ComponentDeclaration, string>();
  /** The inlined copies of each component and the lines they take, to choose functions (js.ts). */
  readonly inlined = new Map<string, { copies: number; lines: number }>();
  /** The decorators that components of the module apply, by name. */
  protected readonly appliedDecorators = new Set<string>();
  /** Copies of the code of other modules: their positions are in the sources of those. */
  private readonly foreign = new WeakSet<ast.Node>();
  /** Components of other modules inlined here, by name, with what their packages bring. */
  protected readonly inlinedImports = new Map<string, LocalizedPackage>();
  /** The components that decorators of other modules bring, by the names of the decorators. */
  protected readonly decoratorImports = new Map<string, LocalizedPackage>();
  /** Components a package brings: they have no function here, so they are always inlined. */
  readonly alwaysInlined = new Set<string>();

  constructor(program: ast.Program, options: JsOptions) {
    this.program = program;
    this.options = options;

    const decorators = new Map<string, DecoratorSource>(options.decorators);
    const imported = [...(options.decorators?.values() ?? [])];

    for (const statement of program.body) {
      if (statement.kind === 'DecoratorDeclaration') {
        decorators.set(statement.name.name, { node: statement, moduleNames: [] });
      } else if (statement.kind === 'ComponentDeclaration') {
        for (const use of statement.decorators) this.appliedDecorators.add(use.name.name);
      }
    }

    const originals = new WeakSet<ast.Node>();
    const collect = (node: ast.Node): void => {
      originals.add(node);
      forEachChild(node, collect);
    };

    const sources = [...imported, ...(options.components?.values() ?? [])];

    for (const each of imported) collect(each.node);
    for (const each of sources) {
      for (const node of each.inline?.components.values() ?? []) collect(node);
      for (const source of each.inline?.decorators.values() ?? []) collect(source.node);
    }

    // Copies of other modules' code keep the types of the originals, from their own modules.
    const { types } = options;
    const keepType = (copy: ast.Node, original: ast.Node) => {
      const expression = original as ast.Expression;
      const type =
        types?.get(expression) ??
        sources.map((each) => each.types?.get(expression)).find((each) => each !== undefined);

      if (type) types?.set(copy as ast.Expression, type);
      if (originals.has(original) || this.foreign.has(original)) this.foreign.add(copy);
    };

    // The components that a decorator of another module uses come with it, under tags of their own.
    for (const [name, decorator] of options.decorators ?? []) {
      if (!decorator.inline || !this.appliedDecorators.has(name)) continue;

      // Its members cannot hide the names its components use: the checker of its module sees to it.
      const localized = localize(name, name, decorator.inline, keepType);

      this.decoratorImports.set(name, localized);
      decorators.set(name, { ...decorator, tags: localized.tags });
      for (const [tag, node] of localized.inline) {
        this.components.set(tag, node);
        this.alwaysInlined.add(tag);
      }
    }

    for (const statement of program.body) {
      if (statement.kind === 'TypeAliasDeclaration') {
        this.typeAliases.set(statement.name.name, statement.type);
      } else if (statement.kind === 'ComponentDeclaration') {
        this.components.set(statement.name.name, decorate(statement, decorators, keepType));
      }
    }

    // A small component of another module is inlined, unless generateJs chose to call it.
    for (const [name, component] of options.components ?? []) {
      if (!component.inline || options.functions?.has(name)) continue;

      const localized = localize(name, component.node.name.name, component.inline, keepType);

      this.inlinedImports.set(name, localized);
      for (const [tag, node] of localized.inline) {
        this.components.set(tag, node);
        if (tag !== name) this.alwaysInlined.add(tag);
      }
    }

    // Nodes of other modules that were not copied, as names that are not renamed, keep their types.
    const fill = (node: ast.Node): void => {
      const expression = node as ast.Expression;

      if (!types!.has(expression)) {
        const type = sources.map((each) => each.types?.get(expression)).find(Boolean);

        if (type) types!.set(expression, type);
      }

      forEachChild(node, fill);
    };

    if (types && sources.length > 0) {
      for (const component of this.components.values()) fill(component);
    }

    this.assigned = assignedNames(program);
    for (const component of this.components.values()) assignedNames(component, this.assigned);
    collectValueNames(program, this.valueNames);

    const functionComponents = recursiveComponents(this.components);

    for (const component of this.components.values()) {
      // Other modules call an exported component, so it is a function here too.
      if (component.exported) functionComponents.add(component);
      if (!component.htmlTag) continue;
      functionComponents.add(component);
      this.webComponents.set(htmlTagName(component), component);
    }

    for (const name of options.functions ?? []) {
      const component = this.components.get(name);

      if (component) functionComponents.add(component);
    }

    // Other components of other modules are called: their functions are imported.
    const called: [string, { node: ast.ComponentDeclaration; name: string }][] = [
      ...(options.components ?? []),
    ]
      .filter(([name]) => !this.inlinedImports.has(name))
      .map(([name, component]) => [name, { node: component.node, name: `$$${name}` }]);

    for (const localized of [...this.inlinedImports.values(), ...this.decoratorImports.values()]) {
      called.push(...localized.functions);
    }

    for (const [tag, { node, name }] of called) {
      this.components.set(tag, node);
      this.functionNames.set(node, name);
      functionComponents.add(node);
    }

    this.functionComponents = functionComponents;
  }

  // ─── Output ────────────────────────────────────────────────────────────────────────────────────

  protected indent(): string {
    return '  '.repeat(this.level);
  }

  /** Writes a line at the current indentation. Later lines of `text` are already indented. */
  protected line(text: string): void {
    this.lines.push(this.indent() + text);
  }

  protected blankLine(): void {
    if (this.lines.length > 0 && this.lines.at(-1) !== '') this.lines.push('');
  }

  /** Returns the lines written by `emit`, one level deeper than the current one. */
  protected capture(emit: () => void): string[] {
    const saved = this.lines;

    this.lines = [];
    this.level++;
    try {
      emit();

      return this.lines;
    } finally {
      this.level--;
      this.lines = saved;
    }
  }

  /** Renders the lines written by `emit` as a `{ ... }` block, for use inside a line. */
  protected block(emit: () => void): string {
    const inner = this.capture(emit);

    return inner.length === 0 ? '{}' : `{\n${inner.join('\n')}\n${this.indent()}}`;
  }

  protected blankLineBetween(previous: ast.Node, next: ast.Node): boolean {
    if (this.foreign.has(previous) || this.foreign.has(next)) return false;

    return /\n[^\S\n]*\n/.test(this.options.source.slice(previous.end, next.start));
  }

  /** A component of the module as it is inlined: with its decorators applied. */
  protected applied(component: ast.ComponentDeclaration): ast.ComponentDeclaration {
    return this.components.get(component.name.name) ?? component;
  }

  // ─── Scopes and names ──────────────────────────────────────────────────────────────────────────

  protected withScope<T>(bindings: Iterable<[string, BindingKind]>, emit: () => T): T {
    this.scopes.push(new Map(bindings));
    try {
      return emit();
    } finally {
      this.scopes.pop();
    }
  }

  protected lookup(name: string): BindingKind | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const kind = this.scopes[i]!.get(name);

      if (kind !== undefined) return kind;
    }

    return undefined;
  }

  /** The JS name for a MangoScript name. */
  protected name(name: string): string {
    const rename =
      JS_RESERVED.has(name) || (JS_UNDECLARABLE.has(name) && this.lookup(name) !== undefined);

    return rename ? `${name}$` : name;
  }

  /** Whether `error` refers to the predeclared function rather than to a declared name. */
  protected isBuiltinError(node: ast.Expression): boolean {
    return (
      node.kind === 'Identifier' && node.name === 'error' && this.lookup('error') === undefined
    );
  }

  protected params(params: ast.Parameter[]): string {
    // Several `_` parameters would be duplicate names in JS.
    const blanks = params.filter((param) => param.name.name === '_').length;

    return params
      .map((param, i) =>
        param.name.name === '_' && blanks > 1 ? `_${i}` : this.name(param.name.name),
      )
      .join(', ');
  }

  // ─── Functions ─────────────────────────────────────────────────────────────────────────────────

  protected withFunction<T>(mode: DeferMode, params: ast.Parameter[], emit: () => T): T {
    const saved = this.fn;

    this.fn = { deferMode: mode, deferList: '$$defer', temps: 0, breakTargets: [] };
    try {
      return this.withScope(
        params.map((param): [string, BindingKind] => [param.name.name, 'param']),
        emit,
      );
    } finally {
      this.fn = saved;
    }
  }

  protected withHoisting<T>(hoist: boolean, emit: () => T): T {
    const saved = this.hoist;

    this.hoist = hoist;
    try {
      return emit();
    } finally {
      this.hoist = saved;
    }
  }

  /** A fresh temporary name: `$$0`, `$$1`, ... */
  protected temp(): string {
    return `$$${this.fn.temps++}`;
  }

  protected withBreakTarget<T>(label: string | null, emit: () => T): T {
    this.fn.breakTargets.push(label);
    try {
      return emit();
    } finally {
      this.fn.breakTargets.pop();
    }
  }
}
