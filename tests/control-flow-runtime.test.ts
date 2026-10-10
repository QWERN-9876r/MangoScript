import { describe, expect, it } from 'vitest';
import { mountWithDom } from './fake-dom.ts';

// Control flow in markup at runtime: `{if ...}`, `{for ...}` and `{switch ...}` show the blocks that
// their conditions pick and update them when the state changes.

/** The text of the body without the empty marker nodes. */
function html(node: { toString(): string }): string {
  return String(node);
}

const item = `interface Item {
    title string
    price number
}
`;

describe('runtime behavior', () => {
  const shop = `${item}comp Product(title string, price number) {
    return <li>{title}: {price}</li>
}
comp Shop() {
    state products []Item = [{ title: "Манго", price: 120 }]
    state cheap = false
    return <div>
        <button onClick={products.push({ title: "Папайя", price: 90 })}>+</button>
        <button onClick={cheap = !cheap}>Дешёвые</button>
        <button onClick={products.splice(0, 1)}>-</button>
        <button onClick={products[0].price = 50}>Скидка</button>
        {if products.length == 0 {
            <p>Пусто</p>
        } else {
            <ul>{for product in products {
                if !cheap || product.price < 100 {
                    <Product {...product} />
                }
            }}</ul>
        }}
    </div>
}
document.body.append(<Shop />)`;

  it('shows the blocks that the conditions pick and updates them', () => {
    const { body } = mountWithDom(shop);
    const [push, cheap, remove, sale] = body.findAll('button');
    const content = () => html(body.find('div')).replace(/<button>[^<]*<\/button>/g, '');

    expect(content()).toBe('<div><ul><li>Манго: 120</li></ul></div>');
    push!.click();
    expect(content()).toBe('<div><ul><li>Манго: 120</li><li>Папайя: 90</li></ul></div>');
    cheap!.click();
    expect(content()).toBe('<div><ul><li>Папайя: 90</li></ul></div>');
    sale!.click();
    expect(content()).toBe('<div><ul><li>Манго: 50</li><li>Папайя: 90</li></ul></div>');
    remove!.click();
    remove!.click();
    expect(content()).toBe('<div><p>Пусто</p></div>');
    push!.click();
    expect(content()).toBe('<div><ul><li>Папайя: 90</li></ul></div>');
  });

  it('keeps the nodes and the state of items that stay in a list', () => {
    const { body } = mountWithDom(`comp Counter(name string) {
    state clicks = 0
    return <li onClick={clicks++}>{name}: {clicks}</li>
}
comp List() {
    state names = ["a", "b", "c"]
    return <div>
        <button onClick={names.reverse()}>reverse</button>
        <button onClick={names.splice(1, 1)}>remove</button>
        <button onClick={names.unshift("z")}>add</button>
        <ul>{for i, name in names {
            <Counter name={\`\${i}\${name}\`} />
        }}</ul>
    </div>
}
document.body.append(<List />)`);
    const [reverse, remove, add] = body.findAll('button');
    const list = () => html(body.find('ul'));
    const first = body.find('li');

    first.click();
    first.click();
    expect(list()).toBe('<ul><li>0a: 2</li><li>1b: 0</li><li>2c: 0</li></ul>');
    reverse!.click();
    expect(list()).toBe('<ul><li>0c: 0</li><li>1b: 0</li><li>2a: 2</li></ul>');
    expect(body.find('li', 2)).toBe(first);
    remove!.click();
    add!.click();
    expect(list()).toBe('<ul><li>0z: 0</li><li>1c: 0</li><li>2a: 2</li></ul>');
    expect(body.find('li', 2)).toBe(first);
  });

  it('chooses switch cases and runs classic for loops again', () => {
    const { body } = mountWithDom(`comp Rating() {
    state stars = 2
    return <p onClick={stars++}>
        {for let i = 0; i < stars; i++ {
            <b>*</b>
        }}
        {switch stars {
        case 1, 2:
            <i>мало</i>
        case 3:
            <i>хорошо</i>
        }}
    </p>
}
document.body.append(<Rating />)`);
    const p = body.find('p');

    expect(html(p)).toBe('<p><b>*</b><b>*</b><i>мало</i></p>');
    p.click();
    expect(html(p)).toBe('<p><b>*</b><b>*</b><b>*</b><i>хорошо</i></p>');
    p.click();
    expect(html(p)).toBe('<p><b>*</b><b>*</b><b>*</b><b>*</b></p>');
  });

  it('updates fields of items through bindings and handlers in blocks', () => {
    const { body } = mountWithDom(`interface Todo {
    title string
    done bool
}
comp Todos() {
    state todos []Todo = [{ title: "a", done: false }, { title: "b", done: true }]
    return <div>
        <ul>{for todo in todos {
            <li class={todo.done ? "done" : ""}>
                <input type="checkbox" bind:checked={todo.done} />
                {todo.title}
                <button onClick={todo.title += "!"}>!</button>
            </li>
        }}</ul>
        <p>{todos.filter(todo => !todo.done).length}</p>
    </div>
}
document.body.append(<Todos />)`);
    const checkbox = body.find('input');

    checkbox.checked = true;
    checkbox.dispatch('change');
    body.find('button', 1).click();
    expect(html(body.find('div'))).toBe(
      '<div><ul><li className=done><input type=checkbox checked=true></input>a<button>!</button></li><li className=done><input type=checkbox checked=true></input>b!<button>!</button></li></ul><p>0</p></div>',
    );
  });
});
