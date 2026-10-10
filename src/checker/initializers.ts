import type * as ast from '../ast.ts';
import { mentionsName } from '../names.ts';
import type {
  Binding,
  ComponentInfo,
  ClassContext,
  DecoratorInfo,
  Flow,
  FunctionContext,
  Scope,
} from './context.ts';
import { TypeResolver } from './resolution.ts';
import type { TypeParam } from './types.ts';

// Variables used in their own initializer. As in JS, a variable exists from the start of its
// declaration, and a function in the initializer runs after it, so the function can use the
// variable: `const timer = setInterval(() => clearInterval(timer), 1000)`. If the variable's type
// is not written, the body of such a function is checked once the variable has its type; this works
// when the type of the function is known without its body, as for a callback or a `func` literal.
// A use outside of functions reads the variable before it has a value, which is an error.

interface Initializer {
  declaration: ast.VariableDeclaration;
  bindings: Set<Binding>;
  /** Where the variables are declared: a use in this function, not in a nested one, is direct. */
  scope: Scope;
  fn: FunctionContext | null;
  /** Bodies of functions in the initializer that wait for the types of the variables. */
  deferred: (() => void)[];
}

export abstract class InitializerChecker extends TypeResolver {
  /** Initializers being checked, the outermost first. */
  private readonly initializers: Initializer[] = [];

  /**
   * Checks the initializer of `bindings` with `check`, which gives them their types, and then the
   * function bodies in it that waited for those types.
   */
  protected checkInitializer(
    declaration: ast.VariableDeclaration,
    bindings: readonly Binding[],
    check: () => void,
  ): void {
    const initializer: Initializer = {
      declaration,
      bindings: new Set(bindings),
      scope: this.scope,
      fn: this.fn,
      deferred: [],
    };

    this.initializers.push(initializer);
    try {
      check();
    } finally {
      this.initializers.pop();
    }

    for (const body of initializer.deferred) body();
  }

  /**
   * Defers `check`, the check of a function body, if the body mentions a variable that is being
   * initialized and has no type yet. Returns whether it was deferred.
   */
  protected deferBody(body: ast.Node, check: () => void): boolean {
    // The outermost initializer ends last: then every variable the body may use has its type.
    const initializer = this.initializers.find((candidate) => {
      const untyped = [...candidate.bindings].filter((binding) => binding.type === null);

      return untyped.length > 0 && mentionsName(body, new Set(untyped.map(({ name }) => name)));
    });

    if (!initializer) return false;

    const state = this.saveState();

    initializer.deferred.push(() => {
      const current = this.saveState();

      this.restoreState(state);
      try {
        check();
      } finally {
        this.restoreState(current);
      }
    });

    return true;
  }

  /** The error for `binding` used in its own initializer, or `null` if this use is fine. */
  protected initializerError(binding: Binding): string | null {
    const initializer = this.initializers.find((candidate) => candidate.bindings.has(binding));

    if (!initializer) return null;

    const { name } = binding;

    if (initializer.fn === this.fn) {
      const outer = this.lookupFrom(initializer.scope.parent, name);

      return outer
        ? `"${name}" here is the new variable, which has no value yet; give it another name to use the outer "${name}"`
        : `"${name}" is used in its own initializer, before it has a value`;
    }

    if (binding.type !== null) return null;

    const { declaration } = initializer;
    const value = declaration.values[declaration.names.findIndex((id) => id.name === name)];
    const isFunction = value?.kind === 'ArrowFunction' || value?.kind === 'FuncExpression';

    return isFunction
      ? `"${name}" is used in its own initializer: give it a type, e.g. ${declaration.keyword} ${name} func() = ...`
      : `"${name}" is used in its own initializer: write its type after the name`;
  }

  private lookupFrom(scope: Scope | null, name: string): Binding | undefined {
    for (; scope; scope = scope.parent) {
      const binding = scope.values.get(name);

      if (binding) return binding;
    }

    return undefined;
  }

  private saveState(): CheckState {
    return {
      scope: this.scope,
      flow: new Map(this.flow),
      fn: this.fn,
      cls: this.cls,
      inferring: this.inferring,
      component: this.component,
      decorator: this.decorator,
    };
  }

  private restoreState(state: CheckState): void {
    ({
      scope: this.scope,
      flow: this.flow,
      fn: this.fn,
      cls: this.cls,
      inferring: this.inferring,
      component: this.component,
      decorator: this.decorator,
    } = state);
  }
}

/** Where in the program the checker is: what a deferred function body is checked with. */
interface CheckState {
  scope: Scope;
  flow: Flow;
  fn: FunctionContext | null;
  cls: ClassContext | null;
  inferring: ReadonlySet<TypeParam>;
  component: ComponentInfo | null;
  decorator: DecoratorInfo | null;
}
