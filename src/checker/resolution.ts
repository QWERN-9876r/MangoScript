import type * as ast from '../ast.ts';
import { ClassChecker } from './classes.ts';
import type { AliasEntry } from './context.ts';
import {
  arrayOf,
  bindParams,
  classInstance,
  func,
  instantiate,
  isAssignable,
  literal,
  nullable,
  substitute,
  typeToString,
  union,
  UNKNOWN,
  type ObjectType,
  type Type,
} from './types.ts';

// Type annotations as types: names, aliases, generics with their arguments; and the type a variable gets from its value.

export abstract class TypeResolver extends ClassChecker {
  protected override resolveType(node: ast.TypeNode): Type {
    switch (node.kind) {
      case 'TypeReference':
        return this.resolveTypeName(node.name, node.typeArgs);
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

  protected override resolveTypeName(
    name: ast.Identifier,
    typeArgs: readonly ast.TypeNode[] = [],
  ): Type {
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
    const args = typeArgs.map((arg) => this.resolveType(arg));
    const type = entry.kind === 'alias' ? this.resolveAlias(entry) : entry;
    const params =
      entry.kind === 'alias'
        ? entry.params
        : type.kind === 'object'
          ? (type.typeParams ?? [])
          : type.kind === 'class'
            ? type.info.typeParams
            : [];
    if (params.length === 0) {
      if (args.length > 0) this.error(`"${name.name}" is not generic`, typeArgs[0]!);
      return type;
    }
    // Parameters with defaults (from a `.d.ts`) may be left out: `Buffer` is `Buffer[ArrayBufferLike]`.
    const required = params.filter((param) => !param.default).length;
    if (args.length >= required && args.length < params.length) {
      args.push(...params.slice(args.length).map((param) => param.default!));
    }
    if (args.length !== params.length) {
      this.error(
        args.length === 0
          ? `"${name.name}" needs type arguments: ${name.name}[${params.map((param) => param.name).join(', ')}]`
          : `"${name.name}" takes ${params.length} type argument${params.length === 1 ? '' : 's'}, got ${args.length}`,
        name,
      );
      return UNKNOWN;
    }
    params.forEach((param, i) => {
      if (param.constraint && !isAssignable(args[i]!, param.constraint)) {
        this.error(
          `${typeToString(args[i]!)} does not satisfy the constraint ${typeToString(param.constraint)} of ${param.name}`,
          typeArgs[i]!,
        );
      }
    });
    if (type.kind === 'class') return classInstance(type.info, args);
    if (type.kind === 'object' && type.typeParams) return instantiate(type, args);
    return substitute(type, bindParams(params, args));
  }

  protected override resolveAlias(entry: AliasEntry): Type {
    if (entry.resolved) return entry.resolved;
    const { node } = entry;
    if (entry.resolving) {
      this.error(`type "${node.name.name}" refers to itself`, node.name);
      return UNKNOWN;
    }
    const saved = this.scope;
    this.scope = entry.scope;
    try {
      return this.withTypeParams(entry.params, node.typeParams, () => this.resolveAliasType(entry));
    } finally {
      entry.resolving = false;
      this.scope = saved;
    }
  }

  protected resolveAliasType(entry: AliasEntry): Type {
    const { node } = entry;
    if (node.type.kind === 'ObjectType') {
      // Registered before its members, so that they can refer to the type itself.
      const object: ObjectType = {
        kind: 'object',
        name: node.name.name,
        members: new Map(),
        call: null,
      };
      if (entry.params.length > 0) object.typeParams = entry.params;
      entry.resolved = object;
      this.fillMembers(object, node.type.members);
      return object;
    }
    entry.resolving = true;
    const resolved = this.resolveType(node.type);
    // A union keeps the alias name for messages: `cannot use "activ" as Filter`.
    entry.resolved = resolved.kind === 'union' ? { ...resolved, name: node.name.name } : resolved;
    return entry.resolved;
  }

  /** The type of a variable initialized with a value of type `type`. */
  protected override inferredType(type: Type, node: ast.Expression): Type {
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
}
