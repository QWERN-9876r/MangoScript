import type * as ast from '../ast.ts';
import { decoratorNames, wrapperBody, wrapperOf } from '../decorators.ts';
import { ComponentChecker } from './components.ts';
import type { ComponentInfo, DecoratorInfo } from './context.ts';
import { isUntyped, ownStatements } from './helpers.ts';
import { isAssignable, typeToString, UNKNOWN, type Type } from './types.ts';

// The wrappers of decorators, `return (content Element) => <div>{content}</div>`: what they get from
// the component and what they give instead. `<Page />` has the type of what the outermost gives.

const EXAMPLE = 'return (content Element) => <div>{content}</div>';

type WrapperInfo = NonNullable<DecoratorInfo['wrapper']>;

export abstract class DecoratorWrapperChecker extends ComponentChecker {
  /** The type of what the wrapper gets, resolved with the other declarations of the module. */
  protected resolveWrapper(info: DecoratorInfo): void {
    const node = wrapperOf(info.node);
    const type = node?.param.type;

    info.wrapper = node && { node, param: type ? this.resolveType(type) : UNKNOWN };
  }

  /** The `return` of a decorator's body, once the body is checked. */
  protected checkWrapper(info: DecoratorInfo): void {
    const { body } = info.node;
    const last = body.body.at(-1);

    for (const statement of ownStatements(body)) {
      if (statement.kind === 'ReturnStatement' && statement !== last) {
        this.error(`a decorator returns its wrapper at the end of its body: ${EXAMPLE}`, statement);
      }
    }

    if (last?.kind !== 'ReturnStatement') return;
    if (!info.wrapper) {
      const [value] = last.values;
      const isFunction = value?.kind === 'ArrowFunction' || value?.kind === 'FuncExpression';

      this.error(
        isFunction && last.values.length === 1
          ? 'the wrapper takes one parameter, what the component returns: (content Element) => ...'
          : `a decorator returns its wrapper, a function literal: ${EXAMPLE}`,
        value ?? last,
      );

      return;
    }

    this.checkWrapperParam(info, info.wrapper);
    this.checkWrapperBody(info.wrapper);
  }

  private checkWrapperParam(info: DecoratorInfo, wrapper: WrapperInfo): void {
    const { fn, param } = wrapper.node;
    const name = param.name.name;

    // Without a type, the parameter is reported as one of any function literal.
    if (param.type && !this.takesMarkup(wrapper)) {
      this.error(
        `the wrapper gets markup, so "${name}" is a Node, an Element or a type of element, not ${typeToString(wrapper.param)}`,
        param.type,
      );
    }

    // The code of the wrapper goes into the component next to the decorator's.
    const members = decoratorNames(info.node);
    const statements = fn.body.kind === 'BlockStatement' ? fn.body.body : [];

    for (const identifier of [param.name, ...declaredIdentifiers(statements)]) {
      if (members.has(identifier.name)) {
        this.error(
          `"${identifier.name}" of the wrapper hides "${identifier.name}" of @${info.node.name.name}: rename one of them`,
          identifier,
        );
      }
    }
  }

  private takesMarkup(wrapper: WrapperInfo): boolean {
    return isUntyped(wrapper.param) || isAssignable(wrapper.param, this.dom.node);
  }

  /** A wrapper is inlined where the component returns, so it returns once, at its end. */
  private checkWrapperBody(wrapper: WrapperInfo): void {
    const { fn } = wrapper.node;
    const end = wrapperBody(fn).at(-1);

    if (fn.body.kind === 'BlockStatement') {
      for (const statement of ownStatements(fn.body)) {
        if (statement.kind === 'DeferStatement') {
          this.error('defer is not supported in decorators yet', statement);
        } else if (statement !== end) {
          this.error(
            'a wrapper returns once, at the end of its body; other returns are not supported yet',
            statement,
          );
        }
      }
    }

    const [value] = end?.kind === 'ReturnStatement' ? end.values : [];

    if (!value) {
      this.error('the wrapper ends with "return <markup>", e.g. return content', end ?? fn);

      return;
    }

    const type = this.typeOfChecked(value);

    if (!isUntyped(type) && !isAssignable(type, this.dom.node)) {
      this.error(`the wrapper returns markup, not ${typeToString(type)}`, value);
    }
  }

  protected override wrappedType(info: ComponentInfo, own: Type, seen: Set<ComponentInfo>): Type {
    return info.decorators.reduceRight(
      (type, decorator) => (decorator.wrapper ? this.wrapperResult(decorator.wrapper, seen) : type),
      own,
    );
  }

  /** What a wrapper gives, found without checking it again, like the markup of a component. */
  protected wrapperResult(wrapper: WrapperInfo, seen: Set<ComponentInfo>): Type {
    const end = wrapperBody(wrapper.node.fn).at(-1);
    const [value] = end?.kind === 'ReturnStatement' ? end.values : [];

    if (value?.kind === 'Identifier' && value.name === wrapper.node.param.name.name) {
      return wrapper.param;
    }

    return this.markupType(value, seen);
  }

  /** What the component returns fits its wrappers, from the bottom decorator up. */
  protected checkWrappedTypes(info: ComponentInfo): void {
    let type = this.ownResult(info, new Set());
    let source: string | null = null;

    for (const decorator of [...info.decorators].reverse()) {
      const { wrapper } = decorator;

      if (!wrapper) continue;

      const name = decorator.node.name.name;
      const expected = typeToString(wrapper.param);

      // A parameter that takes no markup is reported with the wrapper.
      const fits = isUntyped(type) || isUntyped(wrapper.param) || isAssignable(type, wrapper.param);

      if (!fits && this.takesMarkup(wrapper)) {
        const use = info.node.decorators.find((each) => each.name.name === name);
        const given = typeToString(type);

        this.error(
          source === null
            ? `@${name} wraps ${expected}, but ${info.node.name.name} returns ${given}: apply @${name} to a component that returns ${expected}`
            : `@${name} wraps ${expected}, but ${source} gives ${given}: change the order of the decorators or the type of the wrapper`,
          use ?? info.node.name,
        );
      }

      type = this.wrapperResult(wrapper, new Set());
      source = `@${name}`;
    }
  }
}

/** The names that statements declare in their own block. */
function declaredIdentifiers(statements: readonly ast.Statement[]): ast.Identifier[] {
  return statements.flatMap((statement) => {
    switch (statement.kind) {
      case 'VariableDeclaration':
        return statement.names.filter((name) => name.name !== '_');

      case 'FuncDeclaration':
      case 'ClassDeclaration':
        return [statement.name];

      default:
        return [];
    }
  });
}
