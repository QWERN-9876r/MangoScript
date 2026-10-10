import { describe, expect, it } from 'vitest';
import { check } from '../src/checker/checker.ts';
import { compile } from '../src/index.ts';
import { parse } from '../src/parser/parser.ts';

// The standard library and the DOM from TypeScript's lib files, which compile() uses in Node.
// Without them (in the browser), the hand-written types of builtins.ts and dom.ts are used.

function errors(source: string): string[] {
  return compile(source).diagnostics.map((d) => d.message);
}

describe('globals', () => {
  it('types document and window', () => {
    expect(
      errors(`document.getElementById("app").focus()
document.getElementById("app")?.focus()
const width number = window.innerWidth
document.body.append("text")`),
    ).toEqual(['this value may be null: check it for null or use "?."']);
  });

  it('types fetch and promises', () => {
    expect(
      errors(`fetch("/data.json")
    .then(response => response.text())
    .then(text => console.log(text.trimEnd()))
fetch(1)
Promise.resolve(1).then(n => console.log(n.toFixed(2)))`),
    ).toEqual([
      'no overload fits these arguments: func(string | Request | URL, ?RequestInit) Promise[Response]',
    ]);
  });

  it('types Map, Set, Date and URL with generics', () => {
    expect(
      errors(`let scores Map[string, number] = new Map()
scores.set("anna", 1)
const score ?number = scores.get("anna")
scores.set(1, 1)
const seen = new Set([1, 2])
const has bool = seen.has(1)
const year number = new Date().getFullYear()
const host string = new URL("https://example.com").host`),
    ).toEqual(['cannot use number as string in argument 1']);
  });

  it('keeps the built-in types where they exist', () => {
    // `error` and console come from builtins.ts, also in the browser.
    expect(errors('const e error = error("x")\nconsole.log(Math.max(1, 2))')).toEqual([]);
  });

  it('has the browser-free check without a library', () => {
    const { program } = parse('document.whatever(1)\nconst n number = window');

    expect(check(program).diagnostics).toEqual([]);
  });
});

describe('members of strings and arrays', () => {
  it('adds the members that the built-in types do not list', () => {
    expect(
      errors(`const sorted []number = [3, 1, 2].toSorted()
const padded string = "7".padStart(3, "0")
const code ?number = "a".codePointAt(0)
const wrong string = [1].toSorted()`),
    ).toEqual(['cannot use []number as string']);
  });
});

describe('markup', () => {
  it('gives elements the types of HTMLElementTagNameMap', () => {
    expect(
      errors(`const input HTMLInputElement = <input />
input.focus()
const start ?number = input.selectionStart
input.value = 1`),
    ).toEqual(['cannot use number as string']);
  });

  it('gives handlers the event of HTMLElementEventMap with the element as currentTarget', () => {
    expect(
      errors(`const button = <button onClick={console.log(event.clientX, event.currentTarget.disabled)}>ok</button>
const input = <input onKeyDown={console.log(event.key)} />
const wrong = <button onClick={console.log(event.key)}>x</button>`),
    ).toEqual(['PointerEvent has no member "key"']);
  });

  it('narrows DOM types with instanceof', () => {
    expect(
      errors(`func show(node Node) {
    if node instanceof HTMLInputElement {
        console.log(node.value)
    }
}`),
    ).toEqual([]);
  });

  it('accepts DOM nodes as content', () => {
    expect(
      errors(`const list = document.createElement("ul")
const page = <main>{list}{document.createTextNode("text")}</main>`),
    ).toEqual([]);
  });
});
