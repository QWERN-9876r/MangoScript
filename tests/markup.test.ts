import { describe, expect, it } from 'vitest';
import type * as ast from '../src/ast.ts';
import { check } from '../src/checker/checker.ts';
import { compile } from '../src/index.ts';
import { tokenize } from '../src/lexer/lexer.ts';
import { parse } from '../src/parser/parser.ts';

// Markup: `<a href="/">Ссылка {name}</a>` creates a DOM element.

// ─── Helpers ─────────────────────────────────────────────────────────────────────────────────────

function tokens(source: string): string[] {
  const { tokens, diagnostics } = tokenize(source);
  expect(diagnostics).toEqual([]);
  return tokens
    .filter((t) => t.kind !== 'EOF')
    .map((t) =>
      t.kind === ';' && t.text === ''
        ? '⏎'
        : t.kind.startsWith('Jsx')
          ? `${t.kind.slice(3)}:${t.text}`
          : t.text,
    );
}

/** The element in `x = <...>`. */
function element(source: string): ast.ElementExpression {
  const { program, diagnostics } = parse(`x = ${source}`);
  expect(diagnostics).toEqual([]);
  const statement = program.body[0] as ast.AssignmentStatement;
  return statement.values[0] as ast.ElementExpression;
}

/** Markup printed back in a compact form, to check the tree. */
function markup(node: ast.ElementExpression): string {
  const attributes = node.attributes.map((attribute) => {
    if (attribute.kind === 'JsxSpreadAttribute') return '{...}';
    const { value } = attribute;
    const name = attribute.name.name;
    if (value === null) return name;
    if (value.kind === 'StringLiteral') return `${name}=${JSON.stringify(value.value)}`;
    if (value.kind === 'EventHandler') {
      return `${name}={${value.body.map((statement) => statement.kind).join('; ')}}`;
    }
    return `${name}={${value.kind}}`;
  });
  const children = node.children.map((child) => {
    if (child.kind === 'JsxText') return JSON.stringify(child.value);
    if (child.kind === 'JsxExpressionContainer') return `{${child.expression.kind}}`;
    return markup(child);
  });
  const tag = node.tag?.name ?? '';
  return `<${[tag, ...attributes].join(' ')}>${children.join('')}</${tag}>`;
}

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

// ─── A tiny DOM, enough to run generated code ────────────────────────────────────────────────────

class FakeNode {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly children: (FakeNode | string)[] = [];
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  readonly style: Record<string, string> = {};
  [property: string]: unknown;

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  append(...items: unknown[]): void {
    for (const item of items) this.children.push(item instanceof FakeNode ? item : String(item));
  }

  setAttribute(name: string, value: unknown): void {
    this.attributes.set(name, String(value));
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ type, currentTarget: this, preventDefault() {} });
    }
  }

  click(): void {
    this.dispatch('click');
  }

  /** HTML-like text: properties that were set are shown as attributes. */
  toString(): string {
    const shown = ['id', 'className', 'href', 'type', 'value', 'checked', 'disabled', 'htmlFor'];
    const attributes = [
      ...shown
        .filter((name) => this[name] !== undefined)
        .map((name) => `${name}=${String(this[name])}`),
      ...[...this.attributes].map(([name, value]) => `${name}=${value}`),
      ...(this.style.cssText ? [`style=${this.style.cssText}`] : []),
    ];
    const open = [this.tagName, ...attributes].join(' ');
    return `<${open}>${this.children.map(String).join('')}</${this.tagName}>`;
  }
}

/** Compiles and runs a program with a fake `document`; returns what it printed. */
function run(source: string): string[] {
  const output: string[] = [];
  const fakeConsole = { log: (...args: unknown[]) => output.push(args.map(String).join(' ')) };
  const document = {
    createElement: (tag: string) => new FakeNode(tag),
    createDocumentFragment: () => new FakeNode('#fragment'),
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const program = new Function('console', 'document', `"use strict";\n${js(source)}`) as (
    console: typeof fakeConsole,
    document: unknown,
  ) => void;
  program(fakeConsole, document);
  return output;
}

// ─── Lexer ───────────────────────────────────────────────────────────────────────────────────────

describe('lexer', () => {
  it('reads tags, attributes, text and expressions', () => {
    expect(tokens('x = <a href="/" class={c}>Ссылка {name}</a>')).toEqual([
      ...['x', '=', 'TagOpen:<', 'Name:a', 'Name:href', '=', 'String:"/"', 'Name:class'],
      ...['=', '{', 'c', '}', 'TagEnd:>', 'Text:Ссылка ', '{', 'name', '}'],
      ...['CloseTagOpen:</', 'Name:a', 'TagEnd:>', '⏎'],
    ]);
  });

  it.each(['a < b', 'f() < 3', 'xs[0] < n', 'x < y && y < z'])(
    'reads %j as comparisons',
    (source) => {
      expect(tokens(source)).not.toContain('TagOpen:<');
    },
  );

  it.each([
    'return <b />',
    'f(<b />)',
    'x = [<b />]',
    'f(a, <b />)',
    'x = ok ? <b /> : null',
    'f(() => <b />)',
  ])('starts markup in %j', (source) => {
    expect(tokens(source)).toContain('TagOpen:<');
  });

  it('reads fragments, self-closing tags and names with - and :', () => {
    expect(tokens('x = <><my-widget aria-label="a" bind:value={v} /></>')).toEqual([
      ...['x', '=', 'TagOpen:<', 'TagEnd:>', 'TagOpen:<', 'Name:my-widget', 'Name:aria-label'],
      ...['=', 'String:"a"', 'Name:bind:value', '=', '{', 'v', '}', 'SelfClose:/>'],
      ...['CloseTagOpen:</', 'TagEnd:>', '⏎'],
    ]);
  });

  it('decodes entities but keeps text as written', () => {
    const { tokens: list } = tokenize('x = <p title="a &amp; b">1 &lt; 2 &#169;</p>');
    const values = list.filter((t) => 'value' in t).map((t) => (t as { value: string }).value);
    expect(values).toEqual(['a & b', '1 < 2 ©']);
  });

  it('handles braces and templates inside expressions', () => {
    const list = tokens('x = <p>{f({ a: `${<b>{1}</b>}` })}</p>');
    expect(list.filter((t) => t.startsWith('CloseTagOpen'))).toHaveLength(2);
    expect(list.at(-1)).toBe('⏎');
  });

  it('inserts no semicolons inside markup, but after it', () => {
    expect(tokens('x = <ul>\n  <li>a</li>\n</ul>\ny = 1')).toEqual([
      ...['x', '=', 'TagOpen:<', 'Name:ul', 'TagEnd:>', 'Text:\n  ', 'TagOpen:<', 'Name:li'],
      ...['TagEnd:>', 'Text:a', 'CloseTagOpen:</', 'Name:li', 'TagEnd:>', 'Text:\n'],
      ...['CloseTagOpen:</', 'Name:ul', 'TagEnd:>', '⏎', 'y', '=', '1', '⏎'],
    ]);
  });

  it('reports unterminated markup', () => {
    expect(tokenize('x = <div>text').diagnostics.map((d) => d.message)).toEqual([
      'unterminated element',
    ]);
    expect(tokenize('x = <div title="a>').diagnostics.map((d) => d.message)).toContain(
      'unterminated attribute value',
    );
  });
});

// ─── Parser ──────────────────────────────────────────────────────────────────────────────────────

describe('parser', () => {
  it.each([
    [
      '<a href="/" class={c}>Ссылка {name}</a>',
      '<a href="/" class={Identifier}>"Ссылка "{Identifier}</a>',
    ],
    ['<input disabled {...rest} />', '<input disabled {...}></input>'],
    ['<>a<br />b</>', '<>"a"<br></br>"b"</>'],
    ['<p>{/* comment */}text{}</p>', '<p>"text"</p>'],
    [
      '<ul>\n    <li>one</li>\n    <li>\n        two\n        lines\n    </li>\n</ul>',
      '<ul><li>"one"</li><li>"two lines"</li></ul>',
    ],
  ])('%s', (source, expected) => {
    expect(markup(element(source))).toBe(expected);
  });

  it.each([
    ['onClick={count++}', 'onClick={IncDecStatement}'],
    ['onClick={save(todo)}', 'onClick={ExpressionStatement}'],
    [
      'onSubmit={event.preventDefault(); send()}',
      'onSubmit={ExpressionStatement; ExpressionStatement}',
    ],
    ['onInput={title = event.currentTarget.value}', 'onInput={AssignmentStatement}'],
    ['onClick={handle}', 'onClick={Identifier}'],
    ['onClick={app.handle}', 'onClick={MemberExpression}'],
    ['onClick={() => handle(1)}', 'onClick={ArrowFunction}'],
  ])('reads the handler %s', (attribute, expected) => {
    expect(markup(element(`<button ${attribute}>x</button>`))).toBe(
      `<button ${expected}>"x"</button>`,
    );
  });

  it.each([
    ['x = <div>text</span>', 'expected </div> to close <div>'],
    [
      'x = <button onClick={a + b}>x</button>',
      'this expression does nothing: only function calls can be used as statements',
    ],
    ['x = <button onClick=go>x</button>', 'expected "..." or {...} after "onClick=", found "go"'],
  ])('reports %j', (source, message) => {
    expect(errors(source)).toEqual([message]);
  });

  it('parses markup over several lines after return', () => {
    const { diagnostics } = parse(
      'func f() HTMLElement {\n    return <div>\n        <p>a</p>\n    </div>\n}',
    );
    expect(diagnostics).toEqual([]);
  });
});

// ─── Types ───────────────────────────────────────────────────────────────────────────────────────

describe('types', () => {
  it.each([
    [
      'element types',
      'const a HTMLAnchorElement = <a href="/">x</a>\nconst input HTMLInputElement = <input />\nconst div HTMLElement = <div />',
    ],
    [
      'properties',
      'const input = <input value="a" checked={true} maxLength={10} />\nconst s string = input.value',
    ],
    [
      'typed events',
      'const input = <input onInput={console.log(event.currentTarget.value.trim())} />',
    ],
    [
      'handler functions',
      'func handle(e Event) {}\nconst b = <button onClick={handle} onKeyDown={e => console.log(e.key)}>x</button>',
    ],
    [
      'children',
      'const n = 1\nconst note ?string = null\nconst items = ["a"]\nconst p = <p>{n} {"s"} {note} {items} {<b />} {items.map(i => <i>{i}</i>)}</p>',
    ],
    ['fragments', 'const f DocumentFragment = <><p /><p /></>'],
    [
      'other attributes',
      'const d = <div data-id={7} aria-hidden={true} role="note" style="color: red" />\nconst e = <div style={{ color: "red" }} />',
    ],
    [
      'functions that return elements',
      'func item(title string) HTMLLIElement {\n    return <li>{title}</li>\n}',
    ],
  ])('accepts %s', (_, source) => {
    expect(errors(source)).toEqual([]);
  });

  it.each([
    ['const i = <input checked={1} />', 'cannot use number as bool for attribute "checked"'],
    ['const d = <div title={[1]} />', 'cannot use []number as string for attribute "title"'],
    [
      'const d = <div data-x={[1]} />',
      'attribute "data-x" needs a string, number or bool, not []number',
    ],
    [
      'const d = <div>{true}</div>',
      'cannot use bool as element content: use a condition, e.g. {ok ? <b>yes</b> : null}',
    ],
    [
      'const b = <button onClick={1}>x</button>',
      'this expression does nothing: only function calls can be used as statements',
    ],
    [
      'const n = 1\nconst b = <button onClick={n}>x</button>',
      'cannot use number as func(Event) as the "onClick" handler',
    ],
    [
      'const b = <button onClick="go()">x</button>',
      '"onClick" needs code or a function in braces, e.g. onClick={save()}',
    ],
    [
      'const b = <button onClick={console.log(event.nope)}>x</button>',
      'Event has no member "nope"',
    ],
    [
      'const a HTMLInputElement = <a />',
      'cannot use HTMLAnchorElement as HTMLInputElement: missing "value"',
    ],
    ['const c = <Counter />', 'components (<Counter />) are not supported yet'],
  ])('rejects %j', (source, message) => {
    expect(errors(source)).toEqual([message]);
  });
});

// ─── Code generation ─────────────────────────────────────────────────────────────────────────────

describe('code generation', () => {
  it('creates the element right in the variable', () => {
    expect(
      js('const name = "на главную"\nconst link = <a href="/" class="nav">Ссылка {name}</a>'),
    ).toBe(
      `const name = "на главную";
const link = document.createElement("a");
link.href = "/";
link.className = "nav";
link.append("Ссылка ", name);`,
    );
  });

  it('creates elements inside an expression before the statement', () => {
    expect(js('document.body.append(<p>Привет</p>)')).toBe(
      `const $$p1 = document.createElement("p");
$$p1.append("Привет");
document.body.append($$p1);`,
    );
  });

  it('creates elements in a branch only when the branch runs', () => {
    expect(js('func f(ok bool) any {\n    return ok ? <b>да</b> : null\n}')).toBe(
      `function f(ok) {
  return ok ? (() => {
    const $$b1 = document.createElement("b");
    $$b1.append("да");
    return $$b1;
  })() : null;
}`,
    );
  });

  it('turns arrow functions that return markup into blocks', () => {
    expect(js('const items = ["a"]\nconst lis = items.map(i => <li>{i}</li>)')).toBe(
      `const items = ["a"];
const lis = items.map((i) => {
  const $$li1 = document.createElement("li");
  $$li1.append(i);
  return $$li1;
});`,
    );
  });

  it('sets properties, attributes, styles and events', () => {
    expect(
      js(
        'let n = 0\nconst x = <label for="name" data-id={7} style="color: red" onClick={n++} onDoubleClick={console.log(event.type)}>a</label>',
      ),
    ).toBe(
      `let n = 0;
const x = document.createElement("label");
x.htmlFor = "name";
x.setAttribute("data-id", 7);
x.style.cssText = "color: red";
x.addEventListener("click", () => {
  n++;
});
x.addEventListener("dblclick", (event) => {
  console.log(event.type);
});
x.append("a");`,
    );
  });

  it('checks values that may be null before using them', () => {
    expect(
      js('func f(note ?string) HTMLElement {\n    return <p data-note={note}>{note}</p>\n}'),
    ).toBe(
      `function f(note) {
  const $$p1 = document.createElement("p");
  if (note != null) $$p1.setAttribute("data-note", note);
  if (note != null) $$p1.append(note);
  return $$p1;
}`,
    );
  });
});

// ─── Behavior ────────────────────────────────────────────────────────────────────────────────────

describe('runtime behavior', () => {
  it('builds elements and runs their handlers', () => {
    expect(
      run(`const items = ["one", "two"]
let clicks = 0
const list = <ul class="list">{items.map(item => <li>{item}</li>)}</ul>
const button = <button type="button" onClick={clicks++}>Нажато {clicks}</button>
list.append(button)
button.click()
button.click()
console.log(list)
console.log(clicks)`),
    ).toEqual([
      '<ul className=list><li>one</li><li>two</li><button type=button>Нажато 0</button></ul>',
      '2',
    ]);
  });

  it('skips null children and attributes', () => {
    expect(
      run(`func card(title string, note ?string) HTMLElement {
    return <div data-note={note}><h2>{title}</h2>{note}</div>
}
console.log(card("A", null))
console.log(card("B", "есть"))`),
    ).toEqual(['<div><h2>A</h2></div>', '<div data-note=есть><h2>B</h2>есть</div>']);
  });
});
