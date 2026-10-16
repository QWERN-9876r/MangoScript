import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check } from '../src/checker/checker.ts';
import { compile } from '../src/index.ts';
import { parse } from '../src/parser/parser.ts';
import { mountWithDom } from './fake-dom.ts';
import { expr, first, sx, ty } from './parser-helpers.ts';
import { markupProject } from './project.ts';

// Components as values: `content: Intro` has the type `comp()`, and a tag takes the component from
// a value, `<section.content />`, or `<Page />` when `Page` is a variable. The tag passes the
// properties in the order of the type, so a component used as a value is a function.

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

const card = `comp Card(title string, kind string = "primary", children Content) {
    return <div class={kind}><h2>{title}</h2>{children}</div>
}
`;

describe('parser', () => {
  it('reads component types with the names of their properties', () => {
    expect(
      ty(first('type Header comp(title string, kind ?Kind)', 'TypeAliasDeclaration').type),
    ).toBe('comp(title string, kind ?Kind)');
    expect(ty(first('type Page comp()', 'TypeAliasDeclaration').type)).toBe('comp()');
  });

  it('reads a tag with a dot as the value it takes the component from', () => {
    expect(sx(expr('<section.content title="a" />'))).toBe('<(. section content)>');
    expect(sx(expr('<a.b.c />'))).toBe('<(. (. a b) c)>');
    expect(sx(expr('<Page />'))).toBe('<Page>');
  });

  it('rejects a tag with a dot that is not a value', () => {
    expect(errors('const x = <a.b-c />')).toEqual([
      '"a.b-c" is not a value: a tag with a dot is written like <section.content />',
    ]);
  });
});

describe('types', () => {
  it('gives a component used as a value its type, which a tag uses', () => {
    expect(
      errors(`${card}
interface Section {
    content comp(title string, kind ?string, children Content)
}
const sections []Section = [{ content: Card }]
func f(section Section) Node {
    return <section.content title="a"><p /></section.content>
}`),
    ).toEqual([]);
  });

  it.each([
    // The names and the order must be those of the component.
    ['comp(heading string)'],
    ['comp(kind ?string, title string)'],
    // A property it does not have, and one that must be given.
    ['comp(title string, size number)'],
    ['comp()'],
    // A property that must be given cannot become one that may be left out.
    ['comp(title ?string)'],
  ])('rejects %s for Card', (type) => {
    expect(errors(`${card}const c ${type} = Card`)).toEqual([
      `cannot use comp(title string, kind ?string, children Content) as ${type}`,
    ]);
  });

  it('lets a property with a default value take a nullable one, and more that may be left out', () => {
    expect(errors(`${card}const c comp(title string, kind ?string) = Card`)).toEqual([]);
    expect(errors(`${card}const c comp(title string) = Card`)).toEqual([]);
  });

  it.each([
    ['<page.content />', '<page.content> needs the property "title"'],
    ['<page.content title="a" size={1} />', '<page.content> has no property "size"'],
    ['<page.content title={1} />', 'cannot use number as string for "title" of <page.content>'],
    [
      '<page.other />',
      '<page.other> may be null: put it into a variable and show it with {if}, e.g. const Other = page.other, then {if Other != null { <Other /> }}',
    ],
    [
      '<page.name />',
      '<page.name> is string, not a component: give it a type like comp(title string)',
    ],
    [
      '<page.content title="a" ref={element} />',
      'ref cannot point to <page.content>: its component is a value, so its element is not known in advance',
    ],
    [
      '<page.content {...page} />',
      '<page.content> takes its component from a value, so its properties are passed one by one, not spread',
    ],
    ['<page.empty>text</page.empty>', '<page.empty> takes no children'],
    [
      '<page.loose title="a" />',
      '<page.loose> is any, so the order of its properties is not known: give it a type like comp(title string)',
    ],
  ])('rejects %s', (tag, message) => {
    const source = `interface Holder {
    name string
    content comp(title string)
    other ?comp()
    empty comp()
    loose any
}
func f(page Holder, element any) {
    const x = ${tag}
}`;

    expect(errors(source)).toEqual([message]);
  });

  it('shows a nullable component with {if}', () => {
    expect(
      errors(`interface Holder {
    other ?comp()
}
func f(page Holder) Node {
    const Other = page.other
    return <div>{if Other != null { <Other /> }}</div>
}`),
    ).toEqual([]);
  });

  it('takes the component of a capitalized tag from a variable', () => {
    expect(
      errors(`${card}
func f() Node {
    const Page comp(title string) = Card
    return <Page title="a" />
}`),
    ).toEqual([]);
  });
});

describe('generated code', () => {
  it('makes a component used as a value a function and calls it by the type', () => {
    const code = js(`${card}
interface Section {
    content comp(title string, kind ?string, children Content)
}
const SECTIONS []Section = [{ content: Card }]
for section in SECTIONS {
    document.body.append(<section.content title="a"><b /></section.content>)
}`);

    expect(code).toContain(
      'function $$Card(title, kind = "primary", children = document.createDocumentFragment()) {',
    );
    expect(code).toContain('const SECTIONS = [{ content: $$Card }];');
    // `kind` is left out, so the default value applies.
    expect(code).toContain(
      'const [$$sectionContent7] = section.content("a", undefined, $$children8);',
    );
  });

  it('passes null for a nullable property as undefined, so that a default value applies', () => {
    const code = js(`${card}
func f(kind ?string) Node {
    const Page comp(title string, kind ?string, children Content) = Card
    return <Page title="a" kind={kind} />
}`);

    expect(code).toContain('const [$$page7] = Page("a", kind ?? undefined, $$children8);');
  });
});

describe('without type checking', () => {
  it('cannot compile a tag that takes its component from a value', () => {
    expect(() =>
      compile(`${card}const Page comp(title string) = Card\nconst x = <Page title="a" />`, {
        typeCheck: false,
      }),
    ).toThrow(
      '<Page> takes its component from a value, whose type gives the order of the properties: compile it with type checking',
    );
  });
});

describe('running', () => {
  const app = `${card}
interface Section {
    title string
    content comp()
}

comp Intro() {
    return <p>intro</p>
}

comp Counter(title string, kind ?string) {
    state clicks = 0
    mount() {
        console.log("mount " + title)
        return () => console.log("unmount " + title)
    }
    return <button onClick={clicks++}>{title}:{kind ?? "-"}:{clicks}</button>
}

const SECTIONS []Section = [{ title: "Intro", content: Intro }]

comp Page(sections []Section) {
    state title = "a"
    state Current comp(title string, kind ?string) = Card
    return <main>
        {for section in sections {
            <section.content />
        }}
        <Current title={title} />
        <button onClick={Current = Counter}>counter</button>
        <button onClick={Current = Card}>card</button>
        <button onClick={title = title + "!"}>title</button>
    </main>
}

document.body.append(<Page sections={SECTIONS} />)`;

  it('creates the component again when the value changes, and sets its properties otherwise', async () => {
    const { body, output } = mountWithDom(app);
    const main = () => String(body.find('main')).replace(/<\/?main>/g, '');

    expect(main()).toBe(
      '<p>intro</p><div className=primary><h2>a</h2></div><button>counter</button><button>card</button><button>title</button>',
    );
    body.find('button', 2).click(); // title
    expect(main()).toContain('<div className=primary><h2>a!</h2></div>');
    body.find('button', 0).click(); // switches to Counter
    await Promise.resolve();
    expect(main()).toContain('<button>a!:-:0</button>');
    expect(output).toEqual(['mount a!']);
    // The counter is the first button now, and keeps its state when the title changes.
    body.find('button', 0).click();
    body.find('button', 3).click();
    expect(main()).toContain('<button>a!!:-:1</button>');
    body.find('button', 2).click(); // back to Card: the counter is removed
    expect(output).toEqual(['mount a!', 'unmount a!!']);
    expect(main()).toContain('<div className=primary><h2>a!!</h2></div>');
  });
});

describe('modules', () => {
  const pages = `export comp Card(title string) {
    return <h2>{title}</h2>
}

export comp Layout(Page comp(title string)) {
    return <main><Page title="inside" /></main>
}

export const Default comp(title string) = Card

comp Item() {
    return <li>item</li>
}

// Its code uses Item as a value, which is the function of this module: so it is always called.
export comp Menu() {
    const items []comp() = [Item]
    return <ul>{for Entry in items { <Entry /> }}</ul>
}
`;

  function compileMain(main: string) {
    const dir = markupProject('rook-values-');

    writeFileSync(join(dir, 'pages.rk'), pages);
    writeFileSync(join(dir, 'main.rk'), main);

    const filename = join(dir, 'main.rk');
    const result = compile(readFileSync(filename, 'utf8'), { filename });

    expect(result.diagnostics).toEqual([]);

    return result.code;
  }

  it('imports the function of a component used as a value, not the component', () => {
    const code = compileMain(`import { Card } from "./pages.rk"
const all []comp(title string) = [Card]`);

    expect(code).toMatch(/^import \{ \$\$Card \} from "\.\/pages\.js";$/m);
    expect(code).toContain('const all = [$$Card];');
  });

  it('imports a variable of a component type like any other', () => {
    const code = compileMain(`import { Default } from "./pages.rk"
document.body.append(<Default title="a" />)`);

    expect(code).toMatch(/^import \{ Default \} from "\.\/pages\.js";$/m);
    expect(code).toContain('= Default("a");');
  });

  it('calls a component of another module whose code uses a component as a value', () => {
    const code = compileMain(`import { Menu } from "./pages.rk"
document.body.append(<Menu />)`);

    expect(code).toMatch(/^import \{ \$\$Menu \} from "\.\/pages\.js";$/m);
    expect(code).not.toContain('// <Menu>');
  });

  it('declares a component type as the type of its function', () => {
    const dir = markupProject('rook-values-');
    const filename = join(dir, 'pages.rk');

    writeFileSync(filename, pages);

    const result = compile(pages, { filename, declarations: true });

    expect(result.declarations).toContain(
      'export declare const Default: (title: string) => [Node, ...unknown[]];',
    );
  });

  it('calls a property of an inlined component of another module', () => {
    const code = compileMain(`import { Layout } from "./pages.rk"
comp Intro(title string) {
    return <p>{title}</p>
}
document.body.append(<Layout Page={Intro} />)`);

    expect(code).toContain('// <Layout>');
    expect(code).toContain('function $$Intro(title) {');
    expect(code).toContain('const Page = $$Intro;');
    expect(code).toMatch(/= Page\("inside"\);/);
  });
});
