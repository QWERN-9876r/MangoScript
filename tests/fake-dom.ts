import { expect } from 'vitest';
import { compile } from '../src/index.ts';

// A tiny DOM, enough to run generated code in tests without a browser.

export class FakeNode {
  readonly tagName: string;
  /** 1 for elements, 3 for text, 11 for fragments, as in the DOM. */
  readonly nodeType: number;
  parentNode: FakeNode | null = null;
  readonly childNodes: FakeNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  readonly style: Record<string, string> = {};
  [property: string]: unknown;

  constructor(tagName: string, data?: unknown) {
    this.tagName = tagName;
    this.nodeType = tagName === '#text' ? 3 : tagName === '#fragment' ? 11 : 1;
    if (data !== undefined) this.data = data;
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
    const siblings = this.parentNode.childNodes;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
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
  }

  setAttribute(name: string, value: unknown): void {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
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
    const content = this.childNodes.map(String).join('');
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

/** Compiles and runs a program with a fake `document`; returns what it printed and the body. */
export function mountWithDom(source: string): { output: string[]; body: FakeNode } {
  const { code, diagnostics } = compile(source);
  expect(diagnostics).toEqual([]);
  const output: string[] = [];
  const fakeConsole = { log: (...args: unknown[]) => output.push(args.map(String).join(' ')) };
  const body = new FakeNode('body');
  const document = {
    body,
    createElement: (tag: string) => new FakeNode(tag),
    createDocumentFragment: () => new FakeNode('#fragment'),
    createTextNode: (data: unknown) => new FakeNode('#text', data),
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const program = new Function('console', 'document', `"use strict";\n${code}`) as (
    console: typeof fakeConsole,
    document: unknown,
  ) => void;
  program(fakeConsole, document);
  return { output, body };
}

/** Compiles and runs a program with a fake `document`; returns what it printed. */
export function runWithDom(source: string): string[] {
  return mountWithDom(source).output;
}
