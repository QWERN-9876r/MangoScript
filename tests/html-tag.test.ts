import { describe, expect, it } from 'vitest';
import { check } from '../src/checker/checker.ts';
import { compile } from '../src/index.ts';
import { parse } from '../src/parser/parser.ts';
import { FakeNode, mountWithDom } from './fake-dom.ts';

// `@html-tag` components: web components with a shadow root, attributes and JS properties.

function errors(source: string): string[] {
  const { program, diagnostics } = parse(source);
  if (diagnostics.length > 0) return diagnostics.map((d) => d.message);
  return check(program).diagnostics.map((d) => d.message);
}

/** Waits until the microtasks of `mount()` and of disconnection are done. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const counter = `@html-tag
comp itemCounter(label string, count number = 1, big bool, children Content) {
    state clicks = 0
    return <p>
        <b>{label}</b> {count} {big ? "big" : "small"} {clicks}
        <button onClick={clicks++}>+</button>
        {children}
    </p>
}
`;

const timer = `@html-tag("app-timer")
comp Timer(name string) {
    mount() {
        console.log("start", name)
        return () => console.log("stop", name)
    }
    return <p>{name}</p>
}
`;

function shadow(node: FakeNode): string {
  return String(node.shadowRoot);
}

describe('syntax', () => {
  it('takes the tag from the name or from the decorator', () => {
    const { program, diagnostics } = parse(
      '@html-tag\ncomp mainPage() {\n    return <p />\n}\n@html-tag("app-page") comp Page() {\n    return <p />\n}',
    );
    expect(diagnostics).toEqual([]);
    const [first, second] = program.body;
    expect(first?.kind === 'ComponentDeclaration' && first.htmlTag?.name).toBe(null);
    expect(second?.kind === 'ComponentDeclaration' && second.htmlTag?.name?.value).toBe('app-page');
  });

  it.each([
    [
      '@html\ncomp A() {\n    return <p />\n}',
      'unknown decorator "@html": the only one is @html-tag',
    ],
    [
      '@html-tag\nfunc a() {\n}',
      '@html-tag is written before a component, as in @html-tag comp MainPage() { ... }',
    ],
  ])('reports %j', (source, message) => {
    expect(errors(source)).toEqual([message]);
  });
});

describe('checks', () => {
  it('reports tags that HTML does not accept', () => {
    expect(
      errors(`@html-tag
comp Page() {
    return <p />
}
@html-tag("App-Page")
comp A() {
    return <p />
}
@html-tag("font-face")
comp B() {
    return <p />
}`),
    ).toEqual([
      'the tag of "Page" would be "page", not a valid name of a web component: it must have a hyphen; give one, e.g. @html-tag("app-page")',
      '"App-Page" is not a valid name of a web component: it must start with a lowercase letter and have only lowercase letters, digits, "-", "." and "_"',
      '"font-face" is not a valid name of a web component: HTML reserves this name',
    ]);
  });

  it('reports a tag used twice', () => {
    expect(
      errors(`@html-tag("app-card")
comp Card() {
    return <p />
}
@html-tag("app-card")
comp OtherCard() {
    return <p />
}`),
    ).toEqual(['the tag "app-card" is already used by Card']);
  });

  it('reports properties of HTMLElement and properties that may be missing', () => {
    expect(
      errors(`interface User {
    name string
}
@html-tag("app-user")
comp UserCard(id string, user User, onPick func(), extra ?User, tags []string) {
    return <p />
}`),
    ).toEqual([
      'a web component cannot have the property "id": HTMLElement has it already',
      '"user" needs a default value: the element can be created without it, e.g. in HTML, and User has no zero value',
      '"onPick" needs a default value: the element can be created without it, e.g. in HTML, and func() has no zero value',
    ]);
  });

  it('checks the properties given in markup', () => {
    expect(
      errors(`${counter}
const a = <item-counter label="a" count={2} big />
const b = <item-counter label={1} item-count="x" />`),
    ).toEqual(['cannot use number as string for "label" of <item-counter>']);
    expect(
      errors(`${counter}
const b = <item-counter count="x" />`),
    ).toEqual(['cannot use string as number for "count" of <item-counter>']);
  });
});

describe('runtime', () => {
  it('renders into the shadow root and converts attributes by the property types', () => {
    const { body } = mountWithDom(`${counter}
const element = document.createElement("item-counter")
element.setAttribute("label", "Apples")
element.setAttribute("count", "3")
document.body.append(element)`);
    const element = body.find('item-counter');
    expect(shadow(element)).toBe('<p><b>Apples</b> 3 small 0<button>+</button><slot></slot></p>');
    element.setAttribute('big', '');
    element.setAttribute('count', '7');
    expect(shadow(element)).toBe('<p><b>Apples</b> 7 big 0<button>+</button><slot></slot></p>');
    // Without the attribute, the property has its default value again.
    element.removeAttribute('count');
    element.removeAttribute('big');
    element.shadowRoot!.find('button').click();
    expect(shadow(element)).toBe('<p><b>Apples</b> 1 small 1<button>+</button><slot></slot></p>');
  });

  it('sets properties from markup, also from the state of a component', () => {
    const { body } = mountWithDom(`${counter}
comp App() {
    state n = 1
    return <div>
        <item-counter label="A" count={n}>inside</item-counter>
        <button onClick={n++}>more</button>
    </div>
}
document.body.append(<App />)`);
    const element = body.find('item-counter');
    expect(element.count).toBe(1);
    expect(String(element.childNodes[0])).toBe('inside');
    expect(shadow(element)).toContain('<b>A</b> 1 small');
    body.find('button').click();
    expect(shadow(element)).toContain('<b>A</b> 2 small');
  });

  it('takes arrays and functions as JS properties', () => {
    const { body, output } = mountWithDom(`@html-tag("tag-list")
comp TagList(tags []string, onPick ?func(string)) {
    return <ul>{for tag in tags { <li onClick={onPick?.(tag)}>{tag}</li> }}</ul>
}
const list = <tag-list tags={["a", "b"]} onPick={(tag) => console.log("picked", tag)} />
document.body.append(list)`);
    const list = body.find('tag-list');
    expect(shadow(list)).toBe('<ul><li>a</li><li>b</li></ul>');
    list.tags = ['c'];
    expect(shadow(list)).toBe('<ul><li>c</li></ul>');
    list.shadowRoot!.find('li').click();
    expect(output).toEqual(['picked c']);
  });

  it('mounts when connected, cleans up when removed, and keeps its markup when moved', async () => {
    const { body, output } = mountWithDom(`${timer}
document.body.append(<app-timer name="a" />)`);
    await flush();
    expect(output).toEqual(['start a']);
    const element = body.find('app-timer');
    const box = new FakeNode('div');
    body.append(box);
    box.append(element);
    await flush();
    expect(output).toEqual(['start a']);
    element.remove();
    await flush();
    expect(output).toEqual(['start a', 'stop a']);
    expect(shadow(element)).toBe('');
    body.append(element);
    await flush();
    expect(output).toEqual(['start a', 'stop a', 'start a']);
    expect(shadow(element)).toBe('<p>a</p>');
  });

  it('defines the elements at the end of the module', () => {
    const { code } = compile(`${timer}
console.log("ready")`);
    expect(code.trimEnd().split('\n').at(-1)).toBe(
      'customElements.define("app-timer", $$TimerElement);',
    );
    expect(code).toContain('static observedAttributes = ["name"];');
  });
});
