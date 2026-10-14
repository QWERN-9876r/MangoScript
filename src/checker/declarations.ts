import type * as ast from '../ast.ts';
import { decorate, decoratorNames } from '../decorators.ts';
import { collectValueNames } from '../names.ts';
import { recursiveComponents } from '../recursion.ts';
import { type Binding, type ComponentInfo, type DecoratorInfo, Scope } from './context.ts';
import { ImportChecker } from './imports.ts';
import {
  createClass,
  func,
  UNKNOWN,
  type ClassInfo,
  type FunctionType,
  type ObjectType,
  type TypeParam,
} from './types.ts';

// Declarations of a list of statements: imports, types, functions, components, decorators and
// classes, declared before the statements are checked, so that they can refer to each other.

export abstract class DeclarationChecker extends ImportChecker {
  /**
   * Declares the names of a statement list first (so functions, classes and types can be used
   * before their declaration), then checks the statements in order. Function and method bodies are
   * checked last, when every name of the list is known.
   */
  protected checkStatementList(statements: readonly ast.Statement[], topLevel: boolean): void {
    const bodies = this.declareStatements(statements, topLevel);

    for (const statement of statements) this.checkStatement(statement);
    for (const checkBody of bodies) checkBody();
  }

  protected declareStatements(
    statements: readonly ast.Statement[],
    topLevel: boolean,
  ): (() => void)[] {
    const classes: [ast.ClassDeclaration, ClassInfo][] = [];
    const interfaces: [ast.InterfaceDeclaration, ObjectType][] = [];
    const functions: [ast.FuncDeclaration, Binding][] = [];
    const components: ComponentInfo[] = [];
    const decorators: DecoratorInfo[] = [];

    for (const statement of statements) {
      switch (statement.kind) {
        case 'ImportDeclaration':
          this.declareImport(statement);
          break;

        case 'ClassDeclaration': {
          const info = createClass(statement.name.name);

          info.typeParams = this.createTypeParams(statement.typeParams);
          this.declareType(statement.name, info.instance);
          this.declareValue(statement.name, 'class', info.value);
          classes.push([statement, info]);
          break;
        }

        case 'InterfaceDeclaration': {
          const object: ObjectType = {
            kind: 'object',
            name: statement.name.name,
            members: new Map(),
            call: null,
          };

          if (statement.typeParams.length > 0) {
            object.typeParams = this.createTypeParams(statement.typeParams);
          }

          this.declareType(statement.name, object);
          interfaces.push([statement, object]);
          break;
        }

        case 'TypeAliasDeclaration':
          this.declareType(statement.name, {
            kind: 'alias',
            node: statement,
            scope: this.scope,
            params: this.createTypeParams(statement.typeParams),
            resolved: null,
            resolving: false,
          });
          break;

        case 'FuncDeclaration':
          functions.push([statement, this.declareValue(statement.name, 'function', null)]);
          break;

        case 'ComponentDeclaration': {
          const info: ComponentInfo = {
            node: statement,
            props: new Map(),
            freeNames: null,
            isFunction: false,
            decorators: [],
            expanded: statement,
            result: null,
            root: null,
            inline: null,
            expressionTypes: null,
          };

          this.declareValue(statement.name, 'component', UNKNOWN).component = info;
          components.push(info);
          break;
        }

        case 'DecoratorDeclaration': {
          const name = statement.name.name;
          const info: DecoratorInfo = {
            node: statement,
            params: [],
            members: new Map(),
            names: decoratorNames(statement),
            freeNames: null,
            wrapper: null,
            needed: [],
            moduleNames: [],
            expressionTypes: null,
            inline: null,
          };

          if (this.decorators.has(name)) {
            this.error(`the decorator @${name} is already declared`, statement.name);
          } else {
            this.decorators.set(name, info);
          }

          decorators.push(info);
          break;
        }

        case 'VariableDeclaration':
          // Top-level variables can be used in functions declared before them.
          if (topLevel) {
            for (const name of statement.names) this.declareValue(name, statement.keyword, null);
          }

          break;

        default:
          break;
      }
    }

    for (const [node, object] of interfaces) {
      this.withTypeParams(object.typeParams ?? [], node.typeParams, () =>
        this.fillMembers(object, node.members),
      );
    }

    for (const statement of statements) {
      if (statement.kind !== 'TypeAliasDeclaration') continue;

      const entry = this.scope.types.get(statement.name.name);

      if (entry?.kind === 'alias') this.resolveAlias(entry);
    }

    for (const [node, binding] of functions) {
      const typeParams = this.createTypeParams(node.typeParams);

      binding.type = this.withTypeParams(typeParams, node.typeParams, () => ({
        ...this.signature(node.params, node.results),
        typeParams,
      }));
    }

    for (const info of components) this.resolveProps(info);
    for (const info of decorators) this.resolveDecoratorParams(info);

    // Decorators of other modules use the names of those through hidden exports.
    const sources = new Map(
      [...this.decorators].map(([name, info]) => {
        const moduleNames = this.importedDecorators.has(info) ? info.moduleNames : [];

        return [name, { node: info.node, moduleNames }];
      }),
    );

    for (const info of components) {
      info.decorators = info.node.decorators.flatMap(
        (use) => this.decorators.get(use.name.name) ?? [],
      );
      info.expanded = decorate(info.node, sources);
    }

    // The code of the decorators is part of the component: it may use components too.
    const recursive = recursiveComponents(
      new Map(components.map((info) => [info.node.name.name, info.expanded])),
    );

    // A component used as a value is called by tags that take it from there.
    const names = new Set(components.map((info) => info.node.name.name));
    const values = new Set<string>();

    collectValueNames(this.program, values, (name) => names.has(name));
    for (const info of components) {
      // Other modules call an exported component, so it is a function in its own module too.
      info.isFunction =
        recursive.has(info.expanded) ||
        info.node.htmlTag !== null ||
        info.node.exported ||
        values.has(info.node.name.name);
    }

    for (const [node, info] of classes) {
      this.unresolvedClasses.set(info, () => this.resolveClass(node, info));
    }

    for (const [, info] of classes) this.ensureClassResolved(info);

    const bodies: (() => void)[] = [];

    for (const [node, binding] of functions) {
      const type = binding.type as FunctionType;

      // A nested `func` declaration is a JS `function`: it has no `this` of its own class.
      bodies.push(() =>
        this.withClass(null, () => this.checkFunction(node.params, type, type.results, node.body)),
      );
    }

    for (const [node, info] of classes) bodies.push(() => this.checkClassBodies(node, info));
    // Components use the types of the public members of decorators, and so do decorators that
    // need them.
    for (const info of this.orderByNeeds(decorators)) {
      bodies.push(() => this.checkDecoratorBody(info));
    }

    for (const info of components) bodies.push(() => this.checkComponentBody(info));
    // The values of `style` are read once the markup exists: they see the whole body.
    for (const style of statements.filter((node) => node.kind === 'StyleStatement')) {
      bodies.push(() => this.checkStyle(style));
    }

    return bodies;
  }

  /** Members of an interface or object type: `name string; area() number`. */
  protected fillMembers(object: ObjectType, members: readonly ast.TypeMember[]): void {
    for (const member of members) {
      // `[string]: T`: the parser allows only string and number keys, which JS objects have.
      if (member.kind === 'IndexSignature') {
        object.index = this.resolveType(member.type);
        continue;
      }

      if (object.members.has(member.name.name)) {
        this.error(`duplicate member "${member.name.name}"`, member.name);
      }

      object.members.set(member.name.name, {
        type:
          member.kind === 'PropertySignature'
            ? this.resolveType(member.type)
            : this.signature(member.params, member.results),
        method: member.kind === 'MethodSignature',
        visibility: 'public',
        owner: null,
      });
    }
  }

  /** `[T any, U Shape]`: the parameters, with constraints resolved later by withTypeParams. */
  protected createTypeParams(nodes: readonly ast.TypeParameter[]): TypeParam[] {
    return nodes.map((node) => ({ kind: 'param', name: node.name.name, constraint: null }));
  }

  /**
   * Runs `check` in a scope where type parameters are types. With their declarations, it first
   * resolves the constraints (`any` means none).
   */
  protected withTypeParams<T>(
    params: readonly TypeParam[],
    nodes: readonly ast.TypeParameter[] | null,
    check: () => T,
  ): T {
    if (params.length === 0) return check();

    const saved = this.scope;

    this.scope = new Scope(saved);
    try {
      for (const param of params) this.scope.types.set(param.name, param);
      nodes?.forEach((node, i) => {
        if (!node.constraint) return;

        const constraint = this.resolveType(node.constraint);

        params[i]!.constraint = constraint.kind === 'any' ? null : constraint;
      });

      return check();
    } finally {
      this.scope = saved;
    }
  }

  protected signature(
    params: readonly ast.Parameter[],
    results: readonly ast.TypeNode[],
  ): FunctionType {
    return func(
      params.map((param) => (param.type ? this.resolveType(param.type) : UNKNOWN)),
      results.map((result) => this.resolveType(result)),
    );
  }
}
