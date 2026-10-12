import { describe, expect, it } from 'vitest';
import { check } from '../src/checker/checker.ts';
import { compile } from '../src/index.ts';
import { parse } from '../src/parser/parser.ts';
import { mountWithDom } from './fake-dom.ts';

// `derived double = count * 2` is computed again when what it reads changes; `effect { ... }` runs
// once the markup is created and again when what it reads changes, and cleans up with `defer`.

function errors(source: string): string[] {
  const { program, diagnostics } = parse(source);

  if (diagnostics.length > 0) return diagnostics.map((d) => d.message);

  return check(program).diagnostics.map((d) => d.message);
}

function js(source: string): string {
  const { code, diagnostics } = compile(source);

  expect(diagnostics).toEqual([]);

  return code;
}

/** A component with `body` before `return <p>{markup}</p>`. */
const component = (body: string, markup = '') =>
  `comp A() {\n    state count = 1\n${body}\n    return <p>${markup}</p>\n}\n`;

describe('syntax', () => {
  it('keeps derived and effect ordinary names elsewhere', () => {
    expect(
      errors(
        'const derived = 1\nfunc effect(x number) number {\n    return x\n}\nconst e = effect(derived)',
      ),
    ).toEqual([]);
  });

  it.each([
    ['func f() {\n    effect {\n    }\n}', 'effect can only be declared inside a component'],
    [
      component('    if true {\n        derived x = count\n    }'),
      'derived is declared at the top level of a component, not inside blocks or functions',
    ],
    [
      component('    derived a, b = count, count'),
      'derived is one name and the expression it is computed from, e.g. derived double = count * 2',
    ],
    [
      component('    derived x number'),
      'derived is one name and the expression it is computed from, e.g. derived double = count * 2',
    ],
  ])('reports %j', (source, message) => {
    expect(errors(source)).toEqual([message]);
  });
});

describe('types', () => {
  it('gives a derived value the type of its expression or the one written', () => {
    expect(
      errors(component('    derived label = `${count} times`\n    const s string = label')),
    ).toEqual([]);
    expect(errors(component('    derived label string = count'))).toEqual([
      'cannot use number as string',
    ]);
  });

  it('keeps a derived value read-only', () => {
    const message = 'cannot assign to "double": it is derived, so change what it is computed from';

    expect(
      errors(component('    derived double = count * 2', '<button onClick={double = 1} />')),
    ).toEqual([message]);
    expect(
      errors(
        'comp A() {\n    state text = ""\n    derived shown = text.trim()\n    return <input bind:value={shown} />\n}',
      ),
    ).toEqual([message.replace('"double"', '"shown"')]);
  });

  it('checks an effect like a handler that returns nothing', () => {
    expect(errors(component('    effect {\n        defer console.log(count)\n    }'))).toEqual([]);
    expect(errors(component('    effect {\n        return 1\n    }'))).toEqual([
      'an effect returns nothing; clean up with defer, e.g. defer clearInterval(timer)',
    ]);
  });
});

describe('generated code', () => {
  it('computes derived values first in the updates of what they read', () => {
    const code = js(
      `${component('    derived double = count * 2\n    derived quad = double * 2', '<button onClick={count++} />{double} {quad}')}document.body.append(<A />)`,
    );

    expect(code).toContain('  let double = count * 2;\n  let quad = double * 2;\n');
    expect(code).toMatch(
      /function \$\$updateCount\d+\(\) \{\n {4}double = count \* 2;\n {4}quad = double \* 2;\n/,
    );
  });

  it('declares a derived value that reads no state as a constant', () => {
    expect(
      js(
        'comp A(n number) {\n    derived twice = n * 2\n    return <p>{twice}</p>\n}\nconst a = <A n={1} />',
      ),
    ).toContain('const twice = n * 2;');
  });
});

describe('running', () => {
  it('updates what reads derived values, through other derived values and properties', () => {
    const { body } = mountWithDom(`comp Label(count number) {
    derived text = \`\${count} × 3 = \${count * 3}\`
    return <i>{text}</i>
}
comp A() {
    state count = 1
    derived double = count * 2
    derived quad = double * 2
    return <p onClick={count++}>{double} {quad} <Label count={count} /></p>
}
document.body.append(<A />)
`);

    body.find('p').click();
    expect(String(body)).toBe('<body><p>4 8 <i>2 × 3 = 6</i></p></body>');
  });

  it('keeps derived values right when the body changes the state before the markup exists', () => {
    const { body } = mountWithDom(`comp A() {
    state count = 1
    derived double = count * 2
    func reset() {
        count = 10
    }
    count = 5
    const before = double
    reset()
    return <p>{before} {double}</p>
}
document.body.append(<A />)
`);

    expect(String(body)).toBe('<body><p>10 20</p></body>');
  });

  it('runs an effect after creation and when what it reads changes, cleaning up before', () => {
    const { body, output } = mountWithDom(`comp Counter() {
    state count = 0
    state other = 0
    effect {
        console.log("run", count)
        defer console.log("clean", count)
    }
    return <div>
        <button onClick={count++}>count</button>
        <button onClick={other++}>other</button>
    </div>
}
comp App() {
    state shown = true
    return <section>
        <button onClick={shown = false}>hide</button>
        {if shown {
            <Counter />
        }}
    </section>
}
document.body.append(<App />)
`);

    body.find('button', 1).click();
    body.find('button', 2).click();
    body.find('button').click();
    expect(output).toEqual(['run 0', 'clean 0', 'run 1', 'clean 1']);
  });

  it('works in decorators too', () => {
    const { body, output } = mountWithDom(`dec counted() {
    public state count = 0
    derived double = count * 2
    effect {
        console.log("count", count)
    }
    public func add() {
        count++
    }
    return (content Element) => <div>{content}<i>{double}</i></div>
}
@counted
comp A() {
    return <p onClick={@counted.add()}>a</p>
}
document.body.append(<A />)
`);

    body.find('p').click();
    expect(String(body)).toBe('<body><div><p>a</p><i>2</i></div></body>');
    expect(output).toEqual(['count 0', 'count 1']);
  });

  it('runs what the todo list of the design describes', () => {
    const { body, output } = mountWithDom(`interface Todo {
    title string
    done bool
}
comp Todos() {
    state todos []Todo = [{ title: "a", done: false }, { title: "b", done: true }]
    state filter = "all"
    derived visible = todos.filter(todo => filter == "all" || !todo.done)
    derived left = todos.filter(todo => !todo.done).length

    // The list is saved on every change.
    effect {
        console.log(JSON.stringify(todos))
    }

    return <div>
        <button onClick={filter = filter == "all" ? "active" : "all"}>filter</button>
        <button onClick={todos[0].done = true}>done</button>
        <ul>{for todo in visible { <li>{todo.title}</li> }}</ul>
        <p>{left} left</p>
    </div>
}
document.body.append(<Todos />)
`);

    const list = () => String(body.find('ul')) + String(body.find('p'));

    expect(list()).toBe('<ul><li>a</li><li>b</li></ul><p>1 left</p>');
    body.find('button').click();
    expect(list()).toBe('<ul><li>a</li></ul><p>1 left</p>');
    body.find('button', 1).click();
    expect(list()).toBe('<ul></ul><p>0 left</p>');
    expect(output).toEqual([
      '[{"title":"a","done":false},{"title":"b","done":true}]',
      '[{"title":"a","done":true},{"title":"b","done":true}]',
    ]);
  });
});
