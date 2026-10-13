import { describe, expect, it } from 'vitest';
import { check } from '../src/checker/checker.ts';
import { compile } from '../src/index.ts';
import { parse } from '../src/parser/parser.ts';
import { mountWithDom } from './fake-dom.ts';

// `...attrs`: a component takes the attributes of a use that are not its properties, and
// `{...attrs}` puts them on one of its elements. They are checked as attributes of that element.

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

const button = `comp Button(kind "primary" | "ghost" = "primary", children Content, ...attrs) {
    return <button class={kind} type="button" {...attrs}>{children}</button>
}
`;

describe('syntax', () => {
  it.each([
    [
      'comp A(...attrs, x number) {\n    return <p {...attrs} />\n}',
      '...attrs is the last property of a component',
    ],
    [
      'comp A(...attrs string) {\n    return <p {...attrs} />\n}',
      '...attrs has no type and no default: it gets the type of the element it is spread on',
    ],
    ['func f(...args) {}', '...args is only for components: it takes the attributes of an element'],
  ])('reports %j', (source, message) => {
    expect(errors(source)).toEqual([message]);
  });
});

describe('types', () => {
  it('checks the attributes of a use against the element', () => {
    expect(
      errors(
        `${button}let n = 0\nconst b = <Button kind="ghost" disabled type="submit" aria-label="x" onFocus={n++} class="wide">Go</Button>`,
      ),
    ).toEqual([]);
    expect(errors(`${button}const b = <Button disabled={1}>Go</Button>`)).toEqual([
      'cannot use number as bool for attribute "disabled"',
    ]);
    expect(
      errors(
        `${button}const b = <Button onClick={console.log(event.currentTarget.form)}>Go</Button>`,
      ),
    ).toEqual([]);
  });

  it.each([
    [
      `${button}const c = "x"\nconst b = <Button class={c}>Go</Button>`,
      'class passed to <Button> is added to that of its element, so it is a string: class="..."',
    ],
    [
      `${button}let v = ""\nconst b = <Button bind:value={v}>Go</Button>`,
      'bind:value does not go through the attributes of <Button>',
    ],
    [
      'comp A(...attrs) {\n    return <p />\n}',
      '...attrs is not spread on an element; put it among the attributes of one, e.g. <button {...attrs}>',
    ],
    [
      'comp A(...attrs) {\n    return <p {...attrs}><b {...attrs} /></p>\n}',
      '...attrs is spread on another element already: the attributes go to one element',
    ],
    [
      'comp A(items []string, ...attrs) {\n    return <ul>{for i in items { <li {...attrs}>{i}</li> }}</ul>\n}',
      '{...attrs} is inside {for}, which may create the element more than once; spread it on an element the component creates once',
    ],
    [
      'comp B() {\n    return <i />\n}\ncomp A(...attrs) {\n    return <B {...attrs} />\n}',
      '{...attrs} goes on an element, not on <B>: the attributes are those of an element',
    ],
    ['comp A() {\n    return <p />\n}\nconst a = <A title="x" />', '<A> has no property "title"'],
  ])('reports %j', (source, message) => {
    expect(errors(source)).toEqual([message]);
  });
});

describe('generated code', () => {
  it('makes a function of the attributes where the component is used', () => {
    const code = js(
      `${button}let n = 0\ndocument.body.append(<Button disabled onFocus={n++}>Go</Button>, <Button>No</Button>)`,
    );

    expect(code).toContain(`const $$attrs2 = ($$element) => {
  $$element.disabled = true;
  $$element.addEventListener("focus", () => {
    n++;
  });
};`);
    expect(code).toContain('const attrs = $$attrs2;');
    expect(code).toContain('const attrs = null;');
    expect(code).toMatch(/attrs\?\.\(\$\$button\d+\);/);
  });

  it('keeps the element for the updates of attributes that read state', () => {
    const code = js(`export ${button}comp App() {
    state title = "x"
    return <p onClick={title = "y"}><Button title={title}>Go</Button></p>
}
document.body.append(<App />)`);

    expect(code).toContain('export function $$Button(kind = "primary", children, attrs, $$root) {');
    expect(code).toMatch(/title = "y";\n\s+\$\$attrsElement(\d+)\.title = title;/);
    expect(code).toMatch(/= \$\$Button\(undefined, \$\$children\d+, \$\$attrs\d+\);/);
  });
});

describe('running', () => {
  it('puts the attributes on the element, after its own', () => {
    const { body, output } = mountWithDom(
      `${button}document.body.append(<Button kind="ghost" type="submit" class="wide" title="Save" onClick={console.log("clicked")}>Save</Button>)`,
    );
    const element = body.find('button');

    element.click();
    expect(output).toEqual(['clicked']);
    expect(element.type).toBe('submit');
    expect(element.className).toBe('ghost wide');
    expect(element.title).toBe('Save');
  });
});
