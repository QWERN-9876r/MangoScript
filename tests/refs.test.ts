import { describe, expect, it } from 'vitest';
import { check } from '../src/checker/checker.ts';
import { compile } from '../src/index.ts';
import { parse } from '../src/parser/parser.ts';
import { mountWithDom } from './fake-dom.ts';

// `ref input` in a component and `<input ref={input} />` in its markup: the element is created
// where the ref is declared, with its constant attributes, and the markup fills it in.

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

/** Waits until the microtasks that run `mount()` are done. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A component with `body` before `return <main>{markup}</main>`. */
const component = (body: string, markup = '') =>
  `comp A(items []string) {\n${body}\n    return <main>${markup}</main>\n}\n`;

describe('syntax', () => {
  it('keeps ref an ordinary name elsewhere', () => {
    expect(
      errors('const ref = 1\nfunc f(ref number) number {\n    return ref\n}\nconst x = f(ref)'),
    ).toEqual([]);
    expect(errors(component('    let ref = 1\n    ref = 2\n    console.log(ref)'))).toEqual([]);
  });

  it.each([
    ['func f() {\n    ref x\n}', 'ref can only be declared inside a component'],
    [
      component('    if true {\n        ref x\n    }'),
      'ref is declared at the top level of a component, not inside blocks or functions',
    ],
    [component('    ref a, b', '<p ref={a} />'), 'ref declares one name, e.g. ref a'],
    [
      component('    ref x = <p />'),
      'ref "x" gets its element from the markup, not from a value: write ref x and <div ref={x}>',
    ],
    [
      'dec d() {\n    public ref x\n    return (c Element) => <div ref={x}>{c}</div>\n}',
      'only state, derived, const and func can be public, not "ref"',
    ],
  ])('reports %j', (source, message) => {
    expect(errors(source)).toEqual([message]);
  });
});

describe('types', () => {
  it('gives a ref the type of its element, or the one written', () => {
    expect(
      errors(
        component('    ref input\n    const text string = input.value', '<input ref={input} />'),
      ),
    ).toEqual([]);
    expect(
      errors(component('    ref input\n    const n number = input.value', '<input ref={input} />')),
    ).toEqual(['cannot use string as number']);
    expect(errors(component('    ref box HTMLElement', '<div ref={box} />'))).toEqual([]);
    expect(errors(component('    ref box HTMLInputElement', '<div ref={box} />'))).toEqual([
      // Without lib.dom, a <div> is an HTMLElement.
      expect.stringMatching(/^cannot use HTML\w*Element as HTMLInputElement for ref "box"/),
    ]);
  });

  it('keeps a ref read-only', () => {
    expect(errors(component('    ref box', '<div ref={box} onClick={box = <div />} />'))).toEqual([
      'cannot assign to "box": a ref always points to its element',
    ]);
  });

  it('lets markup and functions use a ref before its element in the markup', () => {
    expect(
      errors(
        component(
          '    ref input\n    func clear() {\n        input.value = ""\n    }',
          '<label for={input.id}>Name</label><input id="name" ref={input} onFocus={clear()} />',
        ),
      ),
    ).toEqual([]);
  });

  it.each([
    [
      component('    ref box'),
      'ref "box" is not bound to an element; add ref={box} to one, e.g. <div ref={box}>',
    ],
    [
      component('    ref box', '<div ref={box} /><div ref={box} />'),
      'ref "box" is already bound to another element; a ref points to one element',
    ],
    [
      component('    ref item', '<ul>{for each in items { <li ref={item}>{each}</li> }}</ul>'),
      'ref={item} is inside {for}: the element is created for every item, so a ref cannot point to it; put the element into a component, and each copy gets its own ref',
    ],
    [
      component('    ref note', '{if items.length > 0 { <p ref={note} /> }}'),
      'ref={note} is inside {if}: the element is created again when the branch changes, so a ref cannot point to it; move the element out of {if}, or into a component that has a ref of its own',
    ],
    [
      component('    ref note', '{switch items.length { case 0: <p ref={note} /> }}'),
      'ref={note} is inside {switch}: the element is created again when the case changes, so a ref cannot point to it; move the element out of {switch}, or into a component that has a ref of its own',
    ],
    [
      component('    ref note', '{items.length > 0 ? <p ref={note} /> : null}'),
      'ref={note} is inside an expression, which may create the element more than once; write the element in the markup the component returns',
    ],
    [
      component('    ref note\n    const make = () => <p ref={note} />'),
      'ref={note} is inside a function, which may create the element more than once; write the element in the markup the component returns',
    ],
    [
      component('    ref note\n    for each in items {\n        const p = <p ref={note} />\n    }'),
      'ref={note} is inside a block of the body, which may create the element more than once; write the element in the markup the component returns',
    ],
    [
      component('    let box = 1', '<div ref={box} />'),
      '"box" is not a ref; declare it with ref box',
    ],
    [component('', '<div ref={box} />'), '"box" is not defined'],
    [component('', '<div ref="box" />'), 'ref={...} takes the name of a ref, e.g. ref={input}'],
    ['const el = <div ref={el} />', '"el" is not a ref; declare it with ref el'],
  ])('reports %j', (source, message) => {
    expect(errors(source)).toEqual([message]);
  });
});

describe('generated code', () => {
  it('creates the element where the ref is declared, with its constant attributes', () => {
    expect(
      js(`comp Card(title string) {
    ref container

    console.log(container.className)

    return <div class="root" hidden ref={container}>
        <h2 title={title}>{title}</h2>
    </div>
}
document.body.append(<Card title="Profile" />)
`),
    ).toBe(`// <Card>
let $$card1;
{
  const title = "Profile";
  const container = document.createElement("div");
  container.className = "root";
  container.hidden = true;

  console.log(container.className);

  const $$h22 = document.createElement("h2");
  $$h22.title = title;
  $$h22.append(title);
  container.append($$h22);
  $$card1 = container;
}
document.body.append($$card1);
`);
  });

  it('leaves the attributes after a spread to the markup, which may override them', () => {
    const code = js(
      `${component('    ref box\n    const extra = { title: "x" }', '<div class="a" {...extra} title="b" ref={box} />')}document.body.append(<A items={[]} />)`,
    );

    expect(code).toContain(
      '  const box = document.createElement("div");\n  box.className = "a";\n  const extra',
    );
    expect(code).toContain('  Object.assign(box, extra);\n  box.title = "b";\n');
  });

  it('updates the element of a ref under its name', () => {
    const code = js(
      'comp A() {\n    state count = 0\n    ref p\n    return <p ref={p} title={`${count}`} onClick={count++} />\n}\ndocument.body.append(<A />)',
    );

    expect(code).toContain('p.title = `${count}`;');
    expect(code).not.toContain('$$p');
  });
});

describe('running', () => {
  it('gives the element before the markup, and the markup fills it in', async () => {
    const { output, body } = mountWithDom(`comp A() {
    ref box
    ref input
    console.log("body", box.className, box.childNodes.length)
    mount() {
        console.log("mount", box.className, box.childNodes.length, input.parentNode == box)
    }
    return <div class="root" ref={box}>
        <label for={input.id}>Name</label>
        <input id="name" type="number" ref={input} />
    </div>
}
document.body.append(<A />)
`);

    await flush();
    expect(output).toEqual(['body root 0', 'mount root 2 true']);
    expect(String(body)).toBe(
      '<body><div className=root><label htmlFor=name>Name</label><input id=name type=number></input></div></body>',
    );
  });

  it('keeps the element empty and out of the document after an early return', () => {
    const { output, body } = mountWithDom(`comp A(early bool) {
    ref box
    if early {
        console.log(box.className, box.parentNode == null)
        return <p>early</p>
    }
    return <div class="late" ref={box} />
}
document.body.append(<A early={true} />, <A early={false} />)
`);

    expect(output).toEqual(['late true']);
    expect(String(body)).toBe('<body><p>early</p><div className=late></div></body>');
  });
});

describe('decorators', () => {
  const measured = `dec measured() {
    ref frame
    mount() {
        console.log("frame", frame.className, frame.childNodes.length)
    }
    return (content Element) => <div class="measured" ref={frame}>{content}</div>
}
`;

  it('binds the refs of a decorator in its wrapper', async () => {
    const { output, body } = mountWithDom(`${measured}
@measured
comp A(early bool) {
    if early {
        return <p>early</p>
    }
    return <b>late</b>
}
document.body.append(<A early={true} />, <A early={false} />)
`);

    await flush();
    expect(output).toEqual(['frame measured 1', 'frame measured 1']);
    expect(String(body)).toBe(
      '<body><div className=measured><p>early</p></div><div className=measured><b>late</b></div></body>',
    );
  });

  it('keeps the refs of a decorator and of the component apart', () => {
    expect(errors(`${measured}\n@measured\ncomp A() {\n    return <p ref={frame} />\n}`)).toEqual([
      '"frame" is not defined',
    ]);
    expect(errors('dec d() {\n    ref frame\n    return (c Element) => <div>{c}</div>\n}')).toEqual(
      ['ref "frame" is not bound to an element; add ref={frame} to one, e.g. <div ref={frame}>'],
    );
  });
});
