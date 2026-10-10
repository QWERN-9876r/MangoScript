import type * as ast from '../ast.ts';
import { isUntyped, signaturesOf, callSignature } from './helpers.ts';
import { MemberChecker } from './members.ts';
import {
  ANY,
  classInstance,
  constructorOf,
  containsTypeParam,
  func,
  hasUntypedBase,
  inferTypeParams,
  isAssignable,
  isSubclass,
  substitute,
  typeToString,
  UNKNOWN,
  VOID,
  type FunctionType,
  type Type,
  type TypeParam,
} from './types.ts';

// Calls and `new`: overloads, arguments, and the inference of type arguments.

export abstract class CallChecker extends MemberChecker {
  protected override checkCall(
    node: ast.CallExpression,
    callee: Type,
    expected: Type | null = null,
  ): Type {
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

    const { results } = this.checkOverloads(
      signaturesOf(signature),
      node.arguments,
      node,
      expected,
    );

    if (results.length === 0) return VOID;
    if (results.length === 1) return results[0]!;

    return { kind: 'tuple', types: results };
  }

  protected override checkSuperCall(node: ast.CallExpression): Type {
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

  protected override checkNew(node: ast.NewExpression, expected: Type | null = null): Type {
    const callee = this.checkValue(node.callee);

    if (isUntyped(callee)) {
      this.checkArgumentsLoosely(node.arguments);

      return callee;
    }

    if (callee.kind === 'object' && callee.construct) {
      const signatures = signaturesOf(callee.construct);

      return this.checkOverloads(signatures, node.arguments, node, expected).results[0] ?? UNKNOWN;
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

    if (info.typeParams.length === 0) {
      this.checkOverloads(signaturesOf(type), node.arguments, node, null);

      return info.instance;
    }

    // `new Stack[number]()` is not valid syntax: the arguments come from the constructor
    // arguments, or from the expected type, as in `let s Stack[number] = new Stack()`.
    const instance: Type = { kind: 'class', info, args: info.typeParams };
    const signatures = signaturesOf(type).map((signature) =>
      func(signature.params, [instance], {
        required: signature.required,
        ...(signature.rest ? { rest: signature.rest } : {}),
        typeParams: [...new Set([...info.typeParams, ...signature.typeParams])],
      }),
    );
    const { inferred } = this.checkOverloads(signatures, node.arguments, node, expected);

    return classInstance(
      info,
      info.typeParams.map((param) => inferred.get(param) ?? UNKNOWN),
    );
  }

  /**
   * Checks a call of an overloaded function (from a `.d.ts`): the first signature that fits the
   * arguments is used. Signatures that take this many arguments are tried first.
   */
  protected checkOverloads(
    signatures: readonly FunctionType[],
    args: readonly (ast.Expression | ast.SpreadElement)[],
    node: ast.NodeBase,
    expected: Type | null,
  ): { results: Type[]; inferred: Map<TypeParam, Type> } {
    if (signatures.length === 1) {
      const inferred = new Map<TypeParam, Type>();
      const results = this.checkArguments(signatures[0]!, args, node, inferred, expected);

      return { results, inferred };
    }

    const takes = (signature: FunctionType) =>
      args.some((arg) => arg.kind === 'SpreadElement') ||
      (args.length >= signature.required &&
        (args.length <= signature.params.length || signature.rest !== null));
    const ordered = [...signatures.filter(takes), ...signatures.filter((each) => !takes(each))];
    const errors = this.diagnostics.length;

    for (const signature of ordered) {
      const inferred = new Map<TypeParam, Type>();
      const results = this.checkArguments(signature, args, node, inferred, expected);

      if (this.diagnostics.length === errors) return { results, inferred };
      this.diagnostics.length = errors;
    }

    // The same signature may be declared twice, as `fetch` by lib.dom and @types/node.
    const listed = [...new Set(signatures.map(typeToString))];

    this.error(`no overload fits these arguments: ${listed.join('; ')}`, node);
    this.checkArgumentsLoosely(args);

    const results = signatures[0]!.results.map((result) => substitute(result, new Map(), UNKNOWN));

    return { results, inferred: new Map() };
  }

  protected checkArgumentsLoosely(args: readonly (ast.Expression | ast.SpreadElement)[]): void {
    for (const arg of args) this.checkValue(arg.kind === 'SpreadElement' ? arg.argument : arg, ANY);
  }

  /**
   * Checks call arguments against a signature and returns the result types. Type parameters are
   * inferred into `inferred` from the arguments and then from the expected result.
   */
  protected checkArguments(
    signature: FunctionType,
    args: readonly (ast.Expression | ast.SpreadElement)[],
    node: ast.NodeBase,
    inferred = new Map<TypeParam, Type>(),
    expected: Type | null = null,
  ): Type[] {
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
    const inferring = this.inferring;

    this.inferring = new Set(signature.typeParams);

    const errors = this.diagnostics.length;

    try {
      this.checkArgumentList(signature, args, inferred, needsContext);
    } finally {
      this.inferring = inferring;
    }

    if (expected && signature.results.length === 1) {
      inferTypeParams(signature.results[0]!, expected, inferred);
    }

    for (const param of signature.typeParams) {
      if (!inferred.has(param) && param.default) inferred.set(param, param.default);
    }

    // `let xs = empty()`: nothing says what T is. Not reported after errors in the arguments.
    const unknown = signature.typeParams.filter(
      (param) =>
        !inferred.has(param) &&
        signature.results.some((result) => containsTypeParam(result, new Set([param]))),
    );

    if (unknown.length > 0 && this.diagnostics.length === errors) {
      this.error(
        `cannot infer ${unknown.map((param) => param.name).join(', ')}: declare the type of the result`,
        node,
      );
    }

    for (const param of signature.typeParams) {
      const type = inferred.get(param);

      if (type && param.constraint && !isAssignable(type, param.constraint)) {
        this.error(
          `${typeToString(type)} does not satisfy the constraint ${typeToString(param.constraint)} of ${param.name}`,
          node,
        );
      }
    }

    return signature.results.map((result) => substitute(result, inferred, UNKNOWN));
  }

  protected checkArgumentList(
    signature: FunctionType,
    args: readonly (ast.Expression | ast.SpreadElement)[],
    inferred: Map<TypeParam, Type>,
    needsContext: (arg: ast.Expression | ast.SpreadElement) => boolean,
  ): void {
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

        // An expected type with parameters that are not inferred yet would reject the argument:
        // `[1, 2]` for `[]T` is checked on its own, and T is inferred from it.
        const expected = substitute(param, inferred);
        const type = this.checkValue(
          arg,
          arg.kind === 'ArrowFunction' || !containsTypeParam(expected, this.inferring)
            ? expected
            : null,
        );

        inferTypeParams(param, type, inferred);
        this.expectAssignable(type, substitute(param, inferred), arg, ` in argument ${i + 1}`);
      });
    }
  }
}
