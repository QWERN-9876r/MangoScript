import { describe, expect, it } from 'vitest';
import type * as ast from '../src/ast.ts';
import { check } from '../src/checker/checker.ts';
import { compile } from '../src/index.ts';
import { parse } from '../src/parser/parser.ts';
import { mountWithDom, runWithDom } from './fake-dom.ts';

// Components: `comp Card(...) { return <section>...</section> }`, inlined where they are used.

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

const card = `comp Card(title string, kind string = "info", children Content) {
    const icon = kind == "warning" ? "!" : "i"
    return <section class={kind}>
        <h2>{icon} {title}</h2>
        {children}
    </section>
}
`;

describe('parser', () => {
  it('parses components with default values', () => {
    const { program, diagnostics } = parse(card);
    expect(diagnostics).toEqual([]);
    const node = program.body[0] as ast.ComponentDeclaration;
    expect(node.kind).toBe('ComponentDeclaration');
    expect(node.params.map((p) => [p.name.name, p.defaultValue?.kind ?? null])).toEqual([
      ['title', null],
      ['kind', 'StringLiteral'],
      ['children', null],
    ]);
  });

  it.each([
    [
      'comp card() {\n    return <p />\n}',
      'component names start with a capital letter, as in <Card />',
    ],
    [
      'func f() {\n    comp A() {\n        return <p />\n    }\n}',
      'components can only be declared at the top level of a module',
    ],
    ['func f(a number = 1) {}', 'expected ")", found "="'],
  ])('reports %j', (source, message) => {
    expect(errors(source)).toEqual([message]);
  });
});

describe('types', () => {
  it.each([
    [
      'properties, defaults and children',
      `${card}const c HTMLElement = <Card title="Hi"><p>text</p></Card>`,
    ],
    [
      'components used before their declaration',
      `const b = <Badge count={1} />\ncomp Badge(count number) {\n    return <span>{count}</span>\n}`,
    ],
    [
      'components inside components',
      `${card}comp Page() {\n    return <main><Card title="A" kind="warning" /></main>\n}\nconst p = <Page />`,
    ],
    [
      'nullable properties are optional',
      `comp Hint(text ?string) {\n    return <p>{text}</p>\n}\nconst h = <Hint />`,
    ],
    [
      'callback properties',
      `comp Button(label string, onPress func(number)) {\n    return <button onClick={onPress(1)}>{label}</button>\n}\nlet n = 0\nconst b = <Button label="+" onPress={n += event} />`,
    ],
    [
      'the result type',
      `comp Item(text string) {\n    return <li>{text}</li>\n}\nconst li HTMLLIElement = <Item text="a" />`,
    ],
  ])('accepts %s', (_, source) => {
    expect(errors(source)).toEqual([]);
  });

  it.each([
    [`${card}const c = <Card />`, '<Card> needs the property "title"'],
    [`${card}const c = <Card title="a" size={1} />`, '<Card> has no property "size"'],
    [`${card}const c = <Card title={1} />`, 'cannot use number as string for "title" of <Card>'],
    [`comp A() {\n    return <p />\n}\nconst a = <A>text</A>`, '<A> takes no children'],
    [
      `comp A(children string) {\n    return <p>{children}</p>\n}`,
      'the "children" property has the type Content',
    ],
    [`comp A() {\n    return <p />\n}\nconst a = A`, 'components are used as tags: <A />'],
    ['const a = <Missing />', 'unknown component <Missing>'],
    ['const Box = 1\nconst b = <Box />', '"Box" is not a component'],
    [
      `comp A() {\n    return <A />\n}`,
      'endless recursion: A → A always creates itself again; put the use inside if or for',
    ],
    [
      `comp A() {\n    return <B />\n}\ncomp B() {\n    return <p><A /></p>\n}`,
      'endless recursion: A → B → A always creates itself again; put the use inside if or for',
    ],
    [
      `const greeting = "hi"\ncomp A() {\n    return <p>{greeting}</p>\n}\nfunc f() {\n    const greeting = 1\n    const a = <A />\n}`,
      '<A> uses "greeting" of the module, but here "greeting" is another declaration: rename one of them',
    ],
    [`comp A() {\n    const x = 1\n}`, 'a component ends with "return <markup>"'],
    [
      `comp A(ok bool) {\n    if ok {\n        return 1\n    }\n    return <i />\n}`,
      'a component returns markup, not number',
    ],
    [
      `comp A(ok bool) {\n    if ok {\n        return\n    }\n    return <i />\n}`,
      'a component returns its markup: "return <markup>"',
    ],
    [`comp A() {\n    return 1\n}`, 'a component returns markup, not number'],
    [`export comp A() {\n    return <p />\n}`, 'exporting components is not supported yet'],
    [
      `comp A(onCount number) {\n    return <p>{onCount}</p>\n}\nlet x = 0\nconst a = <A onCount={x++} />`,
      '"onCount" of <A> is not a function, so it needs a value',
    ],
  ])('rejects %j', (source, message) => {
    expect(errors(source)).toEqual([message]);
  });
});

describe('code generation', () => {
  it('inlines a component and leaves no trace of the declaration', () => {
    expect(
      js(`${card}const name = "Ann"\ndocument.body.append(<Card title={name}><p>text</p></Card>)`),
    ).toBe(
      `const name = "Ann";
// <Card>
const $$children1 = document.createDocumentFragment();
const $$p2 = document.createElement("p");
$$p2.append("text");
$$children1.append($$p2);
let $$card3;
{
  const title = name;
  const kind = "info";
  const children = $$children1;
  const icon = kind === "warning" ? "!" : "i";
  $$card3 = document.createElement("section");
  $$card3.className = kind;
  const $$h24 = document.createElement("h2");
  $$h24.append(icon, " ", title);
  $$card3.append($$h24, children);
}
document.body.append($$card3);`,
    );
  });

  it('computes a value first when the component declares the same name', () => {
    expect(
      js(
        `comp Badge(count number) {\n    return <b>{count}</b>\n}\nconst count = 2\nconst b = <Badge count={count} />`,
      ),
    ).toBe(
      `const count = 2;
// <Badge>
const $$0 = count;
let $$badge1;
{
  const count = $$0;
  $$badge1 = document.createElement("b");
  $$badge1.append(count);
}
const b = $$badge1;`,
    );
  });

  it('inlines a component in a branch only when the branch runs', () => {
    expect(
      js(
        `comp Dot() {\n    return <i>•</i>\n}\nfunc f(ok bool) any {\n    return ok ? <Dot /> : null\n}`,
      ),
    ).toBe(
      `function f(ok) {
  return ok ? (() => {
    // <Dot>
    let $$dot1;
    {
      $$dot1 = document.createElement("i");
      $$dot1.append("•");
    }
    return $$dot1;
  })() : null;
}`,
    );
  });
});

describe('runtime behavior', () => {
  it('renders components with children and nested components', () => {
    expect(
      runWithDom(`${card}comp Badge(count number) {
    return <b class="badge">{count}</b>
}
const page = <main>
    <Card title="Почта"><p>Новых: <Badge count={3} /></p></Card>
    <Card title="Ошибка" kind="warning" />
</main>
console.log(page)`),
    ).toEqual([
      '<main><section className=info><h2>i Почта</h2><p>Новых: <b className=badge>3</b></p></section><section className=warning><h2>! Ошибка</h2></section></main>',
    ]);
  });

  it('runs code given to callback properties', () => {
    expect(
      runWithDom(`comp Button(label string, onPress func()) {
    return <button onClick={onPress()}>{label}</button>
}
let clicks = 0
const button = <Button label="+1" onPress={clicks++} />
button.click()
button.click()
console.log(clicks)`),
    ).toEqual(['2']);
  });
});

describe('recursive components', () => {
  const tree = `interface Item {
    name string
    children []Item
}

comp Tree(item Item, depth number = 0) {
    state open = depth == 0
    return <li>
        <button onClick={open = !open}>{open ? "−" : "+"}</button>
        {item.name}
        {if open && item.children.length > 0 {
            <ul>{for child in item.children { <Tree item={child} depth={depth + 1} /> }}</ul>
        }}
    </li>
}
`;

  it('accepts recursion under a condition, directly or through other components', () => {
    expect(errors(tree)).toEqual([]);
    expect(
      errors(`comp A(n number) {
    return <p>{n > 0 ? <B n={n - 1} /> : null}</p>
}
comp B(n number) {
    return <A n={n} />
}`),
    ).toEqual([]);
  });

  it('does not check names hidden where a recursive component is used: it is not inlined', () => {
    expect(
      errors(`const label = "узел"
comp Node(n number) {
    return <p>{label}{if n > 0 { <Node n={n - 1} /> }}</p>
}
func f() {
    const label = 1
    const node = <Node n={2} />
}`),
    ).toEqual([]);
  });

  it.each([
    [
      `comp A() {\n    return <div><A /></div>\n}`,
      'endless recursion: A → A always creates itself again; put the use inside if or for',
    ],
    [
      `comp A() {\n    const b = <B />\n    return <p>{b}</p>\n}\ncomp B() {\n    return <A />\n}`,
      'endless recursion: A → B → A always creates itself again; put the use inside if or for',
    ],
  ])('rejects %j', (source, message) => {
    expect(errors(source)).toEqual([message]);
  });

  it('compiles a recursive component to a function that returns the node and a setter', () => {
    const code = js(`comp Countdown(n number) {
    return <span>{n}{if n > 0 { <Countdown n={n - 1} /> }}</span>
}
document.body.append(<Countdown n={2} />)`);
    expect(code).toContain('function $$Countdown(n) {');
    expect(code).toContain(`  return [$$countdown2, ($$n) => {
    n = $$n;`);
    expect(code).toContain('const [$$countdown7, $$setCountdown7] = $$Countdown($$0);');
    expect(code.split('\n').at(-2)).toBe('const [$$countdown8] = $$Countdown(2);');
    expect(code).not.toContain('// <Countdown>');
  });

  it('renders a tree whose nodes keep their own state', () => {
    const { body } = mountWithDom(`${tree}
comp Files() {
    state root Item = {
        name: "src",
        children: [
            { name: "lexer", children: [{ name: "lexer.ts", children: [] }] },
            { name: "index.ts", children: [] },
        ],
    }
    return <div>
        <button onClick={root.children.push({ name: "new.ts", children: [] })}>add</button>
        <ul><Tree item={root} /></ul>
    </div>
}
document.body.append(<Files />)`);
    const text = () =>
      String(body.find('ul'))
        .replace(/<button>([^<]*)<\/button>/g, '$1')
        .replace(/<\/?(ul|li)>/g, (tag) => (tag.startsWith('</') ? ')' : '('));
    expect(text()).toBe('((−src((+lexer)(+index.ts))))');
    body.find('button', 2).click(); // opens "lexer"
    expect(text()).toBe('((−src((−lexer((+lexer.ts)))(+index.ts))))');
    body.find('button').click(); // adds a file to the root through the parent's state
    expect(text()).toBe('((−src((−lexer((+lexer.ts)))(+index.ts)(+new.ts))))');
  });
});

describe('early returns', () => {
  it('accepts them and gives the use the common type of the returned elements', () => {
    expect(
      errors(`comp A(ok bool) {
    if ok {
        return <b>да</b>
    }
    return <i>нет</i>
}
const element HTMLElement = <A ok />
const text = element.textContent`),
    ).toEqual([]);
  });

  it('makes recursion after an early return conditional', () => {
    expect(
      errors(`comp Fruit(name string, index number = 0) {
    if index > 2 {
        return <div>end</div>
    }
    state count = 0
    return <li>{name} {count}<button onClick={count++}>+</button><Fruit name={name} index={index + 1} /></li>
}`),
    ).toEqual([]);
  });

  it('chooses the markup once, when the component is created', () => {
    const { body } = mountWithDom(`comp Badge(count number, label string) {
    state open = true
    if count == 0 {
        return <i onClick={open = !open}>{label}: {open ? "пусто" : "закрыто"}</i>
    }
    return <b>{label}: {count}</b>
}
comp Cart(start number) {
    state items = start
    return <p>
        <button onClick={items++}>+</button>
        <Badge count={items} label="товары" />
    </p>
}
document.body.append(<Cart start={0} />, <Cart start={5} />)`);
    const [empty, full] = body.findAll('p');
    expect(String(empty)).toBe('<p><button>+</button><i>товары: пусто</i></p>');
    expect(String(full)).toBe('<p><button>+</button><b>товары: 5</b></p>');
    empty!.find('i').click();
    empty!.find('button').click();
    full!.find('button').click();
    // The empty badge stays an <i> but keeps working; the full one follows the count.
    expect(String(empty)).toBe('<p><button>+</button><i>товары: закрыто</i></p>');
    expect(String(full)).toBe('<p><button>+</button><b>товары: 6</b></p>');
  });

  it('ends recursion with an early return in a function component', () => {
    const { body } = mountWithDom(`comp Fruit(name string, index number = 0) {
    if index > 1 {
        return <span>.</span>
    }
    state count = 0
    return <li>{name}{index}: {count}<button onClick={count++}>+</button><ul><Fruit name={name} index={index + 1} /></ul></li>
}
document.body.append(<ul><Fruit name="манго" /></ul>)`);
    expect(String(body)).toBe(
      '<body><ul><li>манго0: 0<button>+</button><ul><li>манго1: 0<button>+</button><ul><span>.</span></ul></li></ul></li></ul></body>',
    );
    body.find('button', 1).click();
    body.find('button', 1).click();
    body.find('button').click();
    expect(String(body)).toBe(
      '<body><ul><li>манго0: 1<button>+</button><ul><li>манго1: 2<button>+</button><ul><span>.</span></ul></li></ul></li></ul></body>',
    );
  });
});
