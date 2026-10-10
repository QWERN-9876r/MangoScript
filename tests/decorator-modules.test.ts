import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/index.ts';
import { mango } from '../src/vite.ts';
import { mountJsWithDom } from './fake-dom.ts';

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
  const dir = mkdtempSync(join(tmpdir(), 'mango-dec-'));

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
    `import { ${imports} } from "./counter.mango"\n${clicker(decorators, body)}`;

  it('applies imported decorators with their members and wrappers', () => {
    expect(errorsIn({ 'counter.mango': counter, 'main.mango': main() }, 'main.mango')).toEqual([]);
    // The names of the decorator's module do not clash with the component's.
    expect(
      errorsIn(
        { 'counter.mango': counter, 'main.mango': main(undefined, '\n    const log = 1') },
        'main.mango',
      ),
    ).toEqual([]);
  });

  it('reports wrong imports and uses', () => {
    const errors = (text: string) =>
      errorsIn({ 'counter.mango': counter, 'main.mango': text }, 'main.mango');

    expect(errors(main(undefined, '', 'counter as c, badge'))).toEqual([
      'renaming decorators is not supported yet: import { counter }',
    ]);
    expect(errors(main('@badge', '', 'badge'))).toEqual([
      '@badge needs @counter above it: @counter @badge comp ...',
      'unknown decorator @counter',
    ]);
    // Global names are not renamed, so the component must not hide them.
    expect(
      errorsIn(
        {
          'greet.mango': 'export dec greet() {\n    console.log("hi")\n}\n',
          'main.mango': `import { greet } from "./greet.mango"\n@greet\ncomp A() {\n    const console = 1\n    return <p />\n}`,
        },
        'main.mango',
      ),
    ).toEqual([
      '@greet uses "console" of the module, but A declares its own "console": rename one of them',
    ]);
    expect(
      errorsIn(
        { 'a.mango': 'dec hidden() {\n}\n', 'main.mango': 'import { hidden } from "./a.mango"' },
        'main.mango',
      ),
    ).toEqual(['"hidden" is not exported by "./a.mango"']);
  });

  it('checks that an exported decorator works in other modules', () => {
    const errors = (text: string) => errorsIn({ 'a.mango': text }, 'a.mango');

    expect(errors('dec a() {\n}\nexport dec b() needs a {\n}')).toEqual([
      '@b is exported, so @a that it needs must be exported too: export dec a(...)',
    ]);
    expect(errors('let total = 0\nexport dec a() {\n    total++\n}')).toEqual([
      '@a is exported, so it cannot change "total" of its module: other modules can only read it; change it in a function of the module',
    ]);
    expect(
      errors(
        'comp Missing() {\n    return <p />\n}\nexport dec a() {\n    return (c Element) => <div>{c}<Missing /></div>\n}',
      ),
    ).toEqual([
      '@a is exported, so it cannot use the component Missing: components in decorators of other modules are not supported yet',
    ]);
  });
});

describe('generated code', () => {
  it('exports the names the decorator uses and imports them where it is applied', () => {
    const dir = project({
      'counter.mango': counter,
      'main.mango': `import { counter, badge } from "./counter.mango"\n${clicker()}`,
    });
    const exporter = compileIn(dir, 'counter.mango');
    const user = compileIn(dir, 'main.mango');

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
      'index.html': '<script type="module" src="./main.mango"></script>',
      'counter.mango': counter,
      'main.mango': `import { counter, badge } from "./counter.mango"\n${clicker()}`,
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

    body.find('button').click();
    expect(String(body)).toBe('<body><div><button>+</button><span>6</span></div></body>');
    expect(output).toEqual(['add']);
  });
});
