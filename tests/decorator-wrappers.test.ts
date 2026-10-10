import { describe, expect, it } from 'vitest';
import { check } from '../src/checker/checker.ts';
import { compile } from '../src/index.ts';
import { parse } from '../src/parser/parser.ts';
import { mountWithDom } from './fake-dom.ts';

// Wrappers of decorators, `return (content Element) => <div>{content}</div>`: they get what the
// component returns, and what they return is what the component gives in the end.

function errors(source: string): string[] {
  const { program, diagnostics } = parse(source);

  if (diagnostics.length > 0) return diagnostics.map((d) => d.message);

  return check(program).diagnostics.map((d) => d.message);
}

/** Waits until the microtasks that run `mount()` are done. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const notFound = `dec notFound() {
    state missing = false

    public func show() {
        missing = true
    }

    return (page Element) => <div>{missing ? <b>404</b> : page}</div>
}
`;

const framed = `dec framed(title string) {
    return (content Element) => {
        const heading = <h1>{title}</h1>
        return <section>{heading}{content}</section>
    }
}
`;

/** A decorator `a` with the given body, applied to a component with the given body. */
const page = (decorator: string, body = 'return <p />', after = '') =>
  errors(`dec a() {\n    ${decorator}\n}\n@a\ncomp Page() {\n    ${body}\n}\n${after}`);

describe('types', () => {
  it('gives the use the type of what the outermost wrapper returns', () => {
    expect(
      errors(`${notFound}@notFound\ncomp A() {\n    return <p />\n}\nconst e Element = <A />`),
    ).toEqual([]);
    expect(
      page(
        'return (c Element) => <section>{c}</section>',
        'return <p />',
        'const s HTMLElement = <Page />',
      ),
    ).toEqual([]);
    // Without the wrapper, <Page /> would be an input.
    expect(
      page('return (c Element) => c', 'return <input />', 'const i HTMLInputElement = <Page />'),
    ).toEqual(['cannot use HTMLElement as HTMLInputElement: missing "value"']);
    expect(page('return func(c Element) Element {\n        return c\n    }')).toEqual([]);
  });

  it('checks that the wrapper takes what the component returns', () => {
    expect(page('return (f HTMLFormElement) => f', 'return <div />')).toEqual([
      '@a wraps HTMLFormElement, but Page returns HTMLElement: apply @a to a component that returns HTMLFormElement',
    ]);
    expect(page('return (c Element) => c', 'return <>\n        <p />\n    </>')).toEqual([
      '@a wraps HTMLElement, but Page returns DocumentFragment: apply @a to a component that returns HTMLElement',
    ]);
    expect(
      errors(`dec outer() {
    return (f HTMLFormElement) => f
}
dec inner() {
    return (c Element) => <div>{c}</div>
}
@outer
@inner
comp Page() {
    return <p />
}`),
    ).toEqual([
      '@outer wraps HTMLFormElement, but @inner gives HTMLElement: change the order of the decorators or the type of the wrapper',
    ]);
  });

  it.each([
    [
      'return null',
      'a decorator returns its wrapper, a function literal: return (content Element) => <div>{content}</div>',
    ],
    [
      'return (x Element, y Element) => x',
      'the wrapper takes one parameter, what the component returns: (content Element) => ...',
    ],
    ['return (content) => content', 'cannot infer the type of parameter "content": add a type'],
    [
      'return (n number) => <p />',
      'the wrapper gets markup, so "n" is a Node, an Element or a type of element, not number',
    ],
    ['return (c Element) => 1', 'the wrapper returns markup, not number'],
    [
      'if true {\n        return (c Element) => c\n    }',
      'a decorator returns its wrapper at the end of its body: return (content Element) => <div>{content}</div>',
    ],
    [
      'return (c Element) => {\n        if true {\n            return c\n        }\n        return <div>{c}</div>\n    }',
      'a wrapper returns once, at the end of its body; other returns are not supported yet',
    ],
    [
      'return (c Element) => {\n        console.log(1)\n    }',
      'the wrapper ends with "return <markup>", e.g. return content',
    ],
    [
      'let node = 1\n    return (node Element) => node',
      '"node" of the wrapper hides "node" of @a: rename one of them',
    ],
    [
      'let node = 1\n    return (c Element) => {\n        const node = c\n        return node\n    }',
      '"node" of the wrapper hides "node" of @a: rename one of them',
    ],
    [
      'return (c Element) => {\n        defer console.log(1)\n        return c\n    }',
      'defer is not supported in decorators yet',
    ],
  ])('reports %j', (decorator, message) => {
    expect(page(decorator)).toEqual([message]);
  });
});

describe('generated code', () => {
  it('creates the markup of the component, then the wrapper around it', () => {
    const { code, diagnostics } = compile(`${notFound}@notFound
comp Page() {
    return <p>text</p>
}
document.body.append(<Page />)
`);

    expect(diagnostics).toEqual([]);
    expect(code).toContain(`  const $$notFound$page = document.createElement("p");
  $$notFound$page.append("text");
  const $$div3 = document.createElement("div");`);
    expect(code).toContain('$$page1 = $$div3;');
  });
});

describe('running', () => {
  it('updates both the component and the wrapper', () => {
    const { body } = mountWithDom(`${notFound}@notFound
comp Page() {
    state count = 0
    return <p>
        <button onClick={count++}>+</button>
        <button onClick={@notFound.show()}>hide</button>
        {count}
    </p>
}
document.body.append(<Page />)
`);

    body.find('button').click();
    expect(String(body.find('div'))).toBe(
      '<div><p><button>+</button><button>hide</button>1</p></div>',
    );
    body.find('button', 1).click();
    expect(String(body.find('div'))).toBe('<div><b>404</b></div>');
  });

  it('applies the wrappers from the bottom decorator up', () => {
    const { body } = mountWithDom(`${notFound}${framed}@framed("Title")
@notFound
comp Page() {
    return <p>text</p>
}
document.body.append(<Page />)
`);

    expect(String(body)).toBe(
      '<body><section><h1>Title</h1><div><p>text</p></div></section></body>',
    );
  });

  it('wraps every return of the component and updates the one it takes', () => {
    const { body } = mountWithDom(`${notFound}@notFound
comp Item(empty bool) {
    state count = 0
    if empty {
        return <p onClick={count++}>empty {count}</p>
    }
    return <ul onClick={@notFound.show()} />
}
document.body.append(<Item empty={true} />, <Item empty={false} />)
`);

    body.find('p').click();
    body.find('ul').click();
    expect(String(body)).toBe('<body><div><p>empty 1</p></div><div><b>404</b></div></body>');
  });

  it('mounts with the node the wrapper returns', async () => {
    const { output } = mountWithDom(`dec watched() {
    let node ?Element = null

    mount() {
        console.log(node?.tagName ?? "none")
    }

    return (content Element) => {
        node = content
        return <div>{content}</div>
    }
}
@watched
comp Page() {
    mount() {
        console.log("page")
    }
    return <p />
}
document.body.append(<Page />)
`);

    await flush();
    // The fake DOM keeps tag names as they are written.
    expect(output).toEqual(['page', 'p']);
  });

  it('wraps every return of a component that becomes a function', () => {
    const { body } = mountWithDom(`${notFound}type Item { name string; children []Item }
@notFound
comp Tree(item Item) {
    state count = 0
    if item.children.length == 0 {
        return <i onClick={count++}>{item.name} {count}</i>
    }
    return <ul onClick={@notFound.show()}>{item.name}{for child in item.children { <Tree item={child} /> }}</ul>
}
document.body.append(<Tree item={{ name: "a", children: [{ name: "b", children: [] }] }} />)
`);

    body.find('i').click();
    expect(String(body)).toBe('<body><div><ul>a<div><i>b 1</i></div></ul></div></body>');
    body.find('ul').click();
    expect(String(body)).toBe('<body><div><b>404</b></div></body>');
  });

  it('works with components that become functions and with web components', () => {
    const { body } = mountWithDom(`${framed}type Item { name string; children []Item }
@framed("tree")
comp Tree(item Item) {
    return <ul>{item.name}{for child in item.children { <Tree item={child} /> }}</ul>
}
@html-tag
@framed("box")
comp appBox() {
    return <p />
}
document.body.append(<Tree item={{ name: "a", children: [{ name: "b", children: [] }] }} />, <app-box />)
`);

    expect(String(body.find('section'))).toBe(
      '<section><h1>tree</h1><ul>a<section><h1>tree</h1><ul>b</ul></section></ul></section>',
    );
    expect(String(body.find('app-box').shadowRoot!.find('section'))).toBe(
      '<section><h1>box</h1><p></p></section>',
    );
  });
});
