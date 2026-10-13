import type * as ast from '../ast.ts';
import { mentionsName } from '../names.ts';
import {
  componentRoot,
  constantAttributes,
  isComponentUse,
  ownRoot,
  refName,
  refTargets,
  type Root,
} from '../refs.ts';
import { isSvgElement, svgElements } from '../svg.ts';
import { forEachChild } from '../walk.ts';
import { EarlyReturnEmitter } from './early-returns.ts';

/**
 * Refs: `ref input` creates the element of `<input ref={input} />` where it is declared, with its
 * constant attributes, and the markup fills that element in instead of creating one.
 *
 * `<Card ref={card} />` creates the element at the top of what `Card` returns. An inlined `Card`
 * fills it in under a name of its own, `$$root4`, since its own names may hide `card`; the
 * function of `Card` gets it as its last argument, `$$root`, which is undefined without a ref.
 */

/** The element at the top of the markup of the component being written, created by a ref. */
export interface RootPreset {
  /** The element, or the use of a component, at the top of the component's own markup. */
  node: ast.ElementExpression;
  /** The variable with the element. */
  name: string;
  /** False for `$$root` of a function: the element is created when the caller gave none. */
  created: boolean;
}

export abstract class RefEmitter extends EarlyReturnEmitter {
  /** The elements that the refs of the component being written are bound to. */
  private refElements = new Map<string, ast.ElementExpression>();
  /** Those of them that are SVG elements. */
  private svgTargets = new Set<ast.ElementExpression>();
  private rootPreset: RootPreset | null = null;
  /** Tags of components that refs point to or that are at the top of components: lazily. */
  private rootTags: Set<string> | null = null;

  /** Writes the code of a component: its refs, and the element at its top if a ref created it. */
  protected withRefs<T>(
    component: ast.ComponentDeclaration,
    preset: RootPreset | null,
    emit: () => T,
  ): T {
    const saved = {
      refElements: this.refElements,
      svgTargets: this.svgTargets,
      rootPreset: this.rootPreset,
      inSvg: this.inSvg,
    };

    this.refElements = refTargets(component.body);
    this.svgTargets = this.refElements.size > 0 ? svgElements(component.body) : new Set();
    this.rootPreset = preset;
    // The markup of a component starts outside <svg>, wherever the component is used.
    this.inSvg = false;
    try {
      return emit();
    } finally {
      this.refElements = saved.refElements;
      this.svgTargets = saved.svgTargets;
      this.rootPreset = saved.rootPreset;
      this.inSvg = saved.inSvg;
    }
  }

  /** `ref input`: `const input = document.createElement("input");` and its constant attributes. */
  protected refDeclaration(node: ast.VariableDeclaration): void {
    for (const id of node.names) {
      const name = this.name(id.name);
      const target = this.refElements.get(id.name);
      const preset = target && this.rootPreset?.node === target ? this.rootPreset : null;

      if (preset?.created) {
        this.line(`const ${name} = ${preset.name};`);
        continue;
      }

      const element = target ? this.elementOf(target) : null;

      // Only without the checker: it reports a ref that points to no element.
      if (!element?.tag) {
        this.line(`const ${name} = null;`);
        continue;
      }

      const tag = element.tag.name;
      // The root of another component has no <svg> above it in its own markup.
      const svg = element === target ? this.svgTargets.has(target) : isSvgElement(tag, false);
      const create = this.createElement(tag, svg);

      this.line(`const ${name} = ${preset ? `${preset.name} ?? ${create}` : create};`);
      for (const attribute of constantAttributes(element)) {
        this.attribute(name, tag, attribute, null, svg);
      }
    }
  }

  /**
   * The element that markup fills in instead of creating one: that of its ref, which has its
   * constant attributes already, or the one a ref to the component created.
   */
  protected override presetElement(
    node: ast.ElementExpression,
  ): { name: string; created: boolean } | null {
    const ref = refName(node);

    if (ref !== null) return { name: this.name(ref), created: true };

    const preset = this.rootPreset;

    return preset?.node === node && node.tag !== null ? preset : null;
  }

  /**
   * What a use of a component gives it as the element at its top: the element of a ref on the use,
   * or the one given to the component being written, when the use is at its top.
   */
  protected rootFor(use: ast.ElementExpression): { name: string; created: boolean } | null {
    const ref = refName(use);

    if (ref !== null) return { name: this.name(ref), created: true };

    const preset = this.rootPreset;

    return preset?.node === use ? { name: preset.name, created: preset.created } : null;
  }

  /** The preset of an inlined component, whose names may hide the variable with the element. */
  protected inlineRoot(
    component: ast.ComponentDeclaration,
    given: { name: string; created: boolean } | null,
  ): RootPreset | null {
    const own = ownRoot(component);

    if (!given || typeof own === 'string') return null;

    let { name } = given;

    if (!name.startsWith('$$') && mentionsName(component, new Set([name.replace(/\$$/, '')]))) {
      name = `$$root${this.nextId()}`;
      this.line(`const ${name} = ${given.name};`);
    }

    return { node: own, name, created: given.created };
  }

  /**
   * Whether the function of a component takes `$$root`: when the element at its top is known, and
   * a ref may point to it, here or in another module, or a component that does returns it.
   */
  protected takesRoot(component: ast.ComponentDeclaration): boolean {
    if (typeof this.componentRootOf(component, new Set()) === 'string') return false;

    this.rootTags ??= this.findRootTags();

    return component.exported || this.rootTags.has(component.name.name);
  }

  private findRootTags(): Set<string> {
    const tags = new Set<string>();
    const visit = (node: ast.Node): void => {
      if (node.kind === 'ElementExpression' && isComponentUse(node) && refName(node) !== null) {
        tags.add(node.tag!.name);
      }

      forEachChild(node, visit);
    };

    visit(this.program);
    for (const component of this.components.values()) {
      const own = ownRoot(component);

      if (typeof own !== 'string' && isComponentUse(own)) tags.add(own.tag!.name);
    }

    return tags;
  }

  /** The element that markup creates: itself, or the one at the top of the component it uses. */
  private elementOf(node: ast.ElementExpression): ast.ElementExpression | null {
    if (!isComponentUse(node)) return node;

    const component = this.components.get(node.tag!.name);
    const root = component ? this.componentRootOf(component, new Set()) : null;

    return typeof root === 'string' ? null : root;
  }

  private componentRootOf(
    component: ast.ComponentDeclaration,
    seen: Set<ast.ComponentDeclaration>,
  ): Root {
    const imported = this.importedRoots.get(component);

    if (imported !== undefined) return imported;
    seen.add(component);

    return componentRoot(component, (tag) => {
      const other = this.components.get(tag);

      return other && !seen.has(other) ? this.componentRootOf(other, seen) : undefined;
    });
  }
}
