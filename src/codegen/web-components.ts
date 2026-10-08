import type * as ast from '../ast.ts';
import { attributeKind, attributeName, htmlTagName } from '../html-tag.ts';
import { ComponentEmitter } from './components.ts';

/**
 * Web components: `@html-tag comp Card(count number) { ... }` is a function component, and also the
 * class of a custom element `<card>`, defined at the end of the module, when the names it uses
 * have their values.
 *
 * The element renders the component into its shadow root when it is connected. When it is
 * disconnected and not put back in the same task, the component is removed: the functions
 * returned by `mount()` run. Moving the element keeps its markup.
 *
 * Every property except `children` is a JS property of the element; its setter updates the markup.
 * Strings, numbers and bools also have attributes: `item-count="3"` sets `itemCount` to 3, and a
 * bool attribute sets true by its presence. A removed attribute leaves the default value.
 * `children` is a `<slot>`: what is inside the element is shown there.
 */
export abstract class WebComponentEmitter extends ComponentEmitter {
  protected webComponentClasses(): void {
    for (const component of this.components.values()) {
      if (component.htmlTag) this.webComponentClass(component);
    }
  }

  protected webComponentClass(component: ast.ComponentDeclaration): void {
    this.helpers.add('owner');
    const name = component.name.name;
    const className = `$$${name}Element`;
    const props = component.params.filter((param) => param.name.name !== 'children');
    const kinds = props.map((param) => attributeKind(param.type, this.typeAliases));
    const observed = props
      .filter((_, i) => kinds[i] !== null)
      .map((param) => JSON.stringify(attributeName(param.name.name)));
    // A missing property: undefined gives the default value, others get their zero value.
    const value = (param: ast.Parameter) =>
      param.defaultValue
        ? `values.${param.name.name}`
        : `values.${param.name.name} ?? ${(param.type && this.zeroValue(param.type)) ?? 'undefined'}`;
    // The properties come from `#args()`, in the order of the setter; `children` is a slot.
    const slot = component.params.findIndex((param) => param.name.name === 'children');
    let prepare: string | null = null;
    const args: string[] = props.length > 0 ? ['...this.#args()'] : [];
    if (slot === props.length) {
      args.push('document.createElement("slot")');
    } else if (slot >= 0) {
      prepare = `args.splice(${slot}, 0, document.createElement("slot"));`;
      args[0] = '...args';
    }
    const names = props.map((param) => JSON.stringify(param.name.name)).join(', ');

    const body = this.capture(() => {
      if (observed.length > 0) this.line(`static observedAttributes = [${observed.join(', ')}];`);
      this.line('#values = {};');
      this.line('#update = null;');
      this.line('#remove = null;');
      this.lines.push('');
      this.line('constructor() {');
      this.line('  super();');
      this.line('  this.attachShadow({ mode: "open" });');
      if (props.length > 0) {
        // A property set before the class was defined hides its setter.
        this.line(`  for (const name of [${names}]) {`);
        this.line('    if (!Object.hasOwn(this, name)) continue;');
        this.line('    const value = this[name];');
        this.line('    delete this[name];');
        this.line('    this[name] = value;');
        this.line('  }');
      }
      this.line('}');
      this.lines.push('');
      this.line('connectedCallback() {');
      this.line('  if (this.#remove) return;');
      if (prepare) {
        this.line('  const args = this.#args();');
        this.line(`  ${prepare}`);
      }
      this.line(`  const [[node, update], remove] = $$owned(() => $$${name}(${args.join(', ')}));`);
      this.line('  this.#update = update ?? null;');
      this.line('  this.#remove = remove;');
      this.line('  this.shadowRoot.append(node);');
      this.line('}');
      this.lines.push('');
      this.line('disconnectedCallback() {');
      this.line('  queueMicrotask(() => {');
      this.line('    if (this.isConnected || !this.#remove) return;');
      this.line('    this.#remove();');
      this.line('    this.#update = this.#remove = null;');
      this.line('    this.shadowRoot.replaceChildren();');
      this.line('  });');
      this.line('}');
      if (observed.length > 0) {
        this.lines.push('');
        this.line('attributeChangedCallback(name, old, value) {');
        this.line('  switch (name) {');
        props.forEach((param, i) => {
          const kind = kinds[i];
          if (!kind) return;
          const converted =
            kind === 'string'
              ? 'value ?? undefined'
              : kind === 'number'
                ? 'value === null ? undefined : Number(value)'
                : 'value === null ? undefined : true';
          this.line(`    case ${JSON.stringify(attributeName(param.name.name))}:`);
          this.line(`      this.${param.name.name} = ${converted};`);
          this.line('      break;');
        });
        this.line('  }');
        this.line('}');
      }
      for (const param of props) {
        const prop = param.name.name;
        this.lines.push('');
        this.line(`get ${prop}() {`);
        this.line(`  return this.#values.${prop};`);
        this.line('}');
        this.lines.push('');
        this.line(`set ${prop}(value) {`);
        this.line(`  this.#values.${prop} = value;`);
        this.line('  this.#update?.(...this.#args());');
        this.line('}');
      }
      if (props.length > 0) {
        this.lines.push('');
        this.line('#args() {');
        this.line('  const values = this.#values;');
        this.line('  return [');
        for (const param of props) this.line(`    ${value(param)},`);
        this.line('  ];');
        this.line('}');
      }
    });
    this.blankLine();
    this.line(`class ${className} extends HTMLElement {`);
    this.lines.push(...body);
    this.line('}');
    this.lines.push('');
    const tag = JSON.stringify(htmlTagName(component));
    this.line(`customElements.define(${tag}, ${className});`);
  }
}
