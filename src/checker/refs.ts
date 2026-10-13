import type * as ast from '../ast.ts';
import { componentRoot, isComponentUse, refBindings, type Repeated, type Root } from '../refs.ts';
import { ComponentChecker } from './components.ts';
import type { ComponentInfo } from './context.ts';
import { lookupIn } from './helpers.ts';
import { UNKNOWN, type Type } from './types.ts';

// Refs: `ref input` in the body of a component or a decorator, and `<input ref={input} />` in its
// markup, which gives the ref its element and its type. The element is created where the ref is
// declared, so the markup must create it exactly once.

const OUT_OF = (flow: string) =>
  `move the element out of {${flow}}, or into a component that has a ref of its own`;
const IN_MARKUP = 'write the element in the markup the component returns';

const REPEATED: Record<Repeated, string> = {
  for: 'inside {for}: the element is created for every item, so a ref cannot point to it; put the element into a component, and each copy gets its own ref',
  if: `inside {if}: the element is created again when the branch changes, so a ref cannot point to it; ${OUT_OF('if')}`,
  switch: `inside {switch}: the element is created again when the case changes, so a ref cannot point to it; ${OUT_OF('switch')}`,
  expression: `inside an expression, which may create the element more than once; ${IN_MARKUP}`,
  function: `inside a function, which may create the element more than once; ${IN_MARKUP}`,
  block: `inside a block of the body, which may create the element more than once; ${IN_MARKUP}`,
};

/** The refs that the markup of a body binds: to one element each, and the names it mentions. */
interface Bound {
  targets: Map<string, ast.ElementExpression>;
  mentioned: Set<string>;
}

export abstract class RefChecker extends ComponentChecker {
  /** The refs of the body of the component or decorator being checked. */
  private refs: Bound | null = null;

  protected override checkComponentBody(info: ComponentInfo): void {
    this.withRefs(info.node.body, () => super.checkComponentBody(info));
    // Other modules find what <Card ref={card} /> creates here: the tags are names of this module.
    info.root = this.rootOf(info);
  }

  /** `<Card ref={card} />` binds a ref, so no component has such a property. */
  protected override resolveProps(info: ComponentInfo): void {
    super.resolveProps(info);

    const param = info.node.params.find((each) => each.name.name === 'ref');

    if (param) {
      this.error('a component cannot have the property "ref": ref={...} binds a ref', param.name);
    }
  }

  /** Checks a body whose markup binds the refs it declares. */
  protected withRefs<T>(body: ast.BlockStatement, check: () => T): T {
    const saved = this.refs;

    this.refs = this.bindRefs(body);
    try {
      return check();
    } finally {
      this.refs = saved;
    }
  }

  /** Bindings in markup that may be created more than once, and refs bound twice, are errors. */
  private bindRefs(body: ast.BlockStatement): Bound {
    const declared = new Set<string>();

    for (const statement of body.body) {
      if (statement.kind !== 'VariableDeclaration' || statement.keyword !== 'ref') continue;
      for (const name of statement.names) declared.add(name.name);
    }

    const bound: Bound = { targets: new Map(), mentioned: new Set() };

    for (const { attribute, element, repeated } of refBindings(body)) {
      const { value } = attribute;

      // Other names are not refs of this body: checkRefAttribute reports them.
      if (value?.kind !== 'Identifier' || !declared.has(value.name)) continue;

      const { name } = value;

      bound.mentioned.add(name);
      if (repeated !== null) {
        this.error(`ref={${name}} is ${REPEATED[repeated]}`, attribute);
      } else if (bound.targets.has(name)) {
        this.error(
          `ref "${name}" is already bound to another element; a ref points to one element`,
          attribute,
        );
      } else {
        bound.targets.set(name, element);
      }
    }

    return bound;
  }

  /** `ref input` or `ref input HTMLElement`: without a type, it has that of its element. */
  protected override checkRefDeclaration(node: ast.VariableDeclaration): void {
    const declared = node.type ? this.resolveType(node.type) : null;

    for (const name of node.names) {
      const target = this.refs?.targets.get(name.name);

      if (!target && !this.refs?.mentioned.has(name.name)) {
        this.error(
          `ref "${name.name}" is not bound to an element; add ref={${name.name}} to one, e.g. <div ref={${name.name}}>`,
          name,
        );
      }

      this.declareValue(name, 'ref', declared ?? (target ? this.boundType(target) : UNKNOWN));
    }
  }

  /** `ref={input}`: the name of a ref, whose type the element must have. */
  protected override checkRefAttribute(
    attribute: ast.JsxAttribute,
    node: ast.ElementExpression,
  ): void {
    const { value } = attribute;

    if (value?.kind !== 'Identifier') {
      if (value && value.kind !== 'StringLiteral' && value.kind !== 'EventHandler') {
        this.checkValue(value);
      }

      this.error('ref={...} takes the name of a ref, e.g. ref={input}', attribute);

      return;
    }

    const binding = this.lookupValue(value.name);

    if (binding?.kind !== 'ref') {
      if (binding)
        this.error(`"${value.name}" is not a ref; declare it with ref ${value.name}`, value);
      else this.checkValue(value);

      return;
    }

    const type = binding.type ?? UNKNOWN;

    this.checkedTypes.set(value, type);
    this.expectAssignable(this.boundType(node), type, value, ` for ref "${value.name}"`);
    if (!isComponentUse(node)) return;

    const tag = node.tag!.name;
    const info = lookupIn(this.moduleScope, tag)?.component;
    const root = info ? this.rootOf(info) : null;

    if (typeof root === 'string') this.error(`ref cannot point to <${tag}>: it ${root}`, attribute);
  }

  /** The type of what an element or a use of a component creates, without checking it. */
  private boundType(node: ast.ElementExpression): Type {
    if (node.tag === null) return this.dom.fragment;
    if (!isComponentUse(node)) return this.elementOf(node.tag.name);

    const info = lookupIn(this.moduleScope, node.tag.name)?.component;

    return info ? this.componentResult(info, new Set()) : UNKNOWN;
  }

  /**
   * The element at the top of what a component creates, which a ref to it creates in advance; or
   * why it is not known.
   */
  protected rootOf(info: ComponentInfo, seen = new Set<ComponentInfo>()): Root {
    if (info.root) return info.root;
    seen.add(info);

    return componentRoot(info.expanded, (tag) => {
      const other = lookupIn(this.moduleScope, tag)?.component;

      return other && !seen.has(other) ? this.rootOf(other, seen) : undefined;
    });
  }
}
