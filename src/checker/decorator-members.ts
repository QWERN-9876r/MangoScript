import type * as ast from '../ast.ts';
import { ARRAY_MUTATORS } from '../methods.ts';
import type { DecoratorInfo, PublicMember } from './context.ts';
import { DecoratorChecker } from './decorators.ts';
import { nonNull, UNKNOWN, type Type } from './types.ts';

// The public members of decorators, in the components they are applied to: `@visible.show()` calls
// a function, `get(@visible.shown)` reads state or a constant, and none of them can be changed
// outside the decorator.

export abstract class DecoratorMemberChecker extends DecoratorChecker {
  /** `@visible.show`: a public function; state and constants are read with `get`. */
  protected override checkDecoratorMember(node: ast.DecoratorMember): Type {
    const member = this.findDecoratorMember(node);

    if (member && member.kind !== 'func') {
      const { decorator, member: name } = node;

      this.error(
        `read "${name.name}" of @${decorator.name} with get(@${decorator.name}.${name.name})`,
        node,
      );
    }

    return member?.type ?? UNKNOWN;
  }

  /** `get(@visible.shown)`: public state or a constant. */
  protected override checkDecoratorGet(node: ast.DecoratorGet): Type {
    const member = this.findDecoratorMember(node.target);

    if (member?.kind === 'func') {
      const { decorator, member: name } = node.target;

      this.error(
        `"${name.name}" of @${decorator.name} is a function: call it, @${decorator.name}.${name.name}()`,
        node,
      );
    }

    return member?.type ?? UNKNOWN;
  }

  /**
   * A public member of a decorator applied to the component being checked, or of one that the
   * decorator being checked needs.
   */
  protected findDecoratorMember(node: ast.DecoratorMember): PublicMember | null {
    const name = node.decorator.name;
    const member = node.member.name;

    if (this.decorator) return this.neededMember(node, this.decorator.node);

    const component = this.component;

    if (!component) {
      this.error(
        `@${name}.${member} can only be used in a component that @${name} is applied to`,
        node,
      );

      return null;
    }

    const info = component.decorators.find((decorator) => decorator.node.name.name === name);

    if (!info) {
      this.error(
        this.decorators.has(name)
          ? `@${name} is not applied to ${component.node.name.name}: write @${name} before comp`
          : `unknown decorator @${name}`,
        node.decorator,
      );

      return null;
    }

    return this.publicMember(node, info);
  }

  /** `get(@cart.count)` in `dec cartBadge() needs cart`. */
  protected neededMember(
    node: ast.DecoratorMember,
    decorator: ast.DecoratorDeclaration,
  ): PublicMember | null {
    const name = node.decorator.name;
    const current = decorator.name.name;

    if (name === current) {
      this.error(`inside @${name} its members are used by their names: ${node.member.name}`, node);

      return null;
    }

    if (!decorator.needs.some((need) => need.name === name)) {
      this.error(
        `@${current} can use @${name} only if it needs it: write "needs ${name}" after its parameters`,
        node.decorator,
      );

      return null;
    }

    const info = this.decorators.get(name);

    // An unknown decorator after `needs` is reported there.
    return info ? this.publicMember(node, info) : null;
  }

  protected publicMember(node: ast.DecoratorMember, info: DecoratorInfo): PublicMember | null {
    const name = node.decorator.name;
    const member = node.member.name;
    const found = info.members.get(member);

    if (!found) {
      this.error(
        info.names.has(member)
          ? `"${member}" of @${name} is not public: write "public" before its declaration`
          : `@${name} has no member "${member}"`,
        node.member,
      );
    }

    return found ?? null;
  }

  /**
   * Members of a decorator are read-only outside it: `get(@cart.count) = 0`, `get(@cart.items)[0]
   * = x`. Returns whether `target` is one of them.
   */
  protected override checkDecoratorWrite(target: ast.Expression): boolean {
    const root = decoratorRoot(target);

    if (!root) return false;
    if (this.findDecoratorMember(root)) this.readOnlyError(root, target);

    return true;
  }

  /** `get(@cart.items).push(x)`: a method that changes the array. */
  protected checkDecoratorMutation(node: ast.CallExpression): void {
    const { callee } = node;

    if (callee.kind !== 'MemberExpression') return;

    const root = decoratorRoot(callee.object);

    if (!root || !ARRAY_MUTATORS.has(callee.property.name)) return;
    if (nonNull(this.typeOfChecked(callee.object)).kind !== 'array') return;
    this.readOnlyError(root, node);
  }

  protected readOnlyError(member: ast.DecoratorMember, node: ast.NodeBase): void {
    const name = member.decorator.name;
    const info = this.decorators.get(name);
    const change = [...(info?.members ?? [])].find(([, found]) => found.kind === 'func')?.[0];
    const hint = change
      ? `change it with one of its public functions, e.g. @${name}.${change}()`
      : `give @${name} a public function that changes it`;

    this.error(`"${member.member.name}" of @${name} is read-only outside it; ${hint}`, node);
  }

  /** `card.count` without `@`: `card` is not a value, but a decorator may have that name. */
  protected decoratorWithoutAt(node: ast.MemberExpression): boolean {
    const { object } = node;

    if (object.kind !== 'Identifier' || this.lookupValue(object.name)) return false;

    const info = this.decorators.get(object.name);

    if (!info) return false;

    const name = object.name;
    const member = node.property.name;

    this.error(
      info.members.get(member)?.kind === 'func'
        ? `"${name}" is not defined; to call a function of @${name} write @${name}.${member}()`
        : `"${name}" is not defined; to read public state of @${name} write get(@${name}.${member})`,
      object,
    );

    return true;
  }
}

/** The member of a decorator that `get(@cart.items)[0].done` starts with, if any. */
function decoratorRoot(node: ast.Expression): ast.DecoratorMember | null {
  switch (node.kind) {
    case 'DecoratorMember':
      return node;

    case 'DecoratorGet':
      return node.target;

    case 'MemberExpression':
    case 'IndexExpression':
      return decoratorRoot(node.object);

    case 'CallExpression':
      return decoratorRoot(node.callee);

    default:
      return null;
  }
}
