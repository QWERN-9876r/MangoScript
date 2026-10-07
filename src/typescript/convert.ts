import type * as TS from 'typescript';
import type { ModuleExports } from '../checker/checker.ts';
import {
  ANY,
  arrayOf,
  BOOL,
  classInstance,
  createClass,
  func,
  instantiate,
  LazyMap,
  literal,
  NEVER,
  NULL,
  nullable,
  NUMBER,
  STRING,
  union,
  VOID,
  type ClassInfo,
  type FunctionType,
  type Member,
  type ObjectType,
  type Type,
  type TypeParam,
} from '../checker/types.ts';

// Types of TypeScript declarations as MangoScript types. Members are converted when they are
// first used (see LazyMap): @types/node has thousands of them, and a program touches a few.
//
// What has no counterpart becomes `any`: bigint, symbol, `object`, `unknown`, and the conditional
// and mapped types that TypeScript itself cannot reduce. Index signatures give `index` to objects.

export class TypeConverter {
  private readonly ts: typeof TS;
  private readonly checker: TS.TypeChecker;
  private readonly types = new Map<TS.Type, Type>();
  /** Types being converted: a function type that refers to itself becomes `any` inside. */
  private readonly converting = new Set<TS.Type>();
  private readonly params = new Map<TS.Type, TypeParam>();
  private readonly classes = new Map<TS.Symbol, ClassInfo>();

  constructor(ts: typeof TS, checker: TS.TypeChecker) {
    this.ts = ts;
    this.checker = checker;
  }

  /** The values and types a module exports, converted when they are imported. */
  moduleExports(module: TS.Symbol): ModuleExports {
    const { checker } = this;
    const { SymbolFlags } = this.ts;
    const exported = new Map<string, TS.Symbol>();
    for (const symbol of checker.getExportsOfModule(module)) exported.set(symbol.name, symbol);
    // `export = value` (CommonJS packages, `node:path`): the default import is the value itself,
    // and named imports are its properties.
    const assigned = module.exports?.get(this.ts.InternalSymbolName.ExportEquals);
    if (assigned) {
      if (!exported.has('default')) exported.set('default', assigned);
      const value =
        assigned.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(assigned) : assigned;
      if (value.flags & SymbolFlags.Value) {
        for (const property of checker.getPropertiesOfType(checker.getTypeOfSymbol(value))) {
          if (!exported.has(property.name)) exported.set(property.name, property);
        }
      }
    }
    const target = (name: string) => {
      const symbol = exported.get(name)!;
      return symbol.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    };
    return {
      values: new LazyMap(
        () => exported.keys(),
        (name) => {
          const symbol = target(name);
          return symbol.flags & SymbolFlags.Value ? this.valueOf(symbol) : undefined;
        },
      ),
      types: new LazyMap(
        () => exported.keys(),
        (name) => {
          const symbol = target(name);
          return symbol.flags & SymbolFlags.Type ? this.typeOf(symbol) : undefined;
        },
      ),
    };
  }

  private valueOf(symbol: TS.Symbol): Type {
    if (symbol.flags & this.ts.SymbolFlags.Class) return this.classInfo(symbol).value;
    return this.convert(this.checker.getTypeOfSymbol(symbol));
  }

  private typeOf(symbol: TS.Symbol): Type {
    const { SymbolFlags } = this.ts;
    if (symbol.flags & SymbolFlags.Class) return this.classInfo(symbol).instance;
    const type = this.convert(this.checker.getDeclaredTypeOfSymbol(symbol));
    // `type Pair<A, B> = { ... }` works like a generic interface: `Pair[number, string]`.
    if (symbol.flags & SymbolFlags.TypeAlias && type.kind === 'object' && !type.typeParams) {
      const declaration = symbol.declarations?.find(this.ts.isTypeAliasDeclaration);
      const params = declaration?.typeParameters ?? [];
      if (params.length > 0) {
        return {
          ...type,
          name: symbol.name,
          typeParams: params.map((param) => this.typeParam(this.checker.getTypeAtLocation(param))),
        };
      }
    }
    return type;
  }

  convert(type: TS.Type): Type {
    const known = this.types.get(type);
    if (known) return known;
    if (this.converting.has(type)) return ANY;
    this.converting.add(type);
    try {
      const converted = this.convertType(type);
      this.types.set(type, converted);
      return converted;
    } finally {
      this.converting.delete(type);
    }
  }

  private convertType(type: TS.Type): Type {
    const { TypeFlags } = this.ts;
    const { flags } = type;
    if (flags & (TypeFlags.Any | TypeFlags.Unknown)) return ANY;
    // `boolean` is the union `true | false` in TypeScript.
    if (flags & TypeFlags.Boolean) return BOOL;
    if (flags & TypeFlags.String) return STRING;
    if (flags & TypeFlags.Number) return NUMBER;
    if (flags & TypeFlags.StringLiteral) return literal((type as TS.StringLiteralType).value);
    if (flags & TypeFlags.NumberLiteral) return literal((type as TS.NumberLiteralType).value);
    if (flags & TypeFlags.BooleanLiteral)
      return literal(this.checker.typeToString(type) === 'true');
    if (flags & (TypeFlags.TemplateLiteral | TypeFlags.StringMapping)) return STRING;
    if (flags & (TypeFlags.Void | TypeFlags.Undefined)) return VOID;
    if (flags & TypeFlags.Null) return NULL;
    if (flags & TypeFlags.Never) return NEVER;
    if (flags & TypeFlags.TypeParameter) return this.typeParamOrThis(type);
    if (flags & TypeFlags.Union) return this.union((type as TS.UnionType).types);
    if (flags & TypeFlags.Intersection) return this.object(type, null);
    if (flags & TypeFlags.Object) return this.objectType(type as TS.ObjectType);
    return ANY;
  }

  /** `undefined`, `null` and `void` in a union make it nullable: `string | undefined` is `?string`. */
  private union(types: readonly TS.Type[]): Type {
    const { TypeFlags } = this.ts;
    const empty = (type: TS.Type) =>
      (type.flags & (TypeFlags.Null | TypeFlags.Undefined | TypeFlags.Void)) !== 0;
    const rest = types.filter((type) => !empty(type)).map((type) => this.convert(type));
    if (rest.length === 0) return NULL;
    const result = union(rest);
    return types.some(empty) ? nullable(result) : result;
  }

  private typeParamOrThis(type: TS.Type): Type {
    // `this` in an interface or a class is the type itself.
    if ((type as { isThisType?: boolean }).isThisType) {
      const constraint = type.getConstraint();
      return constraint ? this.convert(constraint) : ANY;
    }
    return this.typeParam(type);
  }

  /**
   * Constraints are not kept: they only matter in the bodies of generic functions, which in a
   * `.d.ts` are not checked, and many have no counterpart. Defaults are kept: `Buffer` is
   * `Buffer[ArrayBufferLike]`.
   */
  private typeParam(type: TS.Type): TypeParam {
    let param = this.params.get(type);
    if (!param) {
      param = { kind: 'param', name: type.symbol?.name ?? 'T', constraint: null };
      this.params.set(type, param);
      const fallback = this.checker.getDefaultFromTypeParameter(type);
      if (fallback) param.default = this.convert(fallback);
    }
    return param;
  }

  private objectType(type: TS.ObjectType): Type {
    const { checker } = this;
    const { ObjectFlags, SymbolFlags, SignatureKind } = this.ts;
    if (checker.isArrayType(type)) {
      const [element] = checker.getTypeArguments(type as TS.TypeReference);
      return arrayOf(element ? this.convert(element) : ANY);
    }
    // A tuple is an array of any of its elements: `[string, number]` is `[](string | number)`.
    if (checker.isTupleType(type)) {
      const elements = checker.getTypeArguments(type as TS.TypeReference);
      return arrayOf(elements.length > 0 ? union(elements.map((each) => this.convert(each))) : ANY);
    }
    if (type.objectFlags & ObjectFlags.Reference) {
      const reference = type as TS.TypeReference;
      const { target } = reference;
      if (target !== reference) {
        // `Box<number>`: the generic declaration with type arguments (without the `this` one).
        const generic = this.declared(target);
        const count = target.typeParameters?.length ?? 0;
        const args = checker
          .getTypeArguments(reference)
          .slice(0, count)
          .map((arg) => this.convert(arg));
        if (generic.kind === 'class') return classInstance(generic.info, args);
        if (generic.kind === 'object' && generic.typeParams) return instantiate(generic, args);
        return generic;
      }
    }
    if (type.objectFlags & (ObjectFlags.Class | ObjectFlags.Interface)) {
      return this.declared(type as TS.InterfaceType);
    }
    // `typeof Foo` of a class: the class itself.
    const symbol = type.getSymbol();
    if (symbol && symbol.flags & SymbolFlags.Class && type.objectFlags & ObjectFlags.Anonymous) {
      return this.classInfo(symbol).value;
    }
    // A function: call signatures and nothing else.
    const calls = checker.getSignaturesOfType(type, SignatureKind.Call);
    if (
      calls.length > 0 &&
      propertyNames(checker, type).length === 0 &&
      checker.getSignaturesOfType(type, SignatureKind.Construct).length === 0
    ) {
      return this.signatures(calls)!;
    }
    return this.object(type, null);
  }

  /** A class or an interface; a generic one is the template its instances are made from. */
  private declared(type: TS.InterfaceType): ClassType | ObjectType {
    const { symbol } = type;
    if (symbol.flags & this.ts.SymbolFlags.Class) return this.classInfo(symbol).instance;
    const params = (type.typeParameters ?? []).map((param) => this.typeParam(param));
    return this.object(type, symbol.name, params);
  }

  /**
   * An object type with members converted when used. It is registered before its signatures are
   * converted, since they may refer to it.
   */
  private object(type: TS.Type, name: string | null, typeParams: TypeParam[] = []): ObjectType {
    const known = this.types.get(type);
    if (known?.kind === 'object') return known;
    const { checker } = this;
    const { SignatureKind, IndexKind } = this.ts;
    const object: ObjectType = {
      kind: 'object',
      name,
      members: new LazyMap(
        () => propertyNames(checker, type),
        (member) => this.member(type, member, null),
      ),
      call: null,
    };
    if (typeParams.length > 0) object.typeParams = typeParams;
    this.types.set(type, object);
    object.call = this.signatures(checker.getSignaturesOfType(type, SignatureKind.Call));
    const construct = this.signatures(checker.getSignaturesOfType(type, SignatureKind.Construct));
    if (construct) object.construct = construct;
    const index = checker.getIndexTypeOfType(type, IndexKind.String);
    if (index) object.index = this.convert(index);
    return object;
  }

  private member(type: TS.Type, name: string, owner: ClassInfo | null): Member | undefined {
    const property = this.checker.getPropertyOfType(type, name);
    if (!property) return undefined;
    const { SymbolFlags, ModifierFlags } = this.ts;
    const modifiers = property.valueDeclaration
      ? this.ts.getCombinedModifierFlags(property.valueDeclaration)
      : 0;
    const visibility: Member['visibility'] =
      modifiers & ModifierFlags.Private
        ? 'private'
        : modifiers & ModifierFlags.Protected
          ? 'protected'
          : 'public';
    return {
      // An optional property already includes `undefined`: `name?: string` is `?string`.
      type: this.convert(this.checker.getTypeOfSymbol(property)),
      method: (property.flags & SymbolFlags.Method) !== 0,
      visibility,
      owner,
    };
  }

  /** The first signature, with the others as its overloads. */
  private signatures(list: readonly TS.Signature[]): FunctionType | null {
    const [first, ...rest] = list.map((signature) => this.signature(signature));
    if (!first) return null;
    if (rest.length > 0) first.overloads = rest;
    return first;
  }

  private signature(signature: TS.Signature): FunctionType {
    const { ts, checker } = this;
    const params: Type[] = [];
    let required = 0;
    let rest: Type | null = null;
    for (const parameter of signature.getParameters()) {
      const declaration = parameter.valueDeclaration;
      const type = checker.getTypeOfSymbol(parameter);
      const isParameter = declaration !== undefined && ts.isParameter(declaration);
      if (isParameter && declaration.dotDotDotToken) {
        const [element] = checker.isArrayType(type)
          ? checker.getTypeArguments(type as TS.TypeReference)
          : [];
        rest = element ? this.convert(element) : ANY;
        break;
      }
      params.push(this.convert(type));
      if (!isParameter || !checker.isOptionalParameter(declaration)) required = params.length;
    }
    const result = this.convert(checker.getReturnTypeOfSignature(signature));
    return func(params, result.kind === 'void' ? [] : [result], {
      required,
      ...(rest ? { rest } : {}),
      typeParams: (signature.getTypeParameters() ?? []).map((param) => this.typeParam(param)),
    });
  }

  private classInfo(symbol: TS.Symbol): ClassInfo {
    const known = this.classes.get(symbol);
    if (known) return known;
    const { checker } = this;
    const { SymbolFlags, SignatureKind } = this.ts;
    const info = createClass(symbol.name);
    this.classes.set(symbol, info);
    const instance = checker.getDeclaredTypeOfSymbol(symbol) as TS.InterfaceType;
    info.typeParams = (instance.typeParameters ?? []).map((param) => this.typeParam(param));
    // TypeScript lists inherited members too, already with the base class's type arguments.
    info.members = new LazyMap(
      () => propertyNames(checker, instance),
      (name) => this.member(instance, name, info),
    );
    const statics = checker.getTypeOfSymbol(symbol);
    info.statics = new LazyMap(
      () => propertyNames(checker, statics).filter((name) => name !== 'prototype'),
      (name) => this.member(statics, name, info),
    );
    const base = checker
      .getBaseTypes(instance)
      .find((type) => type.symbol && type.symbol.flags & SymbolFlags.Class);
    if (base) info.superClass = this.classInfo(base.symbol);
    info.ctor = this.signatures(checker.getSignaturesOfType(statics, SignatureKind.Construct));
    return info;
  }
}

type ClassType = ClassInfo['instance'];

/** Members that MangoScript code can name: not `[Symbol.iterator]` and the like. */
function propertyNames(checker: TS.TypeChecker, type: TS.Type): string[] {
  return checker
    .getPropertiesOfType(type)
    .map((property) => property.name)
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
}
