import {
  ANY,
  BOOL,
  literal,
  NEVER,
  NULL,
  nullable,
  NUMBER,
  STRING,
  union,
  VOID,
  type ClassInfo,
  type ObjectType,
  type Type,
  type TypeParam,
} from '../checker/types.ts';
import type * as TS from 'typescript';

// Types of TypeScript declarations as MangoScript types. Members are converted when they are
// first used (see LazyMap): @types/node has thousands of them, and a program touches a few.
//
// What has no counterpart becomes `any`: bigint, symbol, `object`, `unknown`, and the conditional
// and mapped types that TypeScript itself cannot reduce. Index signatures give `index` to objects.

/**
 * Types of declarations in TypeScript's lib files and in `node_modules`, by file and name. These
 * files do not change while the compiler runs, so the converters of later programs (a program is
 * created again when an import adds a file) reuse the types of the first one. Otherwise the same
 * `Node` of lib.dom would be two different types, and checking that one fits the other would go
 * through the whole DOM.
 */
export type SharedTypes = Map<string, Type | ClassInfo>;

// The converter is a chain of layers: base (this one: primitives, unions, type parameters) → objects
// (interfaces, classes, signatures) → TypeConverter (convert.ts: the exports of modules).

export abstract class ConverterBase {
  // Implemented by later layers: the checking of statements, expressions and markup calls each other.

  protected abstract object(
    type: TS.Type,
    name: string | null,
    typeParams?: TypeParam[],
  ): ObjectType;

  protected abstract objectType(type: TS.ObjectType): Type;

  protected readonly ts: typeof TS;

  protected readonly program: TS.Program;

  protected readonly checker: TS.TypeChecker;

  protected readonly types = new Map<TS.Type, Type>();

  /** Types being converted: a function type that refers to itself becomes `any` inside. */
  protected readonly converting = new Set<TS.Type>();

  protected readonly params = new Map<TS.Type, TypeParam>();

  protected readonly classes = new Map<TS.Symbol, ClassInfo>();

  protected readonly shared: SharedTypes;

  protected arrayInterface: ObjectType | undefined;

  constructor(ts: typeof TS, program: TS.Program, shared: SharedTypes = new Map()) {
    this.ts = ts;
    this.program = program;
    this.checker = program.getTypeChecker();
    this.shared = shared;
  }

  /** The key of a declaration that does not change between programs, or `null`. */
  protected sharedKey(symbol: TS.Symbol, kind: string): string | null {
    const declarations = symbol.declarations ?? [];
    if (declarations.length === 0) return null;
    const stable = declarations.every((declaration) => {
      const file = declaration.getSourceFile();
      return (
        this.program.isSourceFileDefaultLibrary(file) ||
        this.program.isSourceFileFromExternalLibrary(file)
      );
    });
    if (!stable) return null;
    const file = declarations[0]!.getSourceFile().fileName;
    return `${kind} ${file} ${this.checker.getFullyQualifiedName(symbol)}`;
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

  protected convertType(type: TS.Type): Type {
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
  protected union(types: readonly TS.Type[]): Type {
    const { TypeFlags } = this.ts;
    const empty = (type: TS.Type) =>
      (type.flags & (TypeFlags.Null | TypeFlags.Undefined | TypeFlags.Void)) !== 0;
    const rest = types.filter((type) => !empty(type)).map((type) => this.convert(type));
    if (rest.length === 0) return NULL;
    const result = union(rest);
    return types.some(empty) ? nullable(result) : result;
  }

  protected typeParamOrThis(type: TS.Type): Type {
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
  protected typeParam(type: TS.Type): TypeParam {
    let param = this.params.get(type);
    if (!param) {
      param = { kind: 'param', name: type.symbol?.name ?? 'T', constraint: null };
      this.params.set(type, param);
      const fallback = this.checker.getDefaultFromTypeParameter(type);
      if (fallback) param.default = this.convert(fallback);
    }
    return param;
  }

  /** Declared in TypeScript's lib files. */
  protected isLibrary(symbol: TS.Symbol): boolean {
    return (symbol.declarations ?? []).some((declaration) =>
      this.program.isSourceFileDefaultLibrary(declaration.getSourceFile()),
    );
  }
}

/** Members that MangoScript code can name: not `[Symbol.iterator]` and the like. */
export function propertyNames(checker: TS.TypeChecker, type: TS.Type): string[] {
  return checker
    .getPropertiesOfType(type)
    .map((property) => property.name)
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
}
