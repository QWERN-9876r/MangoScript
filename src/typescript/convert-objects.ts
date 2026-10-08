import {
  ANY,
  arrayOf,
  classInstance,
  createClass,
  func,
  instantiate,
  LazyMap,
  union,
  type ClassInfo,
  type FunctionType,
  type Member,
  type ObjectType,
  type Type,
  type TypeParam,
} from '../checker/types.ts';
import type * as TS from 'typescript';
import { ConverterBase, propertyNames } from './convert-base.ts';

// Object types: arrays and tuples, interfaces and their generic templates, classes, functions with their overloads.

export abstract class ObjectConverter extends ConverterBase {
  protected override objectType(type: TS.ObjectType): Type {
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

  /**
   * `Array<T>` as an interface, for the members of arrays that the built-in types do not list.
   * Elsewhere it is converted to `[]T`.
   */
  arrayTemplate(symbol: TS.Symbol): ObjectType {
    if (!this.arrayInterface) {
      const { checker } = this;
      const type = checker.getDeclaredTypeOfSymbol(symbol) as TS.InterfaceType;
      this.arrayInterface = {
        kind: 'object',
        name: 'Array',
        members: new LazyMap(
          () => propertyNames(checker, type),
          (name) => this.member(type, name, null),
        ),
        call: null,
        typeParams: (type.typeParameters ?? []).map((param) => this.typeParam(param)),
      };
    }
    return this.arrayInterface;
  }

  /** A class or an interface; a generic one is the template its instances are made from. */
  protected declared(type: TS.InterfaceType): Type {
    const { symbol } = type;
    // A value of type `Function` can be called with anything, as in TypeScript.
    if (symbol.name === 'Function' && this.isLibrary(symbol)) return ANY;
    if (symbol.flags & this.ts.SymbolFlags.Class) return this.classInfo(symbol).instance;
    const key = this.sharedKey(symbol, 'interface');
    const known = key === null ? undefined : this.shared.get(key);
    if (known && !('instance' in known)) {
      this.types.set(type, known);
      return known;
    }
    const params = (type.typeParameters ?? []).map((param) => this.typeParam(param));
    const object = this.object(type, symbol.name, params);
    if (key !== null) this.shared.set(key, object);
    return object;
  }

  /**
   * An object type with members converted when used. It is registered before its signatures are
   * converted, since they may refer to it.
   */
  protected override object(
    type: TS.Type,
    name: string | null,
    typeParams: TypeParam[] = [],
  ): ObjectType {
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

  protected member(type: TS.Type, name: string, owner: ClassInfo | null): Member | undefined {
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
  protected signatures(list: readonly TS.Signature[]): FunctionType | null {
    const [first, ...rest] = list.map((signature) => this.signature(signature));
    if (!first) return null;
    if (rest.length > 0) first.overloads = rest;
    return first;
  }

  protected signature(signature: TS.Signature): FunctionType {
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

  protected classInfo(symbol: TS.Symbol): ClassInfo {
    const known = this.classes.get(symbol);
    if (known) return known;
    const key = this.sharedKey(symbol, 'class');
    const shared = key === null ? undefined : this.shared.get(key);
    if (shared && 'instance' in shared) {
      this.classes.set(symbol, shared);
      return shared;
    }
    const { checker } = this;
    const { SymbolFlags, SignatureKind } = this.ts;
    const info = createClass(symbol.name);
    this.classes.set(symbol, info);
    if (key !== null) this.shared.set(key, info);
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
