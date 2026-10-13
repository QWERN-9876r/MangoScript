import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check } from '../src/checker/checker.ts';
import { compile } from '../src/index.ts';
import { parse } from '../src/parser/parser.ts';
import { mountWithDom } from './fake-dom.ts';

// `<Card ref={card} />` points to the element at the top of what Card returns: the ref creates it
// in advance, and Card fills it in, whether it is inlined or a function. The children of a
// component are created once by the markup that uses it, so refs in them work as anywhere there.

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

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const field = `comp Field(label string) {
    return <label class="field">{label}<input /></label>
}
`;

describe('types', () => {
  it('gives a ref the type of what the component creates', () => {
    expect(
      errors(
        `${field}comp A() {\n    ref f\n    const l HTMLLabelElement = f\n    return <Field ref={f} label="a" />\n}`,
      ),
    ).toEqual([]);
  });

  it('reports components whose element is not known in advance', () => {
    const many =
      'comp Many(early bool) {\n    if early {\n        return <p />\n    }\n    return <b />\n}\n';
    const use = (tag: string) =>
      `comp A() {\n    ref r\n    return <div><${tag} ref={r} /></div>\n}\n`;

    expect(errors(`${many}${use('Many early={true}')}`)).toEqual([
      'ref cannot point to <Many>: it has several returns, so its element is not known in advance',
    ]);
    expect(errors(`comp Frag() {\n    return <>text</>\n}\n${use('Frag')}`)).toEqual([
      'ref cannot point to <Frag>: it returns a fragment, which is empty once inserted',
    ]);
    expect(
      errors(`${many}comp Outer() {\n    return <Many early={false} />\n}\n${use('Outer')}`),
    ).toEqual([
      'ref cannot point to <Outer>: it returns <Many>, which has several returns, so its element is not known in advance',
    ]);
    expect(
      errors(`dec choose() {
    state missing = false
    return (page Element) => missing ? <p /> : page
}
@choose
comp Page() {
    return <main />
}
${use('Page')}`),
    ).toEqual([
      'ref cannot point to <Page>: it does not return markup of its own, so its element is not known in advance',
    ]);
  });

  it('keeps the property "ref" for refs', () => {
    expect(errors('comp A(ref string) {\n    return <p />\n}')).toEqual([
      'a component cannot have the property "ref": ref={...} binds a ref',
    ]);
  });
});

describe('inlined components', () => {
  it('creates the element at the top of the component where the ref is declared', async () => {
    const source = `${field}comp Form() {
    ref name
    console.log("body", name.className, name.childNodes.length)
    mount() {
        console.log("mount", name.childNodes.length)
    }
    return <form><Field ref={name} label="Name" /></form>
}
document.body.append(<Form />)
`;
    const code = js(source);

    expect(code).toContain(
      '  const name = document.createElement("label");\n  name.className = "field";',
    );
    expect(code).toContain('    name.append(label, $$input');

    const { output, body } = mountWithDom(source);

    await flush();
    expect(output).toEqual(['body field 0', 'mount 2']);
    expect(String(body)).toBe(
      '<body><form><label className=field>Name<input></input></label></form></body>',
    );
  });

  it('gives the element a name of its own where the component could hide the ref', () => {
    const code = js(`comp Field(name string) {
    return <label class="field">{name}</label>
}
comp Form() {
    ref name
    return <form><Field ref={name} name="Name" /></form>
}
document.body.append(<Form />)
`);

    expect(code).toMatch(/const (\$\$root\d+) = name;\n[^]*\1\.append\(name\);/);
  });

  it('follows the components a component returns, and its own ref to the element', () => {
    const { output, body } = mountWithDom(`comp Inner() {
    ref own
    console.log("inner", own.className)
    return <section class="inner" ref={own} />
}
comp Outer() {
    return <Inner />
}
comp A() {
    ref outer
    console.log("a", outer.className)
    return <main><Outer ref={outer} /></main>
}
document.body.append(<A />)
`);

    expect(output).toEqual(['a inner', 'inner inner']);
    expect(String(body)).toBe('<body><main><section className=inner></section></main></body>');
  });

  it('follows the wrapper of a decorator, or what the wrapper gets', () => {
    const { output, body } = mountWithDom(`dec framed() {
    return (content Element) => <div class="frame">{content}</div>
}
dec logged() {
    return (content Element) => {
        console.log("wrapped")
        return content
    }
}
@framed
comp Framed() {
    return <p />
}
@logged
comp Logged() {
    return <b class="own" />
}
comp A() {
    ref framed
    ref logged
    console.log(framed.className, logged.className)
    return <main><Framed ref={framed} /><Logged ref={logged} /></main>
}
document.body.append(<A />)
`);

    expect(output).toEqual(['frame own', 'wrapped']);
    expect(String(body)).toBe(
      '<body><main><div className=frame><p></p></div><b className=own></b></main></body>',
    );
  });

  it('binds refs in the children of a component', async () => {
    const { output, body } = mountWithDom(`comp Modal(children Content) {
    return <dialog>{if true { <p>{children}</p> }}</dialog>
}
comp A() {
    ref input
    mount() {
        console.log(input.isConnected, input.parentNode != null)
    }
    return <Modal><input ref={input} /></Modal>
}
document.body.append(<A />)
`);

    await flush();
    expect(output).toEqual(['true true']);
    expect(String(body)).toBe('<body><dialog><p><input></input></p></dialog></body>');
  });
});

describe('function components', () => {
  const tree = `comp Tree(depth number) {
    return <li class="node">{depth}{if depth < 2 { <ul><Tree depth={depth + 1} /></ul> }}</li>
}
comp A() {
    ref tree
    console.log(tree.className)
    return <main><Tree ref={tree} depth={0} /></main>
}
document.body.append(<A />)
`;

  it('gives the function the element as its last argument', () => {
    const code = js(tree);

    expect(code).toContain('function $$Tree(depth, $$root) {');
    expect(code).toContain('= $$root ?? document.createElement("li");');
    expect(code).toMatch(/\$\$Tree\(0, tree\)/);
  });

  it('fills in the element, and creates one without a ref', () => {
    const { output, body } = mountWithDom(tree);

    expect(output).toEqual(['node']);
    expect(String(body)).toBe(
      '<body><main><li className=node>0<ul><li className=node>1<ul><li className=node>2</li></ul></li></ul></li></main></body>',
    );
  });

  it('takes no element when no ref can point to it', () => {
    expect(
      js(tree.replace('ref={tree} ', '').replace(/ {4}(ref tree|console.*)\n/g, '')),
    ).toContain('function $$Tree(depth) {');
  });
});

describe('modules', () => {
  const card = `export comp Card(title string) {
    return <section class="card">{title}</section>
}

type Item { name string; children []Item }

export comp Tree(item Item) {
    return <ul class="tree">{item.name}{for child in item.children { <Tree item={child} /> }}</ul>
}
`;
  const main = `import { Card, Tree } from "./card.mango"
comp App() {
    ref card
    ref tree
    console.log(card.className, tree.className)
    return <main>
        <Card ref={card} title="a" />
        <Tree ref={tree} item={{ name: "b", children: [] }} />
    </main>
}
document.body.append(<App />)
`;

  it('creates the element of a component of another module, inlined or called', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mango-ref-'));

    writeFileSync(join(dir, 'card.mango'), card);
    writeFileSync(join(dir, 'main.mango'), main);

    const filename = join(dir, 'main.mango');
    const { code, diagnostics } = compile(readFileSync(filename, 'utf8'), { filename });

    expect(diagnostics).toEqual([]);
    expect(code).toContain(
      '  const card = document.createElement("section");\n  card.className = "card";',
    );
    expect(code).toContain(
      '  const tree = document.createElement("ul");\n  tree.className = "tree";',
    );
    expect(code).toMatch(/= \$\$Tree\(\$\$0, tree\);/);
    expect(code).toContain('$$card');
  });
});
