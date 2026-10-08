import type * as ast from '../ast.ts';
import type { Type } from '../checker/types.ts';
import { htmlTagName } from '../html-tag.ts';
import { recursiveComponents } from '../recursion.ts';
import { assignedNames } from '../walk.ts';
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
}

/** How a function implements its `defer` statements. */
export type DeferMode =
  | 'none'
  // Every `defer` is at the top level of the body: nested try/finally blocks.
  | 'try'
  // Some `defer` is inside an if/loop/switch: a stack of closures run by $$runDeferred.
  | 'stack';

interface FunctionContext {
  deferMode: DeferMode;
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
  protected fn: FunctionContext = { deferMode: 'none', temps: 0, breakTargets: [] };
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
  /** Components of the module, inlined where they are used. */
  protected readonly components = new Map<string, ast.ComponentDeclaration>();
  /**
   * Components that become functions: recursive ones cannot be inlined, and web components
   * (`@html-tag`) create their markup in the element's class.
   */
  protected readonly functionComponents: ReadonlySet<ast.ComponentDeclaration>;
  /** Web components of the module by their tags: `<app-card count={3} />` sets their properties. */
  protected readonly webComponents = new Map<string, ast.ComponentDeclaration>();

  constructor(program: ast.Program, options: JsOptions) {
    this.program = program;
    this.options = options;
    for (const statement of program.body) {
      if (statement.kind === 'TypeAliasDeclaration') {
        this.typeAliases.set(statement.name.name, statement.type);
      } else if (statement.kind === 'ComponentDeclaration') {
        this.components.set(statement.name.name, statement);
      }
    }
    this.assigned = assignedNames(program);
    collectValueNames(program, this.valueNames);
    const functionComponents = recursiveComponents(this.components);
    for (const component of this.components.values()) {
      if (!component.htmlTag) continue;
      functionComponents.add(component);
      this.webComponents.set(htmlTagName(component), component);
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

  protected blankLineBetween(previous: ast.NodeBase, next: ast.NodeBase): boolean {
    return /\n[^\S\n]*\n/.test(this.options.source.slice(previous.end, next.start));
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
    this.fn = { deferMode: mode, temps: 0, breakTargets: [] };
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
