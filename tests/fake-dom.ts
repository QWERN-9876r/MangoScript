import { expect } from 'vitest';
import { compile } from '../src/index.ts';

// A tiny DOM, enough to run generated code in tests without a browser.

export class FakeNode {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly children: (FakeNode | string)[] = [];
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  readonly style: Record<string, string> = {};
  [property: string]: unknown;

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  append(...items: unknown[]): void {
    for (const item of items) {
      if (item instanceof FakeNode && item.tagName === '#fragment') {
        // As in the DOM, appending a fragment moves its children.
        this.children.push(...item.children.splice(0));
      } else {
        this.children.push(item instanceof FakeNode ? item : String(item));
      }
    }
  }

  setAttribute(name: string, value: unknown): void {
    this.attributes.set(name, String(value));
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

  /** HTML-like text: properties that were set are shown as attributes. */
  toString(): string {
    const shown = ['id', 'className', 'href', 'type', 'value', 'checked', 'disabled', 'htmlFor'];
    const attributes = [
      ...shown
        .filter((name) => this[name] !== undefined)
        .map((name) => `${name}=${String(this[name])}`),
      ...[...this.attributes].map(([name, value]) => `${name}=${value}`),
      ...(this.style.cssText ? [`style=${this.style.cssText}`] : []),
    ];
    const open = [this.tagName, ...attributes].join(' ');
    return `<${open}>${this.children.map(String).join('')}</${this.tagName}>`;
  }
}

/** Compiles and runs a program with a fake `document`; returns what it printed. */
export function runWithDom(source: string): string[] {
  const { code, diagnostics } = compile(source);
  expect(diagnostics).toEqual([]);
  const output: string[] = [];
  const fakeConsole = { log: (...args: unknown[]) => output.push(args.map(String).join(' ')) };
  const document = {
    createElement: (tag: string) => new FakeNode(tag),
    createDocumentFragment: () => new FakeNode('#fragment'),
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const program = new Function('console', 'document', `"use strict";\n${code}`) as (
    console: typeof fakeConsole,
    document: unknown,
  ) => void;
  program(fakeConsole, document);
  return output;
}
