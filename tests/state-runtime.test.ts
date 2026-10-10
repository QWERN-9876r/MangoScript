import { describe, expect, it } from 'vitest';
import { mountWithDom } from './fake-dom.ts';

// Component state at runtime: markup follows changes of state.

const counter = `comp Counter(initialValue number) {
    state count = initialValue
    return <button onClick={count++}>Нажато {count} раз</button>
}
`;

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
