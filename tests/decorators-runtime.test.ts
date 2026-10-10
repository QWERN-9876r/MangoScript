import { describe, expect, it } from 'vitest';
import { compile } from '../src/index.ts';
import { mountWithDom } from './fake-dom.ts';

// Decorators at runtime: their code is inlined into each component they are applied to.

/** Waits until the microtasks that run `mount()` are done. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const counter = `dec counter(start number = 0) {
    public state count = start
    let clicks = 0

    public func add() {
        count++
        clicks++
    }
}
`;

const logged = (name: string) => `dec ${name}() {
    mount() {
        console.log("mount ${name}")
        return () => console.log("cleanup ${name}")
    }
}
`;

describe('generated code', () => {
  it('inlines the decorator with its names prefixed', () => {
    const { code, diagnostics } = compile(`${counter}@counter(5)
comp Clicker() {
    return <button onClick={@counter.add()}>{get(@counter.count)}</button>
}
document.body.append(<Clicker />)
`);

    expect(diagnostics).toEqual([]);
    expect(code).toContain(`  const $$counter$start = 5;
  let $$counter$count = $$counter$start;
  let $$counter$clicks = 0;

  function $$counter$add() {
    $$counter$count++;
    $$updateCounter$count2();
    $$counter$clicks++;
  }
`);
    expect(code).toContain('const $$text4 = document.createTextNode($$counter$count);');
    expect(code).not.toContain('dec');
  });
});

describe('running', () => {
  it('updates the markup that reads public state', () => {
    const { body } = mountWithDom(`${counter}@counter(5)
comp Clicker(label string) {
    return <button onClick={@counter.add()}>{label}: {get(@counter.count)}</button>
}
document.body.append(<Clicker label="a" />, <Clicker label="b" />)
`);

    body.find('button', 1).click();
    body.find('button', 1).click();
    expect(String(body)).toBe('<body><button>a: 5</button><button>b: 7</button></body>');
  });

  it('keeps the names of the decorator apart from the component', () => {
    const { body } = mountWithDom(`${counter}@counter
comp Clicker() {
    state count = 100
    func add() {
        count++
    }
    return <button onClick={add(); @counter.add()}>{count} {get(@counter.count)}</button>
}
document.body.append(<Clicker />)
`);

    body.find('button').click();
    expect(String(body)).toBe('<body><button>101 1</button></body>');
  });

  it('mounts the component, then the decorators from the inside out', async () => {
    const { output, body } = mountWithDom(`${logged('outer')}${logged('inner')}@outer
@inner
comp Box() {
    mount() {
        console.log("mount box")
        return () => console.log("cleanup box")
    }
    return <p>box</p>
}
comp App() {
    state shown = true
    return <div>
        <button onClick={shown = false}>hide</button>
        {if shown {
            <Box />
        }}
    </div>
}
document.body.append(<App />)
`);

    await flush();
    expect(output).toEqual(['mount box', 'mount inner', 'mount outer']);
    body.find('button').click();
    expect(output.slice(3)).toEqual(['cleanup outer', 'cleanup inner', 'cleanup box']);
  });

  it('mounts the decorators whichever return the component takes', async () => {
    const { output } = mountWithDom(`${logged('watched')}@watched
comp Item(empty bool) {
    if empty {
        return <p>empty</p>
    }
    return <ul />
}
document.body.append(<Item empty={true} />, <Item empty={false} />)
`);

    await flush();
    expect(output).toEqual(['mount watched', 'mount watched']);
  });

  it('computes arguments again when the properties they read change', () => {
    const { body } = mountWithDom(`dec greeting(who string) {
    public func text() string {
        return "Hi, " + who
    }
}
@greeting(name + "!")
comp Greeting(name string) {
    return <p>{@greeting.text()}</p>
}
comp App() {
    state name = "Ann"
    return <div>
        <button onClick={name = "Bob"}>rename</button>
        <Greeting name={name} />
    </div>
}
document.body.append(<App />)
`);

    expect(body.find('p').toString()).toBe('<p>Hi, Ann!</p>');
    body.find('button').click();
    expect(body.find('p').toString()).toBe('<p>Hi, Bob!</p>');
  });

  it('works with components that become functions', async () => {
    const { body, output } =
      mountWithDom(`${counter}${logged('watched')}type Item { name string; children []Item }
@counter
@watched
comp Tree(item Item) {
    return <li onClick={@counter.add()}>
        {item.name} {get(@counter.count)}
        <ul>{for child in item.children { <Tree item={child} /> }}</ul>
    </li>
}
document.body.append(<Tree item={{ name: "root", children: [{ name: "leaf", children: [] }] }} />)
`);

    await flush();
    expect(output).toEqual(['mount watched', 'mount watched']);
    body.find('li', 1).click();
    expect(String(body)).toBe('<body><li>root 0<ul><li>leaf 1<ul></ul></li></ul></li></body>');
  });

  it('works with web components', () => {
    const { body } = mountWithDom(`${counter}@html-tag
@counter(10)
comp clickBox() {
    return <button onClick={@counter.add()}>{get(@counter.count)}</button>
}
document.body.append(<click-box />)
`);
    const button = body.find('click-box').shadowRoot!.find('button');

    button.click();
    expect(String(button)).toBe('<button>11</button>');
  });
});
