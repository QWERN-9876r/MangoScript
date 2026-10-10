import type * as ast from '../ast.ts';
import { freeNames } from '../names.ts';
import { forEachChild } from '../walk.ts';
import type { ComponentInfo, DecoratorInfo, PublicMember, Scope } from './context.ts';
import { DecoratorExportChecker } from './decorator-exports.ts';
import { ownStatements } from './helpers.ts';
import { func, UNKNOWN } from './types.ts';

// Decorators: their parameters, needs and bodies, and the decorators applied to a component with
// their arguments. Wrappers are in decorator-wrappers.ts, exported decorators in
// decorator-exports.ts, the public members a component uses in decorator-members.ts.

export abstract class DecoratorChecker extends DecoratorExportChecker {
  protected override resolveDecoratorParams(info: DecoratorInfo): void {
    const names = new Set<string>();
    let optional: ast.Parameter | null = null;

    info.params = info.node.params.map((param) => {
      const { name } = param.name;

      if (names.has(name)) this.error(`duplicate parameter "${name}"`, param.name);
      names.add(name);
      if (param.defaultValue) optional = param;
      else if (optional) {
        this.error(
          `"${name}" needs a default value: the arguments are positional, so parameters with default values go last`,
          param.name,
        );
      }

      return param.type ? this.resolveType(param.type) : UNKNOWN;
    });
    this.resolveWrapper(info);
    this.checkNeedsDeclaration(info);
  }

  /** `needs cart, auth`: other decorators, each once. */
  protected checkNeedsDeclaration(info: DecoratorInfo): void {
    const needed = new Set<string>();

    for (const need of info.node.needs) {
      const { name } = need;

      const other = this.decorators.get(name);

      if (name === info.node.name.name) this.error(`@${name} cannot need itself`, need);
      else if (needed.has(name)) this.error(`@${name} is needed twice: name it once`, need);
      else if (!other) this.error(`unknown decorator @${name}`, need);
      else info.needed.push(other);
      needed.add(name);
    }
  }

  /** Decorators after the ones they need. A cycle of needs is an error: none can be first. */
  protected override orderByNeeds(decorators: readonly DecoratorInfo[]): DecoratorInfo[] {
    const order: DecoratorInfo[] = [];
    const path: DecoratorInfo[] = [];
    const visit = (info: DecoratorInfo): void => {
      if (order.includes(info)) return;

      const at = path.indexOf(info);

      if (at >= 0) {
        const cycle = path.slice(at).map((each) => `@${each.node.name.name}`);
        const steps = cycle.map((name, i) => `${name} needs ${cycle[(i + 1) % cycle.length]}`);

        this.error(
          `decorators cannot need each other: ${steps.join(', ')}; remove one of the needs`,
          info.node.name,
        );

        return;
      }

      path.push(info);
      for (const needed of info.needed) visit(needed);

      path.pop();
      order.push(info);
    };

    decorators.forEach(visit);

    return order;
  }

  /**
   * The body is checked once, by itself: it does not see the components it is applied to. Its
   * public members get their types here, before the bodies of components are checked.
   */
  protected override checkDecoratorBody(info: DecoratorInfo): void {
    const { node } = info;

    node.params.forEach((param, i) => {
      if (!param.defaultValue) return;

      const type = info.params[i] ?? UNKNOWN;

      this.expectAssignable(this.checkValue(param.defaultValue, type), type, param.defaultValue);
    });
    for (const statement of ownStatements(node.body)) {
      if (statement.kind === 'DeferStatement') {
        this.error('defer is not supported in decorators yet', statement);
      }
    }

    const saved = { component: this.component, decorator: this.decorator };

    this.component = null;
    this.decorator = info;
    try {
      this.withClass(null, () =>
        this.checkFunction(node.params, func(info.params, []), null, node.body, {
          paramKind: 'prop',
          inspect: (scope) => this.collectMembers(info, scope),
        }),
      );
    } finally {
      this.component = saved.component;
      this.decorator = saved.decorator;
    }

    this.checkWrapper(info);
    if (node.exported) this.checkExportedDecorator(info);
  }

  protected collectMembers(info: DecoratorInfo, scope: Scope): void {
    const add = (name: ast.Identifier, kind: PublicMember['kind']) => {
      const type = scope.values.get(name.name)?.type ?? UNKNOWN;

      if (name.name !== '_') info.members.set(name.name, { kind, type });
    };

    for (const statement of info.node.body.body) {
      if (statement.kind === 'FuncDeclaration' && statement.isPublic) {
        add(statement.name, 'func');
      } else if (
        statement.kind === 'VariableDeclaration' &&
        statement.isPublic &&
        statement.keyword !== 'let'
      ) {
        for (const name of statement.names) add(name, statement.keyword);
      }
    }
  }

  /**
   * The decorators before `comp`: they exist, are applied once and below the ones they need, get
   * valid arguments, and their wrappers get what they can take.
   */
  protected override checkDecoratorUses(info: ComponentInfo): void {
    const applied = new Set<DecoratorInfo>();

    for (const use of info.node.decorators) {
      const name = use.name.name;
      const decorator = this.decorators.get(name);

      if (!decorator) {
        this.error(`unknown decorator @${name}`, use.name);
        continue;
      }

      if (applied.has(decorator)) this.error(`@${name} is applied twice: apply it once`, use);

      // The body of a decorator may read the state of those it needs right away.
      for (const needed of decorator.needed) {
        if (applied.has(needed)) continue;

        const other = needed.node.name.name;

        this.error(`@${name} needs @${other} above it: @${other} @${name} comp ...`, use);
      }

      applied.add(decorator);
      this.checkDecoratorArguments(use, decorator, info);
      this.checkInlinedNames(use, decorator, info);
    }

    this.checkWrappedTypes(info);
  }

  /** Arguments are positional and see the properties of the component, as its body does. */
  protected checkDecoratorArguments(
    use: ast.DecoratorUse,
    decorator: DecoratorInfo,
    info: ComponentInfo,
  ): void {
    const name = use.name.name;
    const { params } = decorator.node;
    const extra = use.arguments[params.length];

    if (extra) {
      const count = params.length === 1 ? '1 argument' : `${params.length} arguments`;

      this.error(
        params.length === 0 ? `@${name} takes no arguments` : `@${name} takes ${count}`,
        extra,
      );
    }

    this.withScope(() => {
      for (const param of info.node.params) {
        this.declareValue(param.name, 'prop', info.props.get(param.name.name)?.type ?? UNKNOWN);
      }

      params.forEach((param, i) => {
        const type = decorator.params[i] ?? UNKNOWN;
        const arg = use.arguments[i];

        if (!arg) {
          if (!param.defaultValue) {
            this.error(`@${name} needs the argument "${param.name.name}"`, use);
          }

          return;
        }

        const context = ` for "${param.name.name}" of @${name}`;

        this.expectAssignable(this.checkValue(arg, type), type, arg, context);
      });
    });
  }

  /**
   * The code of the decorator and its arguments go into the component's body, so the names of the
   * module they use must not be hidden there by the component's declarations.
   */
  protected checkInlinedNames(
    use: ast.DecoratorUse,
    decorator: DecoratorInfo,
    info: ComponentInfo,
  ): void {
    const name = use.name.name;
    const component = info.node.name.name;
    const declared = bodyNames(info.node.body);
    const params = new Set(info.node.params.map((param) => param.name.name));

    // Those of another module come through hidden exports, under names of their own.
    const hidden = this.importedDecorators.has(decorator) ? decorator.moduleNames : [];

    decorator.freeNames ??= freeNames(decorator.node);
    for (const used of decorator.freeNames) {
      if (hidden.includes(used)) continue;
      if (declared.has(used) || params.has(used)) {
        this.error(
          `@${name} uses "${used}" of the module, but ${component} declares its own "${used}": rename one of them`,
          use,
        );

        return;
      }
    }

    const statements = use.arguments.map((expression): ast.Statement => {
      return { kind: 'ExpressionStatement', expression, start: use.start, end: use.end };
    });
    const body: ast.BlockStatement = {
      kind: 'BlockStatement',
      body: statements,
      start: use.start,
      end: use.end,
    };

    for (const used of freeNames({ params: info.node.params, body })) {
      if (declared.has(used)) {
        this.error(
          `the arguments of @${name} use "${used}" of the module, but ${component} declares its own "${used}": rename one of them`,
          use,
        );

        return;
      }
    }
  }
}

/**
 * Names declared in a component's body outside nested functions: those that the code of its
 * decorators, which goes into the body, could see instead of the module's.
 */
function bodyNames(body: ast.BlockStatement): Set<string> {
  const names = new Set<string>();
  const visit = (node: ast.Node): void => {
    switch (node.kind) {
      case 'VariableDeclaration':
        for (const name of node.names) names.add(name.name);
        break;

      case 'FuncDeclaration':
      case 'ClassDeclaration':
        names.add(node.name.name);

        return;

      case 'FuncExpression':
      case 'ArrowFunction':
      case 'EventHandler':
      case 'MountStatement':
        return;

      case 'ForInStatement':
        names.add(node.value.name);
        if (node.key) names.add(node.key.name);
        break;

      case 'CatchClause':
        if (node.param) names.add(node.param.name);
        break;

      default:
        break;
    }

    forEachChild(node, visit);
  };

  forEachChild(body, visit);

  return names;
}
