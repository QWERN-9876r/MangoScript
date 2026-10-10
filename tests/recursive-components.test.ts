import { describe, expect, it } from 'vitest';
import { check } from '../src/checker/checker.ts';
import { compile } from '../src/index.ts';
import { parse } from '../src/parser/parser.ts';
import { mountWithDom } from './fake-dom.ts';

// Components that use themselves, directly or through other components: they become functions
// instead of being inlined, and a use that always runs would never end.

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
