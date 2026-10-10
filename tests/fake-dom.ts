import { expect } from 'vitest';
import { compile } from '../src/index.ts';

// A tiny DOM, enough to run generated code in tests without a browser.

/** Observers of insertions, as MutationObserver with `childList` and `subtree` on the document. */
const observers = new Set<FakeMutationObserver>();

class FakeMutationObserver {
  private readonly callback: () => void;

  constructor(callback: () => void) {
    this.callback = callback;
  }

  observe(): void {
    observers.add(this);
  }

  disconnect(): void {
    observers.delete(this);
  }

  /** As in the DOM, observers learn about changes in a microtask. */
  static notify(): void {
    for (const observer of observers)
      queueMicrotask(() => {
        if (observers.has(observer)) observer.callback();
      });
  }
}

/** The custom elements of the program that runs now. */
let registry: FakeCustomElements | null = null;

export class FakeNode {
  readonly tagName: string;
  /** 1 for elements, 3 for text, 11 for fragments and shadow roots, as in the DOM. */
  readonly nodeType: number;
  parentNode: FakeNode | null = null;
  readonly childNodes: FakeNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  readonly style: Record<string, string> = {};
  shadowRoot: FakeNode | null = null;
  /** The element of a shadow root. */
  host: FakeNode | null = null;
  [property: string]: unknown;

  constructor(tagName: string, data?: unknown) {
    this.tagName = tagName;
    this.nodeType = tagName === '#text' ? 3 : tagName.startsWith('#') ? 11 : 1;
    if (data !== undefined) this.data = data;
  }

  /** The body of the fake document is in the document; so are the nodes inside it. */
  get isConnected(): boolean {
    return (
      this.tagName === 'body' ||
      (this.parentNode?.isConnected ?? false) ||
      (this.host?.isConnected ?? false)
    );
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }

  get nextSibling(): FakeNode | null {
    if (!this.parentNode) return null;

    const siblings = this.parentNode.childNodes;

    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  append(...items: unknown[]): void {
    this.insertBefore(null, items);
  }

  before(...items: unknown[]): void {
    if (!this.parentNode) throw new Error('before() on a node without a parent');
    this.parentNode.insertBefore(this, items);
  }

  remove(): void {
    if (!this.parentNode) return;

    const connected = this.isConnected;
    const siblings = this.parentNode.childNodes;

    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
    if (connected) registry?.disconnected(this);
  }

  replaceChildren(...items: unknown[]): void {
    for (const child of [...this.childNodes]) child.remove();
    this.append(...items);
  }

  attachShadow(): FakeNode {
    const root = new FakeNode('#shadow-root');

    root.host = this;
    this.shadowRoot = root;

    return root;
  }

  private insertBefore(reference: FakeNode | null, items: unknown[]): void {
    const nodes = items.flatMap((item) => {
      if (!(item instanceof FakeNode)) return [new FakeNode('#text', String(item))];

      // As in the DOM, inserting a fragment moves its children.
      return item.nodeType === 11 ? [...item.childNodes] : [item];
    });

    for (const node of nodes) node.remove();

    const index = reference ? this.childNodes.indexOf(reference) : this.childNodes.length;

    this.childNodes.splice(index, 0, ...nodes);
    for (const node of nodes) node.parentNode = this;
    if (this.isConnected) for (const node of nodes) registry?.connected(node);
    if (nodes.length > 0) FakeMutationObserver.notify();
  }

  setAttribute(name: string, value: unknown): void {
    const old = this.attributes.get(name) ?? null;

    this.attributes.set(name, String(value));
    registry?.attributeChanged(this, name, old, String(value));
  }

  removeAttribute(name: string): void {
    const old = this.attributes.get(name) ?? null;

    this.attributes.delete(name);
    registry?.attributeChanged(this, name, old, null);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ type, currentTarget: this, preventDefault() {} });
    }
  }

  click(): void {
    this.dispatch('click');
  }

  /** The elements with this tag inside the node, in document order. */
  findAll(tag: string): FakeNode[] {
    return this.childNodes.flatMap((child) => [
      ...(child.tagName === tag ? [child] : []),
      ...child.findAll(tag),
    ]);
  }

  find(tag: string, index = 0): FakeNode {
    const found = this.findAll(tag)[index];

    if (!found) throw new Error(`no <${tag}> #${index}`);

    return found;
  }

  /** HTML-like text: properties that were set are shown as attributes. */
  toString(): string {
    if (this.nodeType === 3) return String(this.data);

    const shadow = this.shadowRoot ? `<#shadow-root>${String(this.shadowRoot)}</#shadow-root>` : '';
    const content = shadow + this.childNodes.map(String).join('');

    if (this.nodeType === 11) return content;

    const shown = ['id', 'className', 'href', 'type', 'value', 'checked', 'disabled', 'htmlFor'];
    const attributes = [
      ...shown
        .filter((name) => this[name] !== undefined)
        .map((name) => `${name}=${String(this[name])}`),
      ...[...this.attributes].map(([name, value]) => `${name}=${value}`),
      ...(this.style.cssText ? [`style=${this.style.cssText}`] : []),
    ];
    const open = [this.tagName, ...attributes].join(' ');

    return `<${open}>${content}</${this.tagName}>`;
  }
}

type ElementClass = (new () => FakeNode) & { observedAttributes?: string[] };

/** The node and its descendants, with the content of shadow roots, in document order. */
function* shadowIncluding(node: FakeNode): Generator<FakeNode> {
  yield node;
  for (const child of node.shadowRoot?.childNodes ?? []) yield* shadowIncluding(child);
  for (const child of node.childNodes) yield* shadowIncluding(child);
}

function callback(node: FakeNode, name: string, ...args: unknown[]): void {
  (node[name] as ((...args: unknown[]) => void) | undefined)?.call(node, ...args);
}

/**
 * `customElements` of one program: defined classes, upgrades of elements created before
 * `define`, and the callbacks of connection, disconnection and attribute changes.
 */
class FakeCustomElements {
  private readonly body: FakeNode;
  private readonly classes = new Map<string, ElementClass>();
  private readonly tags = new Map<unknown, string>();
  private readonly upgraded = new WeakSet<FakeNode>();
  private upgrading: FakeNode | null = null;
  /** The base class: `super()` of a custom element returns the node that is being upgraded. */
  readonly HTMLElement = baseClass(this);

  constructor(body: FakeNode) {
    this.body = body;
  }

  define(tag: string, element: ElementClass): void {
    if (this.classes.has(tag)) throw new Error(`"${tag}" has already been defined`);
    this.classes.set(tag, element);
    this.tags.set(element, tag);
    for (const node of [...shadowIncluding(this.body)]) {
      if (node.tagName === tag) this.upgrade(node);
    }
  }

  create(tag: string): FakeNode {
    const element = this.classes.get(tag);

    return element ? new element() : new FakeNode(tag);
  }

  /** Called by the base class while an element is constructed. */
  construct(target: unknown): FakeNode {
    const node = this.upgrading ?? new FakeNode(this.tags.get(target) ?? '');

    this.upgrading = null;
    this.upgraded.add(node);

    return node;
  }

  connected(root: FakeNode): void {
    for (const node of shadowIncluding(root)) {
      if (this.upgraded.has(node)) callback(node, 'connectedCallback');
      else this.upgrade(node);
    }
  }

  disconnected(root: FakeNode): void {
    for (const node of shadowIncluding(root)) {
      if (this.upgraded.has(node)) callback(node, 'disconnectedCallback');
    }
  }

  attributeChanged(node: FakeNode, name: string, old: string | null, value: string | null): void {
    const element = this.classes.get(node.tagName);

    if (this.upgraded.has(node) && element?.observedAttributes?.includes(name)) {
      callback(node, 'attributeChangedCallback', name, old, value);
    }
  }

  private upgrade(node: FakeNode): void {
    const element = this.classes.get(node.tagName);

    if (!element || this.upgraded.has(node)) return;
    this.upgrading = node;
    new element();
    for (const [name, value] of node.attributes) this.attributeChanged(node, name, null, value);
    if (node.isConnected) callback(node, 'connectedCallback');
  }
}

function baseClass(registry: FakeCustomElements): new () => FakeNode {
  function HTMLElement(): FakeNode {
    const node = registry.construct(new.target);

    Object.setPrototypeOf(node, (new.target as { prototype: object }).prototype);

    return node;
  }

  HTMLElement.prototype = Object.create(FakeNode.prototype) as object;

  return HTMLElement as unknown as new () => FakeNode;
}

/** Compiles and runs a program with a fake `document`; returns what it printed and the body. */
export function mountWithDom(source: string): { output: string[]; body: FakeNode } {
  const { code, diagnostics } = compile(source);

  expect(diagnostics).toEqual([]);

  return mountJsWithDom(code);
}

/** Runs generated JS without imports and exports, e.g. a bundle, with a fake `document`. */
export function mountJsWithDom(code: string): { output: string[]; body: FakeNode } {
  const output: string[] = [];
  const fakeConsole = { log: (...args: unknown[]) => output.push(args.map(String).join(' ')) };
  const body = new FakeNode('body');
  const customElements = new FakeCustomElements(body);

  registry = customElements;

  const document = {
    body,
    createElement: (tag: string) => customElements.create(tag),
    createDocumentFragment: () => new FakeNode('#fragment'),
    createTextNode: (data: unknown) => new FakeNode('#text', data),
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const program = new Function(
    'console',
    'document',
    'MutationObserver',
    'customElements',
    'HTMLElement',
    `"use strict";\n${code}`,
  ) as (console: typeof fakeConsole, document: unknown, ...dom: unknown[]) => void;

  program(fakeConsole, document, FakeMutationObserver, customElements, customElements.HTMLElement);

  return { output, body };
}

/** Compiles and runs a program with a fake `document`; returns what it printed. */
export function runWithDom(source: string): string[] {
  return mountWithDom(source).output;
}
