import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/index.ts';
import { rook } from '../src/vite.ts';
import { mountJsWithDom } from './fake-dom.ts';
import { markupProject } from './project.ts';

// Exported decorators, `export dec counter() { ... }`, applied in other modules. Their code is
// inlined there, and the names of their module that it uses come through hidden exports:
// `export { log as $$counter$log }` and `import { $$counter$log } from "./counter.js"`.

const counter = `const STEP = 1

func log(text string) {
    console.log(text)
}

export dec counter(start number = 0) {
    public state count = start

    public func add() {
        count += STEP
        log("add")
    }
}

export dec badge() needs counter {
    return (content Element) => <div>{content}<span>{get(@counter.count)}</span></div>
}
`;

const clicker = (decorators = '@counter(5)\n@badge', body = '') => `${decorators}
comp Clicker() {${body}
    return <button onClick={@counter.add()}>+</button>
}

document.body.append(<Clicker />)
`;

/** Writes the files to a new directory. */
function project(files: Record<string, string>): string {
  const dir = markupProject('rook-dec-');

  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);

  return dir;
}

function compileIn(dir: string, name: string) {
  const filename = join(dir, name);

  return compile(readFileSync(filename, 'utf8'), { filename });
}

function errorsIn(files: Record<string, string>, name: string): string[] {
  return compileIn(project(files), name).diagnostics.map((d) => d.message);
}

describe('types', () => {
  const main = (decorators?: string, body?: string, imports = 'counter, badge') =>
    `import { ${imports} } from "./counter.rk"\n${clicker(decorators, body)}`;

  it('applies imported decorators with their members and wrappers', () => {
    expect(errorsIn({ 'counter.rk': counter, 'main.rk': main() }, 'main.rk')).toEqual([]);
    // The names of the decorator's module do not clash with the component's.
    expect(
      errorsIn(
        { 'counter.rk': counter, 'main.rk': main(undefined, '\n    const log = 1') },
        'main.rk',
      ),
    ).toEqual([]);
  });

  it('reports wrong imports and uses', () => {
    const errors = (text: string) =>
      errorsIn({ 'counter.rk': counter, 'main.rk': text }, 'main.rk');

    expect(errors(main(undefined, '', 'counter as c, badge'))).toEqual([
      'renaming decorators is not supported yet: import { counter }',
    ]);
    expect(errors(main('@badge', '', 'badge'))).toEqual([
      '@badge needs @counter above it: @counter @badge comp ...',
      'unknown decorator @counter',
    ]);
    // Global names are not renamed, so the component and its module must not hide them.
    expect(
      errorsIn(
        {
          'greet.rk': 'export dec greet() {\n    console.log("hi")\n}\n',
          'main.rk': `import { greet } from "./greet.rk"\n@greet\ncomp A() {\n    const console = 1\n    return <p />\n}`,
        },
        'main.rk',
      ),
    ).toEqual(['@greet uses the global "console", but here it is another declaration: rename it']);
    expect(
      errorsIn(
        {
          'greet.rk': 'export dec greet() {\n    console.log("hi")\n}\n',
          'main.rk': `import { greet } from "./greet.rk"\nconst console = 1\n@greet\ncomp A() {\n    return <p />\n}`,
        },
        'main.rk',
      ),
    ).toEqual(['@greet uses the global "console", but here it is another declaration: rename it']);
    expect(
      errorsIn(
        { 'a.rk': 'dec hidden() {\n}\n', 'main.rk': 'import { hidden } from "./a.rk"' },
        'main.rk',
      ),
    ).toEqual(['"hidden" is not exported by "./a.rk"']);
  });

  it('checks that an exported decorator works in other modules', () => {
    const errors = (text: string) => errorsIn({ 'a.rk': text }, 'a.rk');

    expect(errors('dec a() {\n}\nexport dec b() needs a {\n}')).toEqual([
      '@b is exported, so @a that it needs must be exported too: export dec a(...)',
    ]);
    expect(errors('let total = 0\nexport dec a() {\n    total++\n}')).toEqual([
      '@a is exported, so it cannot change "total" of its module: other modules can only read it; change it in a function of the module',
    ]);
    // Its components go with it, but not those of a third module.
    expect(
      errorsIn(
        {
          'badge.rk': 'export comp Badge() {\n    return <b />\n}\n',
          'a.rk':
            'import { Badge } from "./badge.rk"\nexport dec a() {\n    return (c Element) => <div>{c}<Badge /></div>\n}\n',
        },
        'a.rk',
      ),
    ).toEqual([
      '@a is exported, so its code goes into other modules with the components it uses: they cannot use components or decorators that this module imports yet, nor assign variables of this module',
    ]);
    // Nor can its components assign the variables of its module.
    expect(
      errors(
        'let count = 0\ncomp Badge() {\n    count++\n    return <b />\n}\nexport dec a() {\n    return (c Element) => <div>{c}<Badge /></div>\n}',
      ),
    ).toEqual([
      '@a is exported, so its code goes into other modules with the components it uses: they cannot use components or decorators that this module imports yet, nor assign variables of this module',
    ]);
  });
});

const marked = `const MARK = "*"

comp Badge(text string) {
    return <b>{MARK}{text}</b>
}

type Item { name string; children []Item }

comp Tree(item Item) {
    return <ul>{item.name}{for child in item.children { <Tree item={child} /> }}</ul>
}

export dec marked(label string) {
    state open = true

    public func toggle() {
        open = !open
    }

    return (content Element) => <div>
        <Badge text={label} />
        {open ? content : null}
        <Tree item={{ name: label, children: [] }} />
    </div>
}
`;

const page = `import { marked } from "./marked.rk"

comp Badge() {
    return <i>mine</i>
}

@marked("new")
comp Page() {
    return <p onClick={@marked.toggle()}>page</p>
}

document.body.append(<Page />, <Badge />)
`;

describe('components in decorators', () => {
  it('brings the components of the decorator with its code', () => {
    const dir = project({ 'marked.rk': marked, 'main.rk': page });
    const exporter = compileIn(dir, 'marked.rk');
    const user = compileIn(dir, 'main.rk');

    expect(exporter.diagnostics).toEqual([]);
    expect(exporter.code).toContain('export { MARK as $$marked$MARK, $$Tree };');
    expect(user.diagnostics).toEqual([]);
    expect(user.code).toMatch(
      /^import \{ \$\$marked\$MARK, \$\$Tree as \$\$marked\$Tree \} from "\.\/marked\.js";$/m,
    );
  });

  it('works when Vite bundles the modules', async () => {
    const dir = project({
      'index.html': '<script type="module" src="./main.rk"></script>',
      'marked.rk': marked,
      'main.rk': page,
    });

    await build({
      configFile: false,
      root: dir,
      logLevel: 'silent',
      plugins: [rook()],
      build: { outDir: join(dir, 'dist'), minify: false, modulePreload: { polyfill: false } },
    });

    const assets = join(dir, 'dist', 'assets');
    const [bundle] = readdirSync(assets).filter((name) => name.endsWith('.js'));
    const { body } = mountJsWithDom(readFileSync(join(assets, bundle!), 'utf8'));

    expect(String(body)).toBe(
      '<body><div><b>*new</b><p>page</p><ul>new</ul></div><i>mine</i></body>',
    );
    body.find('p').click();
    expect(String(body)).toBe('<body><div><b>*new</b><ul>new</ul></div><i>mine</i></body>');
  });
});

describe('generated code', () => {
  it('exports the names the decorator uses and imports them where it is applied', () => {
    const dir = project({
      'counter.rk': counter,
      'main.rk': `import { counter, badge } from "./counter.rk"\n${clicker()}`,
    });
    const exporter = compileIn(dir, 'counter.rk');
    const user = compileIn(dir, 'main.rk');

    expect(exporter.diagnostics).toEqual([]);
    expect(exporter.code).toContain('export { STEP as $$counter$STEP, log as $$counter$log };');
    expect(user.diagnostics).toEqual([]);
    expect(user.code).toMatch(
      /^import \{ \$\$counter\$STEP, \$\$counter\$log \} from "\.\/counter\.js";$/m,
    );
    expect(user.code).toContain('    $$counter$count += $$counter$STEP;\n');
    // The types of the decorator's code come from its module: the text is a text node.
    expect(user.code).toContain('document.createTextNode($$counter$count)');
  });
});

describe('running', () => {
  it('works when Vite bundles the modules', async () => {
    const dir = project({
      'index.html': '<script type="module" src="./main.rk"></script>',
      'counter.rk': counter,
      'main.rk': `import { counter, badge } from "./counter.rk"\n${clicker()}`,
    });

    await build({
      configFile: false,
      root: dir,
      logLevel: 'silent',
      plugins: [rook()],
      build: { outDir: join(dir, 'dist'), minify: false, modulePreload: { polyfill: false } },
    });

    const assets = join(dir, 'dist', 'assets');
    const [bundle] = readdirSync(assets).filter((name) => name.endsWith('.js'));
    const { body, output } = mountJsWithDom(readFileSync(join(assets, bundle!), 'utf8'));

    body.find('button').click();
    expect(String(body)).toBe('<body><div><button>+</button><span>6</span></div></body>');
    expect(output).toEqual(['add']);
  });
});
