import type * as ast from '../ast.ts';
import { type BindingKind, type Binding, Scope, type Flow } from './context.ts';
import { ControlFlowChecker } from './control-flow.ts';
import { isUntyped, callSignature, isTerminating } from './helpers.ts';
import {
  commonType,
  containsTypeParam,
  func,
  nonNull,
  UNKNOWN,
  type FunctionType,
  type Type,
} from './types.ts';

// Bodies of functions, arrow functions and func literals, and the results they return.

export abstract class FunctionChecker extends ControlFlowChecker {
  /**
   * Checks a function body and returns its result types: the declared ones, or those inferred from
   * the `return` statements when `results` is `null`.
   */
  protected override checkFunction(
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
      // A generic function: its type parameters are types in its body.
      for (const typeParam of type.typeParams) this.scope.types.set(typeParam.name, typeParam);
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
  protected checkExpressionBody(body: ast.Expression, results: Type[] | null): Type[] {
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

  protected inferResults(returns: Type[][], body: ast.BlockStatement): Type[] {
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

  protected stableFlow(): Flow {
    const flow: Flow = new Map();
    for (const [binding, type] of this.flow) {
      if (binding.kind === 'const' || !this.assigned.has(binding.name)) flow.set(binding, type);
    }
    return flow;
  }

  protected checkArrowFunction(node: ast.ArrowFunction, expected: Type | null): Type {
    const context = expected ? callSignature(nonNull(expected)) : null;
    // Callbacks passed to untyped JS functions get untyped parameters.
    const untypedContext = expected !== null && isUntyped(nonNull(expected));
    const params = node.params.map((param, i) => {
      if (param.type) return this.resolveType(param.type);
      const fromContext = context ? (context.params[i] ?? context.rest) : null;
      if (fromContext && !containsTypeParam(fromContext, this.inferring)) return fromContext;
      if (untypedContext) return nonNull(expected);
      this.error(`cannot infer the type of parameter "${param.name.name}": add a type`, param);
      return UNKNOWN;
    });
    // Known result types from the context are checked; otherwise they are inferred.
    const contextResults =
      context &&
      context.results.length > 0 &&
      !context.results.some((type) => containsTypeParam(type, this.inferring))
        ? context.results
        : null;
    const type = func(params, []);
    const checkBody = () => {
      const inferring = this.inferring;
      this.inferring = new Set();
      try {
        return this.checkFunction(node.params, type, contextResults, node.body, {
          closure: true,
        });
      } finally {
        this.inferring = inferring;
      }
    };
    // In the initializer of a variable that the body uses, the body can wait for the variable's
    // type if the function's type is known without it: from the context, or a callback whose
    // result is not used.
    const knownResults =
      contextResults ?? (untypedContext || context?.results.length === 0 ? [] : null);
    if (knownResults && !params.includes(UNKNOWN) && this.deferBody(node.body, checkBody)) {
      type.results = knownResults;
      return type;
    }
    type.results = checkBody();
    return type;
  }

  protected checkFuncExpression(node: ast.FuncExpression): Type {
    const type = this.signature(node.params, node.results);
    const checkBody = () =>
      this.checkFunction(node.params, type, type.results, node.body, { closure: true });
    if (!this.deferBody(node.body, checkBody)) checkBody();
    return type;
  }
}
