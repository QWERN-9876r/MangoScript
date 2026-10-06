import { describe, expect, it } from 'vitest';
import type * as ast from '../src/ast.ts';
import { check } from '../src/checker/checker.ts';
import { compile } from '../src/index.ts';
import { parse } from '../src/parser/parser.ts';
import { mountWithDom } from './fake-dom.ts';

// Control flow in markup: `{if ...}`, `{for ...}` and `{switch ...}` whose blocks hold markup.

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

/** The text of the body without the empty marker nodes. */
function html(node: { toString(): string }): string {
  return String(node);
}

const item = `interface Item {
    title string
    price number
}
`;

describe('syntax', () => {
  it('parses if and for among the children, with elements as statements', () => {
    const { program, diagnostics } = parse(`const list = <div>{for i, product in products {
if product != null {
<Product {...product} />
}
}}</div>`);
    expect(diagnostics).toEqual([]);
    const declaration = program.body[0] as ast.VariableDeclaration;
    const div = declaration.values[0] as ast.ElementExpression;
    const container = div.children[0] as ast.JsxStatementContainer;
    expect(container.kind).toBe('JsxStatementContainer');
    const loop = container.statement as ast.ForInStatement;
    expect([loop.key?.name, loop.value.name]).toEqual(['i', 'product']);
    const condition = loop.body.body[0] as ast.IfStatement;
    const statement = condition.consequent.body[0] as ast.JsxElementStatement;
    expect(statement.kind).toBe('JsxElementStatement');
    expect(statement.element.tag?.name).toBe('Product');
  });

  it('allows const, else, switch and nested elements in blocks', () => {
    expect(
      errors(`const n = 2
const list = <ul>
    {if n > 1 {
        const label = "много"
        <li>{label}</li>
        <li>{n}</li>
    } else if n == 1 {
        <li>один</li>
    } else {
        <li><b>ноль</b></li>
    }}
    {switch n {
    case 1, 2:
        <li>мало</li>
    default:
        <li>{for i := 0; i < n; i++ {}}</li>
    }}
</ul>`),
    ).toEqual(['":=" is not supported: declare variables with "let" or "const"']);
  });

  it.each([
    [
      'const list = <ul>{for x in [1] {\n    console.log(x)\n}}</ul>',
      'inside markup only elements, if, for, switch and const can be written',
    ],
    [
      'let n = 0\nconst list = <ul>{for x in [1] {\n    n = x\n}}</ul>',
      'inside markup only elements, if, for, switch and const can be written',
    ],
    [
      'const list = <ul>{for x in [1] {\n    let y = x\n}}</ul>',
      'inside markup only elements, if, for, switch and const can be written',
    ],
    [
      'const list = <ul>{for x in [1] {\n    if x > 0 {\n        break\n    }\n}}</ul>',
      '"break" cannot be used inside markup: put the content in an if instead',
    ],
    [
      'const list = <ul>{for x in [1] {\n    continue\n}}</ul>',
      '"continue" cannot be used inside markup: put the content in an if instead',
    ],
  ])('rejects %j', (source, message) => {
    expect(errors(source)).toEqual([message]);
  });

  it('keeps ordinary statements in functions inside markup', () => {
    expect(
      errors(`const list = <ul>{for x in [1, 2] {
    <li onClick={console.log(x)}>{[x].map(y => {
        let z = y * 2
        z++
        return z
    })}</li>
}}</ul>`),
    ).toEqual([]);
  });
});

describe('type checking', () => {
  it('narrows types in the blocks like ordinary if', () => {
    expect(
      errors(`${item}const items []?Item = []
const list = <ul>{for item in items {
    if item != null {
        <li>{item.title}</li>
    }
}}</ul>`),
    ).toEqual([]);
  });

  it('passes the fields of a spread object as properties', () => {
    expect(
      errors(`${item}comp Product(title string, price number, sale bool = false) {
    return <li>{title} {price} {sale ? "%" : ""}</li>
}
const items []Item = []
const a = <ul>{for item in items { <Product {...item} /> }}</ul>
const b = <Product {...items[0]} price={1} />
const c = <Product title="x" {...{ price: 1, extra: true }} />`),
    ).toEqual([]);
  });

  it.each([
    [
      `${item}const items []?Item = []\nconst list = <ul>{for item in items {\n    if item {\n        <li />\n    }\n}}</ul>`,
      'condition must be bool, not ?Item: compare it with null, e.g. "x != null"',
    ],
    [
      `${item}const items []?Item = []\nconst list = <ul>{for item in items {\n    <li>{item.title}</li>\n}}</ul>`,
      '"item" may be null: check it with "if item != null" or use "?."',
    ],
    [
      `comp P(title string) {\n    return <b>{title}</b>\n}\nconst x = <P {...{ name: "a" }} />`,
      '<P> needs the property "title"',
    ],
    [
      `comp P(title string) {\n    return <b>{title}</b>\n}\nconst x = <P {...{ title: 1 }} />`,
      'cannot use number as string for "title" of <P>',
    ],
    [
      `comp P(title string) {\n    return <b>{title}</b>\n}\nconst x = <P {..."title"} />`,
      'cannot spread string into the properties of <P>',
    ],
  ])('rejects %j', (source, message) => {
    expect(errors(source)).toEqual([message]);
  });
});

describe('code generation', () => {
  it('compiles markup that does not change into plain control flow', () => {
    expect(
      js(`${item}comp Product(title string, price number) {
    return <li>{title}: {price} ₽</li>
}
const products []?Item = []
document.body.append(<ul>{for i, product in products {
    if product != null {
        <Product {...product} />
    } else {
        <li>{i}: нет</li>
    }
}}</ul>)`),
    ).toBe(`const products = [];
const $$ul1 = document.createElement("ul");
for (const [i, product] of products.entries()) {
  if (product != null) {
    // <Product>
    let $$product2;
    {
      const title = product.title;
      const price = product.price;
      $$product2 = document.createElement("li");
      $$product2.append(title, ": ", price, " ₽");
    }
    $$ul1.append($$product2);
  } else {
    const $$li3 = document.createElement("li");
    $$li3.append(i, ": нет");
    $$ul1.append($$li3);
  }
}
document.body.append($$ul1);`);
  });

  it('keeps blocks that depend on state with helpers', () => {
    const code = js(`comp Todos() {
    state todos = ["a"]
    state done = false
    return <ul>
        {for i, todo in todos {
            const label = \`\${i + 1}. \${todo}\`
            <li>{label}</li>
        }}
        {if done {
            <li>Готово</li>
        }}
        <li onClick={todos.push("b"); done = true}>+</li>
    </ul>
}
document.body.append(<Todos />)`);
    expect(code).toContain('function $$branches(choose, blocks) {');
    expect(code).toContain('function $$list(items, create) {');
    expect(code.slice(code.indexOf('// <Todos>'))).toBe(`// <Todos>
let $$todos1;
{
  let todos = ["a"];
  let done = false;
  const $$ul4 = document.createElement("ul");
  const [$$for5, $$updateFor5] = $$list(() => todos, (todo, i) => {
    const $$block6 = document.createDocumentFragment();
    let label = \`\${i + 1}. \${todo}\`;
    const $$li7 = document.createElement("li");
    const $$text8 = document.createTextNode(label);
    $$li7.append($$text8);
    $$block6.append($$li7);
    return [$$block6, ($$index) => {
      i = $$index;
      label = \`\${i + 1}. \${todo}\`;
      $$text8.data = label;
    }];
  });
  const [$$if9, $$updateIf9] = $$branches(() => done ? 0 : -1, [() => {
    const $$block10 = document.createDocumentFragment();
    const $$li11 = document.createElement("li");
    $$li11.append("Готово");
    $$block10.append($$li11);
    return [$$block10];
  }]);
  const $$li12 = document.createElement("li");
  $$li12.addEventListener("click", () => {
    todos.push("b");
    $$updateFor5();
    done = true;
    $$updateIf9();
  });
  $$li12.append("+");
  $$ul4.append($$for5, $$if9, $$li12);
  $$todos1 = $$ul4;
}
document.body.append($$todos1);`);
  });
});

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
