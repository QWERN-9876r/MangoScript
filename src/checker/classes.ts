import type * as ast from '../ast.ts';
import type { ModuleExports } from './context.ts';
import { DeclarationChecker } from './declarations.ts';
import { isSuperCall, assignsField } from './helpers.ts';
import {
  explainMismatch,
  findClassMember,
  hasZeroValue,
  isAssignable,
  isSubclass,
  typeToString,
  UNKNOWN,
  type ClassInfo,
  type Member,
  type Type,
} from './types.ts';

// Classes: their base class and members, method bodies, overrides and `implements`; and the declarations a module exports.

export abstract class ClassChecker extends DeclarationChecker {
  protected override ensureClassResolved(info: ClassInfo): void {
    const resolve = this.unresolvedClasses.get(info);

    if (!resolve || this.resolvingClasses.has(info)) return;
    this.resolvingClasses.add(info);
    try {
      resolve();
    } finally {
      this.resolvingClasses.delete(info);
      this.unresolvedClasses.delete(info);
    }
  }

  /** Resolves the base class and the types of all members (but does not check method bodies). */
  protected override resolveClass(node: ast.ClassDeclaration, info: ClassInfo): void {
    this.withTypeParams(info.typeParams, node.typeParams, () =>
      this.resolveClassMembers(node, info),
    );
  }

  protected resolveClassMembers(node: ast.ClassDeclaration, info: ClassInfo): void {
    if (node.superClass) {
      const base = this.checkValue(node.superClass);
      const baseParams = base.kind === 'classValue' ? base.info.typeParams : [];

      if (base.kind === 'classValue' && baseParams.some((param) => !param.default)) {
        // `extends Stack[number]` would be an index in JS: the base is used without types.
        this.error(
          `cannot extend the generic class "${base.info.name}": generic base classes are not supported`,
          node.superClass,
        );
        info.untypedBase = true;
      } else if (base.kind === 'classValue') {
        this.ensureClassResolved(base.info);
        if (this.resolvingClasses.has(base.info) || isSubclass(base.info, info)) {
          this.error(`class "${info.name}" cannot extend itself`, node.superClass);
        } else {
          info.superClass = base.info;
          // A generic class from a `.d.ts` whose parameters all have defaults.
          if (baseParams.length > 0) info.superArgs = baseParams.map((param) => param.default!);
        }
      } else if (base.kind === 'any') {
        info.untypedBase = true;
      } else if (base.kind !== 'unknown') {
        this.error(`cannot extend ${typeToString(base)}: it is not a class`, node.superClass);
      }
    }

    for (const member of node.members) {
      switch (member.kind) {
        case 'FieldDeclaration': {
          const declared = member.type ? this.resolveType(member.type) : null;
          let type = declared ?? UNKNOWN;
          const { value } = member;

          if (value) {
            const valueType = this.withClass({ info, isStatic: member.isStatic }, () =>
              this.checkValue(value, declared),
            );

            if (declared) this.expectAssignable(valueType, declared, value);
            else type = this.inferredType(valueType, value);
          }

          this.declareMember(info, member.isStatic, member.name, {
            type,
            method: false,
            visibility: member.visibility,
            owner: info,
          });
          break;
        }

        case 'MethodDeclaration':
          this.declareMember(info, member.isStatic, member.name, {
            type: this.signature(member.params, member.results),
            method: true,
            visibility: member.visibility,
            owner: info,
          });
          break;

        case 'ConstructorDeclaration':
          if (info.ctor) this.error('a class can have only one constructor', member);
          info.ctor = this.signature(member.params, []);
          info.ctorVisibility = member.visibility;
          break;
      }
    }
  }

  protected declareMember(
    info: ClassInfo,
    isStatic: boolean,
    name: ast.Identifier,
    member: Member,
  ): void {
    const members = isStatic ? info.statics : info.members;

    if (members.has(name.name)) this.error(`duplicate member "${name.name}"`, name);
    members.set(name.name, member);
  }

  /** Method bodies and the checks that need every member of the class. */
  protected override checkClassBodies(node: ast.ClassDeclaration, info: ClassInfo): void {
    this.withTypeParams(info.typeParams, null, () => this.checkClassMembers(node, info));
  }

  protected checkClassMembers(node: ast.ClassDeclaration, info: ClassInfo): void {
    let constructorNode: ast.ConstructorDeclaration | null = null;

    for (const member of node.members) {
      if (member.kind === 'MethodDeclaration') {
        const type = (member.isStatic ? info.statics : info.members).get(member.name.name)?.type;

        if (type?.kind !== 'function') continue;
        this.withClass({ info, isStatic: member.isStatic }, () =>
          this.checkFunction(member.params, type, type.results, member.body),
        );
        this.checkOverride(info, member);
      } else if (member.kind === 'ConstructorDeclaration' && info.ctor) {
        constructorNode = member;

        const type = info.ctor;

        this.withClass({ info, isStatic: false }, () =>
          this.checkFunction(member.params, type, [], member.body, { isConstructor: true }),
        );

        const derived = info.superClass !== null || info.untypedBase;

        if (derived && !member.body.body.some(isSuperCall)) {
          this.error('the constructor of a derived class must call super(...)', member);
        }
      }
    }

    // Fields without a zero value must get one at once or in the constructor.
    for (const member of node.members) {
      if (member.kind !== 'FieldDeclaration' || member.isStatic || member.value) continue;

      const type = info.members.get(member.name.name)?.type;

      if (!type || hasZeroValue(type)) continue;
      if (constructorNode && assignsField(constructorNode.body, member.name.name)) continue;
      this.error(
        `field "${member.name.name}" needs a value: ${typeToString(type)} has no zero value, ` +
          'so initialize it here or assign it in the constructor',
        member.name,
      );
    }

    for (const reference of node.implements) {
      const target = this.resolveTypeName(reference.name, reference.typeArgs);

      if (target.kind === 'unknown') continue;
      if (target.kind !== 'object' && target.kind !== 'class') {
        this.error(`cannot implement ${typeToString(target)}: it is not an interface`, reference);
      } else if (!isAssignable(info.instance, target)) {
        const reason = explainMismatch(info.instance, target);

        this.error(
          `class "${info.name}" does not implement ${typeToString(target)}${reason ? `: ${reason}` : ''}`,
          reference,
        );
      }
    }
  }

  protected checkOverride(info: ClassInfo, method: ast.MethodDeclaration): void {
    if (!info.superClass) return;

    const base = findClassMember(info.superClass, method.name.name, method.isStatic);
    const own = (method.isStatic ? info.statics : info.members).get(method.name.name);

    if (!base || !own || isAssignable(own.type, base.type)) return;
    this.error(
      `"${method.name.name}" overrides ${base.owner?.name ?? info.superClass.name}.${method.name.name} ` +
        `with an incompatible type: ${typeToString(own.type)} instead of ${typeToString(base.type)}`,
      method.name,
    );
  }

  /** The top-level declarations, and those of them that are exported. */
  protected collectDeclarations(): { exports: ModuleExports; declarations: ModuleExports } {
    const exports: ModuleExports = {
      values: new Map(),
      types: new Map(),
      decorators: new Map(),
      components: new Map(),
    };
    const declarations: ModuleExports = { values: new Map(), types: new Map() };
    const valueOf = (name: string) => this.moduleScope.values.get(name)?.type ?? UNKNOWN;
    const typeOf = (name: string) => {
      const entry = this.moduleScope.types.get(name);

      if (!entry) return UNKNOWN;

      return entry.kind === 'alias' ? this.resolveAlias(entry) : entry;
    };
    const add = (exported: boolean, kind: 'values' | 'types', name: string, type: Type) => {
      declarations[kind].set(name, type);
      if (exported) exports[kind].set(name, type);
    };

    for (const statement of this.program.body) {
      switch (statement.kind) {
        case 'FuncDeclaration':
          add(statement.exported, 'values', statement.name.name, valueOf(statement.name.name));
          break;

        case 'VariableDeclaration':
          for (const name of statement.names) {
            add(statement.exported, 'values', name.name, valueOf(name.name));
          }

          break;

        case 'ClassDeclaration':
          add(statement.exported, 'values', statement.name.name, valueOf(statement.name.name));
          add(statement.exported, 'types', statement.name.name, typeOf(statement.name.name));
          break;

        case 'InterfaceDeclaration':
        case 'TypeAliasDeclaration':
          add(statement.exported, 'types', statement.name.name, typeOf(statement.name.name));
          break;

        case 'ComponentDeclaration': {
          const info = this.moduleScope.values.get(statement.name.name)?.component;

          if (statement.exported && info?.node === statement) {
            exports.components!.set(statement.name.name, info);
          }

          break;
        }

        case 'DecoratorDeclaration': {
          const info = this.decorators.get(statement.name.name);

          if (statement.exported && info?.node === statement) {
            exports.decorators!.set(statement.name.name, info);
          }

          break;
        }

        default:
          break;
      }
    }

    return { exports, declarations };
  }
}
