import { describe, expect, it } from 'vitest';
import { check } from '../src/checker/checker.ts';
import { parse } from '../src/parser/parser.ts';
import { mountWithDom } from './fake-dom.ts';

// `mount() { ... }` in components: it runs once the markup is in the document, and the function it
// returns runs when `{if}`, `{switch}` or `{for}` removes the markup.

function errors(source: string): string[] {
  const { program, diagnostics } = parse(source);

  if (diagnostics.length > 0) return diagnostics.map((d) => d.message);

  return check(program).diagnostics.map((d) => d.message);
}

/** Waits until the microtasks that run `mount()` are done. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const timer = `comp Timer(name string) {
    mount() {
        console.log("start", name)
        return () => console.log("stop", name)
    }
    return <p>{name}</p>
}
`;

describe('syntax', () => {
  it.each([
    ['mount() {\n}', 'mount() can only be declared inside a component'],
    [
      'comp A() {\n    if true {\n        mount() {\n        }\n    }\n    return <p />\n}',
      'mount() is declared at the top level of a component, not inside blocks or functions',
    ],
    [
      'comp A() {\n    mount() {\n        state x = 1\n    }\n    return <p />\n}',
      'state is declared at the top level of a component, not inside blocks or functions',
    ],
  ])('reports %j', (source, message) => {
    expect(errors(source)).toEqual([message]);
  });

  it('leaves functions named mount alone', () => {
    expect(errors('func mount() {\n}\nmount()')).toEqual([]);
  });
});

describe('types', () => {
  it('checks the body and what it returns', () => {
    expect(
      errors(`comp A() {
    mount() {
        return 1
    }
    return <p />
}`),
    ).toEqual([
      'mount() returns the function that cleans up, e.g. return () => clearInterval(timer), not number',
    ]);
    expect(
      errors(`comp A() {
    mount() {
        const n number = "one"
    }
    return <p />
}`),
    ).toEqual(['cannot use string as number']);
  });

  it('allows no cleanup, a cleanup, or a cleanup only sometimes', () => {
    expect(
      errors(`comp A(on bool) {
    mount() {
        console.log("no cleanup")
    }
    mount() {
        return () => console.log("cleanup")
    }
    mount() {
        if !on {
            return null
        }
        return () => console.log("cleanup")
    }
    return <p />
}`),
    ).toEqual([]);
  });
});

describe('running', () => {
  it('runs once the markup is in the document', async () => {
    const { output } = mountWithDom(`comp Box() {
    const box = <p>box</p>
    mount() {
        console.log("mounted", box.parentNode != null)
    }
    return box
}
console.log("created")
document.body.append(<Box />)
console.log("appended")
`);

    expect(output).toEqual(['created', 'appended']);
    await flush();
    expect(output).toEqual(['created', 'appended', 'mounted true']);
  });

  it('waits until markup created earlier is inserted', async () => {
    const { output, body } = mountWithDom(`${timer}const later = <Timer name="later" />
document.body.append(<button onClick={document.body.append(later)}>insert</button>)
`);

    await flush();
    expect(output).toEqual([]);
    body.find('button').click();
    await flush();
    expect(output).toEqual(['start later']);
  });

  it('waits for the parent that holds the component to be inserted', async () => {
    const { output, body } = mountWithDom(`${timer}comp Pair() {
    mount() {
        console.log("pair")
    }
    return <>
        <p>a</p>
        <p>b</p>
    </>
}
const box = <div>
    <Timer name="inner" />
    <Pair />
</div>
document.body.append(<button onClick={document.body.append(box)}>insert</button>)
`);

    await flush();
    expect(output).toEqual([]);
    body.find('button').click();
    await flush();
    expect(output).toEqual(['start inner', 'pair']);
  });

  it('never mounts markup that {if} removed before it was inserted', async () => {
    const { output, body } = mountWithDom(`${timer}comp Root() {
    state shown = true
    const box = <div>
        {if shown {
            <Timer name="a" />
        }}
    </div>
    return <div>
        <button onClick={shown = false}>hide</button>
        <button onClick={document.body.append(box)}>insert</button>
    </div>
}
document.body.append(<Root />)
`);

    await flush();

    const [hide, insert] = body.findAll('button');

    hide!.click();
    insert!.click();
    await flush();
    expect(output).toEqual([]);
  });

  it('updates the markup when it changes state', async () => {
    const { body } = mountWithDom(`comp Status() {
    state text = "загрузка"
    mount() {
        text = "готово"
    }
    return <p>{text}</p>
}
document.body.append(<Status />)
`);

    expect(String(body)).toBe('<body><p>загрузка</p></body>');
    await flush();
    expect(String(body)).toBe('<body><p>готово</p></body>');
  });

  it('cleans up when {if} removes the component', async () => {
    const { output, body } = mountWithDom(`${timer}comp App() {
    state shown = true
    return <div>
        <button onClick={shown = !shown}>toggle</button>
        {if shown {
            <Timer name="a" />
        }}
    </div>
}
document.body.append(<App />)
`);

    await flush();
    expect(output).toEqual(['start a']);
    body.find('button').click();
    expect(output).toEqual(['start a', 'stop a']);
    body.find('button').click();
    await flush();
    expect(output).toEqual(['start a', 'stop a', 'start a']);
  });

  it('cleans up removed blocks of a list, with the blocks nested in them', async () => {
    const { output, body } = mountWithDom(`${timer}comp App() {
    state names = ["a", "b", "c"]
    return <ul>
        <button onClick={names = names.filter(name => name != "b")}>remove</button>
        {for name in names {
            <li>
                {if name != "" {
                    <Timer name={name} />
                }}
            </li>
        }}
    </ul>
}
document.body.append(<App />)
`);

    await flush();
    expect(output).toEqual(['start a', 'start b', 'start c']);
    body.find('button').click();
    await flush();
    expect(output).toEqual(['start a', 'start b', 'start c', 'stop b']);
    expect(body.findAll('p').map((p) => String(p))).toEqual(['<p>a</p>', '<p>c</p>']);
  });

  it('cleans up when a branch of ?: in markup is replaced', async () => {
    const { output, body } = mountWithDom(`${timer}comp App() {
    state first = true
    return <div>
        <button onClick={first = !first}>switch</button>
        {first ? <Timer name="a" /> : <Timer name="b" />}
    </div>
}
document.body.append(<App />)
`);

    await flush();
    expect(output).toEqual(['start a']);
    body.find('button').click();
    await flush();
    expect(output).toEqual(['start a', 'stop a', 'start b']);
  });

  it('skips mount when the markup is removed before it runs', async () => {
    const { output, body } = mountWithDom(`${timer}comp App() {
    state shown = false
    return <div>
        <button onClick={
            shown = true
            shown = false
        }>flash</button>
        {if shown {
            <Timer name="a" />
        }}
    </div>
}
document.body.append(<App />)
`);

    body.find('button').click();
    await flush();
    expect(output).toEqual([]);
  });

  it('works in recursive components', async () => {
    const { output, body } = mountWithDom(`interface Node {
    name string
    children []Node
}

comp Tree(node Node) {
    state open = true
    mount() {
        console.log("start", node.name)
        return () => console.log("stop", node.name)
    }
    return <div>
        <button onClick={open = !open}>{node.name}</button>
        {if open {
            for child in node.children {
                <Tree node={child} />
            }
        }}
    </div>
}

document.body.append(<Tree node={{ name: "root", children: [{ name: "leaf", children: [] }] }} />)
`);

    await flush();
    expect(output).toEqual(['start root', 'start leaf']);
    body.find('button').click();
    expect(output).toEqual(['start root', 'start leaf', 'stop leaf']);
  });
});
