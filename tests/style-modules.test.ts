import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile as compileInBrowser } from '../src/browser.ts';
import { compile } from '../src/index.ts';
import { styleModule } from '../src/style-modules.ts';
import { mountJsWithDom } from './fake-dom.ts';

// CSS modules: `import styles from "./button.module.css"`. The compiler reads the file, gives its
// classes names of their own and types `styles` with them; the module adds the CSS to the page.

const css = `:root { --accent: #e07b00; }
.button { padding: 6px 14px; }
.primary { background: var(--accent); }
.ghost:hover, :global(.dark) .ghost { background: none; }
.is-active { outline: 2px solid; }
@keyframes pop { from { scale: 0.9 } to { scale: 1 } }
`;

const button = `import styles from "./button.module.css"

type Kind "primary" | "ghost"

comp Button(kind Kind = "primary", active bool = false, children Content) {
    return <button class={\`\${styles.button} \${styles[kind]} \${active ? styles["is-active"] : ""}\`}>
        {children}
    </button>
}

document.body.append(<Button kind="ghost" active>Hi</Button>)
`;

/** Compiles `main` in a directory with button.module.css. */
function compileWithCss(main: string, files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mango-css-'));

  writeFileSync(join(dir, 'button.module.css'), css);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  writeFileSync(join(dir, 'main.mango'), main);

  return { dir, ...compile(main, { filename: join(dir, 'main.mango') }) };
}

describe('CSS', () => {
  it('names the classes of the module and keeps the rest global', () => {
    const module = styleModule(css);
    const suffix = `_${module.id}`;

    expect([...module.classes]).toEqual(
      ['button', 'primary', 'ghost', 'is-active'].map((name) => [name, `${name}${suffix}`]),
    );
    expect(module.css).toContain(':root {\n  --accent: #e07b00;\n}');
    expect(module.css).toContain(`.ghost${suffix}:hover, .dark .ghost${suffix} {`);
    expect(module.css).toContain('@keyframes pop {\n  from {');
  });
});

describe('types', () => {
  it('types the classes, also by a literal key', () => {
    expect(compileWithCss(button).diagnostics).toEqual([]);
    expect(
      compileWithCss(
        'import styles from "./button.module.css"\nconst c = styles.buton',
      ).diagnostics.map((d) => d.message),
    ).toEqual(['button.module.css has no member "buton"']);
  });

  it('warns about classes that the module never names', () => {
    const { warnings } = compileWithCss(
      'import styles from "./button.module.css"\ndocument.body.append(<p class={styles.button} />)',
    );

    expect(warnings.map((d) => d.message)).toEqual([
      'class "primary" of ./button.module.css is never used',
      'class "ghost" of ./button.module.css is never used',
      'class "is-active" of ./button.module.css is never used',
    ]);
    // `styles[kind]` may name any of them.
    expect(compileWithCss(button).warnings).toEqual([]);
  });

  it('reports a missing file, and CSS modules in the browser compiler', () => {
    expect(
      compileWithCss('import styles from "./card.module.css"').diagnostics.map((d) => d.message),
    ).toEqual(['cannot read the CSS module "./card.module.css"']);
    expect(
      compileInBrowser('import styles from "./card.module.css"').diagnostics.map((d) => d.message),
    ).toEqual(['CSS modules need files: build the program with mango build or Vite']);
  });
});

describe('generated code', () => {
  it('turns the import into the object of the classes and adds the CSS', () => {
    const { code, dependencies } = compileWithCss(button);
    const { id } = styleModule(css);

    expect(code).not.toContain('import ');
    expect(code).toContain(
      `const styles = { button: "button_${id}", primary: "primary_${id}", ghost: "ghost_${id}", "is-active": "is-active_${id}" };`,
    );
    expect(code).toContain(`$$style("mango-module-${id}", \`:root {`);
    expect(dependencies).toEqual(['./button.module.css']);
  });

  it('gives the elements the classes of the module', () => {
    const { code } = compileWithCss(button);
    const { body, head } = mountJsWithDom(code);
    const { id } = styleModule(css);

    expect(String(body.find('button').className)).toBe(`button_${id} ghost_${id} is-active_${id}`);
    expect(head.childNodes.map((style) => style.id)).toEqual([`mango-module-${id}`]);
  });

  it('builds with the CLI', () => {
    const { dir } = compileWithCss(button);
    const cli = new URL('../src/cli.ts', import.meta.url).pathname;
    const result = spawnSync(process.execPath, [cli, 'build', 'main.mango'], {
      cwd: dir,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(readFileSync(join(dir, 'main.js'), 'utf8')).toContain('const styles = {');
  });
});
