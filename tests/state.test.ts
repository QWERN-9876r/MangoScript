import { describe, expect, it } from 'vitest';
import type * as ast from '../src/ast.ts';
import { check } from '../src/checker/checker.ts';
import { compile } from '../src/index.ts';
import { parse } from '../src/parser/parser.ts';
import { mountWithDom } from './fake-dom.ts';

// Component state: `state count = 0`, markup that follows it, and `bind:`.

function errors(source: string): string[] {
  const { program, diagnostics } = parse(source);
  if (diagnostics.length > 0) return diagnostics.map((d) => d.message);
  return check(program).diagnostics.map((d) => d.message);
}

function js(source: string): string {
  const { code, diagnostics } = compile(source);
  expect(diagnostics).toEqual([]);
  return code.trimEnd();
}

/** The compiled code without the helpers at the top. */
function body(source: string): string {
  return js(source).replace(/^(function \$\$[\s\S]*?\n}\n\n)+/, '');
}

const counter = `comp Counter(initialValue number) {
    state count = initialValue
    return <button onClick={count++}>Нажато {count} раз</button>
}
`;

describe('syntax', () => {
  it('parses state declarations at the top level of a component', () => {
    const { program, diagnostics } = parse(`${counter}`);
    expect(diagnostics).toEqual([]);
    const component = program.body[0] as ast.ComponentDeclaration;
    const declaration = component.body.body[0] as ast.VariableDeclaration;
    expect(declaration.keyword).toBe('state');
    expect(declaration.names.map((name) => name.name)).toEqual(['count']);
  });

  it('keeps state an ordinary name elsewhere', () => {
    expect(errors(`let state = 1\nstate = 2\nstate += 1`)).toEqual([]);
    expect(
      errors(`comp A() {\n    let state = "x"\n    state = "y"\n    return <p>{state}</p>\n}`),
    ).toEqual([]);
  });

  it.each([
    ['state count = 0', 'state can only be declared inside a component'],
    [
      `comp A(ok bool) {\n    if ok {\n        state x = 1\n    }\n    return <p />\n}`,
      'state is declared at the top level of a component, not inside blocks or functions',
    ],
    [
      `comp A() {\n    func f() {\n        state x = 1\n    }\n    return <p />\n}`,
      'state is declared at the top level of a component, not inside blocks or functions',
    ],
    [`comp A() {\n    state x\n    return <p />\n}`, '"x" needs a type or a value'],
  ])('rejects %j', (source, message) => {
    expect(errors(source)).toEqual([message]);
  });
});

describe('type checking', () => {
  it('accepts state, its zero values and bindings', () => {
    expect(
      errors(`interface User {
    name string
    age number
}
comp Form(user User) {
    state count number
    state names []string
    state subscribed = false
    state choice = "a"
    return <form onSubmit={count++; names.push("x")}>
        <input bind:value={user.name} />
        <input type="number" bind:value={user.age} />
        <input type="range" bind:value={count} />
        <input type="checkbox" bind:checked={subscribed} />
        <textarea bind:value={choice} />
        <select bind:value={choice}><option>a</option></select>
        {count} {names}
    </form>
}`),
    ).toEqual([]);
  });

  it.each([
    [
      `comp A(n number) {\n    return <button onClick={n++}>{n}</button>\n}`,
      `cannot assign to "n": component properties are read-only; to change the parent's state, pass a function`,
    ],
    [
      `comp A() {\n    state n = 0\n    return <button onClick={n = "x"}>{n}</button>\n}`,
      'cannot use string as number',
    ],
    [
      `comp A() {\n    const name = ""\n    return <input bind:value={name} />\n}`,
      'cannot assign to "name": it is a constant',
    ],
    [
      `comp A(name string) {\n    return <input bind:value={name} />\n}`,
      `cannot assign to "name": component properties are read-only; to change the parent's state, pass a function`,
    ],
    [
      `comp A() {\n    state ok = false\n    return <input type="checkbox" bind:checked={ok} bind:value={ok} />\n}`,
      'bind:value needs a string or a number, not bool',
    ],
    [
      `comp A() {\n    state name = ""\n    return <input type="checkbox" bind:checked={name} />\n}`,
      'bind:checked needs a bool, not string',
    ],
    [
      `comp A() {\n    state n = 0\n    return <select bind:value={n} />\n}`,
      'bind:value needs a string, not number',
    ],
    [
      `comp A() {\n    state n = 0\n    return <input bind:value={n} />\n}`,
      'a number can be bound to <input type="number"> or <input type="range">',
    ],
    [
      `comp A() {\n    state name = ""\n    return <p bind:value={name} />\n}`,
      'bind:value works with <input>, <textarea> and <select>',
    ],
    [
      `comp A() {\n    state ok = false\n    return <select bind:checked={ok} />\n}`,
      'bind:checked works with <input>',
    ],
    [
      `comp A() {\n    state name = ""\n    return <input bind:text={name} />\n}`,
      'unknown binding "bind:text": use bind:value or bind:checked',
    ],
    [
      `comp A() {\n    state name = ""\n    return <input bind:value="name" />\n}`,
      '"bind:value" needs a variable in braces, e.g. bind:value={title}',
    ],
    [
      `comp A() {\n    state name = ""\n    return <input bind:value={name + "!"} />\n}`,
      '"bind:value" needs a variable or a field to write to',
    ],
    [
      `comp A() {\n    state name = ""\n    return <input value={name} bind:value={name} />\n}`,
      '"value" and "bind:value" set the same property: keep one of them',
    ],
  ])('rejects %j', (source, message) => {
    expect(errors(source)).toEqual([message]);
  });
});

describe('code generation', () => {
  it('compiles the counter from the concept: one change, one update, written in place', () => {
    expect(
      js(`comp Counter(initialValue number) {
    state count = initialValue
    return <button onClick={count++}>Нажато {count} раз</button>
}

document.body.append(<Counter initialValue={0} />)`),
    ).toBe(
      `// <Counter>
let $$counter1;
{
  const initialValue = 0;
  let count = initialValue;
  const $$button3 = document.createElement("button");
  $$button3.addEventListener("click", () => {
    count++;
    $$text4.data = count;
  });
  const $$text4 = document.createTextNode(count);
  $$button3.append("Нажато ", $$text4, " раз");
  $$counter1 = $$button3;
}
document.body.append($$counter1);`,
    );
  });

  it('collects several updates into a function; bind: does not update its own element', () => {
    expect(
      js(`comp Greeting() {
    state name = ""
    return <label>
        <input bind:value={name} />
        <button onClick={name = ""}>×</button>
        Привет, {name}!
    </label>
}
document.body.append(<Greeting />)`),
    ).toBe(
      `// <Greeting>
let $$greeting1;
{
  let name = "";
  const $$label3 = document.createElement("label");
  const $$input4 = document.createElement("input");
  $$input4.value = name;
  $$input4.addEventListener("input", () => {
    name = $$input4.value;
    $$updateName2();
  });
  const $$button5 = document.createElement("button");
  $$button5.addEventListener("click", () => {
    name = "";
    $$updateName2();
  });
  $$button5.append("×");
  const $$text6 = document.createTextNode(name);
  $$label3.append($$input4, $$button5, "Привет, ", $$text6, "!");

  function $$updateName2() {
    if ($$input4.value !== name) $$input4.value = name;
    $$text6.data = name;
  }

  $$greeting1 = $$label3;
}
document.body.append($$greeting1);`,
    );
  });

  it('updates after changes in functions, conditions and returned values', () => {
    expect(
      js(`comp Stack() {
    state items = [1, 2]
    state log = ""

    func take() number {
        return items.pop() ?? 0
    }

    func pop() {
        if items.pop() == null {
            log = "empty"
            return
        }
    }

    return <div>
        <button onClick={pop()}>pop</button>
        <button onClick={console.log(take())}>take</button>
        <button onClick={setTimeout(() => items.push(9), 0)}>later</button>
        {items.length}
    </div>
}

document.body.append(<Stack />)`),
    ).toBe(
      `// <Stack>
let $$stack1;
{
  let items = [1, 2];
  let log = "";

  function take() {
    const $$0 = items.pop() ?? 0;
    $$updateItems2();
    return $$0;
  }

  function pop() {
    if (items.pop() == null) {
      $$updateItems2();
      log = "empty";
      return;
    }
    $$updateItems2();
  }

  const $$div4 = document.createElement("div");
  const $$button5 = document.createElement("button");
  $$button5.addEventListener("click", () => {
    pop();
  });
  $$button5.append("pop");
  const $$button6 = document.createElement("button");
  $$button6.addEventListener("click", () => {
    console.log(take());
  });
  $$button6.append("take");
  const $$button7 = document.createElement("button");
  $$button7.addEventListener("click", () => {
    setTimeout(() => {
      const $$0 = items.push(9);
      $$updateItems2();
      return $$0;
    }, 0);
  });
  $$button7.append("later");
  const $$text8 = document.createTextNode(items.length);
  $$div4.append($$button5, $$button6, $$button7, $$text8);

  function $$updateItems2() {
    if (!$$stack1) return;
    $$text8.data = items.length;
  }

  $$stack1 = $$div4;
}
document.body.append($$stack1);`,
    );
  });

  it('passes state to child components through setter functions', () => {
    expect(
      js(`comp Card(title string, children Content) {
    return <section><h2>{title}</h2>{children}</section>
}

comp Stepper(value number, onChange func(number)) {
    return <span>
        <button onClick={onChange(value - 1)}>-</button>
        {value}
        <button onClick={onChange(value + 1)}>+</button>
    </span>
}

comp App() {
    state count = 1
    return <Card title={\`Счёт: \${count}\`}>
        <Stepper value={count} onChange={count = event} />
        <p>{count * 2}</p>
    </Card>
}

let name = "Ann"
document.body.append(<App />, <input bind:value={name} />)`),
    ).toBe(
      `let name = "Ann";
// <App>
let $$app1;
{
  let count = 1;
  // <Card>
  const $$0 = \`Счёт: \${count}\`;
  const $$children3 = document.createDocumentFragment();
  // <Stepper>
  const $$1 = (event) => {
    count = event;
    $$updateCount2();
  };
  let $$stepper4;
  let $$setValue5;
  {
    let value = count;
    const onChange = $$1;
    const $$span7 = document.createElement("span");
    const $$button8 = document.createElement("button");
    $$button8.addEventListener("click", () => {
      onChange(value - 1);
    });
    $$button8.append("-");
    const $$text9 = document.createTextNode(value);
    const $$button10 = document.createElement("button");
    $$button10.addEventListener("click", () => {
      onChange(value + 1);
    });
    $$button10.append("+");
    $$span7.append($$button8, $$text9, $$button10);

    $$setValue5 = ($$value) => {
      value = $$value;
      $$text9.data = value;
    };

    $$stepper4 = $$span7;
  }
  const $$p11 = document.createElement("p");
  const $$text12 = document.createTextNode(count * 2);
  $$p11.append($$text12);
  $$children3.append($$stepper4, $$p11);
  let $$card13;
  let $$setTitle14;
  {
    let title = $$0;
    const children = $$children3;
    const $$section16 = document.createElement("section");
    const $$h217 = document.createElement("h2");
    const $$text18 = document.createTextNode(title);
    $$h217.append($$text18);
    $$section16.append($$h217, children);

    $$setTitle14 = ($$title) => {
      title = $$title;
      $$text18.data = title;
    };

    $$card13 = $$section16;
  }

  function $$updateCount2() {
    if (!$$app1) return;
    $$setValue5(count);
    $$text12.data = count * 2;
    $$setTitle14(\`Счёт: \${count}\`);
  }

  $$app1 = $$card13;
}
const $$input19 = document.createElement("input");
$$input19.value = name;
$$input19.addEventListener("input", () => {
  name = $$input19.value;
});
document.body.append($$app1, $$input19);`,
    );
  });

  it('replaces changing nodes with the $$content helper, which evaluates them again', () => {
    const code = js(`comp Tags() {
    state tags = ["mango"]
    return <ul onClick={tags.push("x")}>{tags.map(tag => <li>{tag}</li>)}</ul>
}
document.body.append(<Tags />)`);
    expect(code).toContain('function $$content(value) {');
    expect(code.slice(code.indexOf('// <Tags>'))).toBe(`// <Tags>
let $$tags1;
{
  let tags = ["mango"];
  const $$ul3 = document.createElement("ul");
  $$ul3.addEventListener("click", () => {
    tags.push("x");
    $$updateContent4();
  });
  const [$$content4, $$updateContent4] = $$content(() => tags.map((tag) => {
    const $$li5 = document.createElement("li");
    $$li5.append(tag);
    return $$li5;
  }));
  $$ul3.append($$content4);
  $$tags1 = $$ul3;
}
document.body.append($$tags1);`);
  });

  it('leaves components without state as they were', () => {
    expect(
      body(`comp Label(text string) {
    return <b>{text}</b>
}
document.body.append(<Label text="hi" />)`),
    ).toBe(`// <Label>
let $$label1;
{
  const text = "hi";
  $$label1 = document.createElement("b");
  $$label1.append(text);
}
document.body.append($$label1);`);
  });
});

describe('runtime behavior', () => {
  it('updates text when state changes', () => {
    const { body } = mountWithDom(`${counter}document.body.append(<Counter initialValue={5} />)`);
    const button = body.find('button');
    expect(String(body)).toBe('<body><button>Нажато 5 раз</button></body>');
    button.click();
    button.click();
    expect(String(body)).toBe('<body><button>Нажато 7 раз</button></body>');
  });

  it('keeps instances of a component independent', () => {
    const { body } = mountWithDom(
      `${counter}document.body.append(<Counter initialValue={0} />, <Counter initialValue={10} />)`,
    );
    body.find('button', 1).click();
    expect(String(body)).toBe(
      '<body><button>Нажато 0 раз</button><button>Нажато 11 раз</button></body>',
    );
  });

  it('updates attributes and every place that reads the state', () => {
    const { body } = mountWithDom(`comp Toggle() {
    state on = false
    return <p class={on ? "on" : "off"} data-mode={on ? "вкл" : "выкл"}>
        <button disabled={on} onClick={on = true}>Включить</button>
        <button onClick={on = false}>Выключить</button>
        {on ? "Включено" : "Выключено"}
    </p>
}
document.body.append(<Toggle />)`);
    expect(String(body)).toBe(
      '<body><p className=off data-mode=выкл><button disabled=false>Включить</button><button>Выключить</button>Выключено</p></body>',
    );
    body.find('button').click();
    expect(String(body)).toBe(
      '<body><p className=on data-mode=вкл><button disabled=true>Включить</button><button>Выключить</button>Включено</p></body>',
    );
    body.find('button', 1).click();
    expect(String(body)).toContain('className=off');
  });

  it('replaces nodes that depend on state', () => {
    const { body } = mountWithDom(`comp List() {
    state items = ["a"]
    state shown = true
    return <div>
        <button onClick={items.push("b")}>+</button>
        <button onClick={items.pop()}>-</button>
        <button onClick={shown = !shown}>?</button>
        <ul>{items.map(item => <li>{item}</li>)}</ul>
        {shown ? <b>{items.length}</b> : null}
    </div>
}
document.body.append(<List />)`);
    const [push, pop, toggle] = body.findAll('button');
    const list = () => String(body.find('div')).replace(/<button>.<\/button>/g, '');
    expect(list()).toBe('<div><ul><li>a</li></ul><b>1</b></div>');
    push!.click();
    push!.click();
    expect(list()).toBe('<div><ul><li>a</li><li>b</li><li>b</li></ul><b>3</b></div>');
    pop!.click();
    toggle!.click();
    expect(list()).toBe('<div><ul><li>a</li><li>b</li></ul></div>');
    toggle!.click();
    expect(list()).toBe('<div><ul><li>a</li><li>b</li></ul><b>2</b></div>');
  });

  it('notices changes through fields, loop variables and callback parameters', () => {
    const { body } = mountWithDom(`interface Todo {
    title string
    done bool
}
comp Todos() {
    state todos []Todo = [{ title: "a", done: false }, { title: "b", done: false }]
    state user = { name: "Ann" }
    func completeAll() {
        for todo in todos {
            todo.done = true
        }
    }
    return <div>
        <button onClick={user.name = "Bob"}>{user.name}</button>
        <button onClick={completeAll()}>все</button>
        <ul>{todos.map(todo => <li onClick={todo.done = !todo.done}>{todo.title}{todo.done ? "+" : ""}</li>)}</ul>
    </div>
}
document.body.append(<Todos />)`);
    body.find('li', 1).click();
    expect(String(body.find('ul'))).toBe('<ul><li>a</li><li>b+</li></ul>');
    body.find('button', 1).click();
    expect(String(body.find('ul'))).toBe('<ul><li>a+</li><li>b+</li></ul>');
    body.find('button').click();
    expect(String(body.find('button'))).toBe('<button>Bob</button>');
  });

  it('treats method calls on objects as changes', () => {
    const { body } = mountWithDom(`class Counter {
    value = 0
    increment() {
        this.value++
    }
}
comp View() {
    state counter = new Counter()
    return <button onClick={counter.increment()}>{counter.value}</button>
}
document.body.append(<View />)`);
    body.find('button').click();
    expect(String(body)).toBe('<body><button>1</button></body>');
  });

  it('does not update from code that runs while the markup is drawn', () => {
    const { body } = mountWithDom(`class Counter {
    value = 0
    increment() {
        this.value++
    }
    describe() string {
        return \`Нажато \${this.value}\`
    }
}
comp View() {
    state counter = new Counter()
    func label() string {
        return counter.describe()
    }
    return <div>
        <button onClick={counter.increment()}>{label()}</button>
        {[1, 2].map(n => { counter.describe(); return <i>{n}</i> })}
    </div>
}
document.body.append(<View />)`);
    body.find('button').click();
    body.find('button').click();
    expect(String(body)).toBe('<body><div><button>Нажато 2</button><i>1</i><i>2</i></div></body>');
  });

  it('updates after changes in functions of the body, even ones called during setup', () => {
    const { body } = mountWithDom(`comp Clock() {
    state ticks = 0
    func tick() {
        ticks++
    }
    tick()
    tick()
    return <button onClick={tick()}>{ticks}</button>
}
document.body.append(<Clock />)`);
    expect(String(body)).toBe('<body><button>2</button></body>');
    body.find('button').click();
    expect(String(body)).toBe('<body><button>3</button></body>');
  });

  it('updates when a condition or a returned value changes state', () => {
    const { body, output } = mountWithDom(`comp Stack() {
    state items = [1, 2]
    func take() number {
        return items.pop() ?? 0
    }
    func pop() {
        if items.pop() == null {
            console.log("empty")
            return
        }
    }
    return <div>
        <button onClick={pop()}>pop</button>
        <button onClick={console.log(take())}>take</button>
        <button onClick={setTimeout(() => items.push(9), 0)}>later</button>
        {items.length}
    </div>
}
document.body.append(<Stack />)`);
    const text = () => String(body.find('div')).replace(/<button>\w+<\/button>/g, '');
    body.find('button').click();
    expect(text()).toBe('<div>1</div>');
    body.find('button', 1).click();
    expect(text()).toBe('<div>0</div>');
    body.find('button').click();
    expect(output).toEqual(['1', 'empty']);
  });

  it('passes state to child components', () => {
    const { body } = mountWithDom(`comp Badge(count number, label string = "шт.") {
    return <b class={count > 0 ? "full" : "empty"}>{count} {label}</b>
}
comp Cart() {
    state items = 0
    return <p>
        <button onClick={items++}>+</button>
        <Badge count={items} />
        <Badge count={items * 10} label="г" />
    </p>
}
document.body.append(<Cart />)`);
    expect(String(body.find('p'))).toBe(
      '<p><button>+</button><b className=empty>0 шт.</b><b className=empty>0 г</b></p>',
    );
    body.find('button').click();
    expect(String(body.find('p'))).toBe(
      '<p><button>+</button><b className=full>1 шт.</b><b className=full>10 г</b></p>',
    );
  });

  it('binds inputs to state in both directions', () => {
    const { body } = mountWithDom(`comp Signup() {
    state name = ""
    state age = 18
    state subscribed = false
    return <form>
        <input bind:value={name} />
        <input type="number" bind:value={age} />
        <input type="checkbox" bind:checked={subscribed} />
        <button onClick={name = ""; age = 18; subscribed = false}>Сбросить</button>
        <p>{name == "" ? "незнакомец" : name}, {age}{subscribed ? ", подписан" : ""}</p>
    </form>
}
document.body.append(<Signup />)`);
    const [name, age, subscribed] = body.findAll('input');
    const text = () => String(body.find('p'));
    expect(name!.value).toBe('');
    expect(age!.valueAsNumber).toBe(18);
    expect(text()).toBe('<p>незнакомец, 18</p>');

    name!.value = 'Ann';
    name!.dispatch('input');
    age!.valueAsNumber = 30;
    age!.dispatch('input');
    subscribed!.checked = true;
    subscribed!.dispatch('change');
    expect(text()).toBe('<p>Ann, 30, подписан</p>');

    body.find('button').click();
    expect(text()).toBe('<p>незнакомец, 18</p>');
    expect([name!.value, age!.valueAsNumber, subscribed!.checked]).toEqual(['', 18, false]);
  });

  it('binds fields of items in a list', () => {
    const { body } = mountWithDom(`interface Todo {
    title string
    done bool
}
comp Todos() {
    state todos []Todo = [{ title: "a", done: false }]
    return <div>
        {todos.map(todo => <input type="checkbox" bind:checked={todo.done} />)}
        {todos.filter(todo => todo.done).length}
    </div>
}
document.body.append(<Todos />)`);
    const checkbox = body.find('input');
    checkbox.checked = true;
    checkbox.dispatch('change');
    expect(String(body.find('div'))).toBe('<div><input type=checkbox checked=true></input>1</div>');
  });

  it('updates markup declared at the top level of the body', () => {
    const { body } = mountWithDom(`comp Search() {
    state query = ""
    const input = <input bind:value={query} placeholder={query == "" ? "Найти" : ""} />
    return <div>{input}<button onClick={query = "mango"}>Пример</button></div>
}
document.body.append(<Search />)`);
    body.find('button').click();
    const input = body.find('input');
    expect(input.value).toBe('mango');
    expect(input.placeholder).toBe('');
  });
});
