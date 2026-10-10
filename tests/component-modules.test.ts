import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/index.ts';
import { mango } from '../src/vite.ts';
import { mountJsWithDom } from './fake-dom.ts';

// Exported components, `export comp Card(...) { ... }`: their module compiles them to functions,
// `export function $$Card(...)`, which other modules import and call. Their code stays in their
// module, with its names and components.

const card = `const PREFIX = "#"

comp Icon(name string) {
    return <input value={PREFIX + name} />
}

export comp Card(title string, count number = 0, children Content) {
    return <section>
        <Icon name={title} />
        <b>{count}</b>
        {children}
    </section>
}

export comp Field(name string) {
    return <Icon name={name} />
}

dec counter() {
    public state clicks = 0

    public func add() {
        clicks++
    }

    mount() {
        console.log("mounted")
    }
}

@counter
export comp Clicker() {
    return <button onClick={@counter.add()}>{get(@counter.clicks)}</button>
}

type Item { name string; children []Item }

export comp Tree(item Item) {
    return <ul>{item.name}{for child in item.children { <Tree item={child} /> }}</ul>
}
`;

const app = `import { Card as Box, Clicker, Tree } from "./card.mango"

comp App() {
    state count = 1
    return <div>
        <button onClick={count++}>+</button>
        <Box title="a" count={count}><p>inside</p></Box>
        <Clicker />
        <Tree item={{ name: "a", children: [{ name: "b", children: [] }] }} />
    </div>
}

document.body.append(<App />)
`;

/** Writes the files to a new directory. */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mango-comp-'));

  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);

  return dir;
}

function compileIn(dir: string, name: string) {
  const filename = join(dir, name);

  return compile(readFileSync(filename, 'utf8'), { filename });
}

const errors = (main: string) =>
  compileIn(project({ 'card.mango': card, 'main.mango': main }), 'main.mango').diagnostics.map(
    (d) => d.message,
  );

describe('types', () => {
  it('checks the properties of imported components', () => {
    const imported = 'import { Card } from "./card.mango"\n';

    expect(errors(`${imported}const c = <Card title="a" />`)).toEqual([]);
    expect(errors(`${imported}const c = <Card />`)).toEqual(['<Card> needs the property "title"']);
    expect(errors(`${imported}const c = <Card title={1} />`)).toEqual([
      'cannot use number as string for "title" of <Card>',
    ]);
    expect(
      errors('import { Card as Box } from "./card.mango"\nconst c = <Box title="a" />'),
    ).toEqual([]);
    expect(errors('import { Icon } from "./card.mango"')).toEqual([
      '"Icon" is not exported by "./card.mango"',
    ]);
  });

  it('gives a use the type its module finds, whatever the names are here', () => {
    expect(
      errors(`import { Field } from "./card.mango"
comp Icon() {
    return <p />
}
const input HTMLInputElement = <Field name="a" />`),
    ).toEqual([]);
  });
});

describe('generated code', () => {
  it('exports the function of the component and calls it where it is used', () => {
    const dir = project({ 'card.mango': card, 'main.mango': app });
    const exporter = compileIn(dir, 'card.mango');
    const user = compileIn(dir, 'main.mango');

    expect(exporter.diagnostics).toEqual([]);
    expect(exporter.code).toContain('export function $$Card(title, count = 0, children) {');
    // A component that is not exported is inlined into the function, in its module.
    expect(exporter.code).not.toContain('$$Icon');
    expect(user.diagnostics).toEqual([]);
    expect(user.code).toMatch(
      /^import \{ \$\$Card as \$\$Box, \$\$Clicker, \$\$Tree \} from "\.\/card\.js";$/m,
    );
    expect(user.code).toContain('= $$Box("a", count, $$children');
  });
});

describe('running', () => {
  it('works when Vite bundles the modules', async () => {
    const dir = project({
      'index.html': '<script type="module" src="./main.mango"></script>',
      'card.mango': card,
      'main.mango': app,
    });

    await build({
      configFile: false,
      root: dir,
      logLevel: 'silent',
      plugins: [mango()],
      build: { outDir: join(dir, 'dist'), minify: false, modulePreload: { polyfill: false } },
    });

    const assets = join(dir, 'dist', 'assets');
    const [bundle] = readdirSync(assets).filter((name) => name.endsWith('.js'));
    const { body, output } = mountJsWithDom(readFileSync(join(assets, bundle!), 'utf8'));

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    body.find('button').click();
    body.find('button', 1).click();
    expect(String(body)).toBe(
      '<body><div><button>+</button>' +
        '<section><input value=#a></input><b>2</b><p>inside</p></section>' +
        '<button>1</button>' +
        '<ul>a<ul>b</ul></ul></div></body>',
    );
    expect(output).toEqual(['mounted']);
  });
});
