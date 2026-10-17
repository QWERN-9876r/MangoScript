import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { build } from 'vite';

// Builds the VS Code extension: the client and the language server, each bundled with the
// compiler into one CommonJS file of editors/vscode/dist. TypeScript is not bundled: the compiler
// loads it when it needs the types of the DOM and of `.d.ts` files, and it reads its lib files
// from its own folder, so it is copied there as a package.

const root = new URL('..', import.meta.url).pathname;
const extension = join(root, 'editors/vscode');
const out = join(extension, 'dist');

await build({
  configFile: false,
  root,
  logLevel: 'warn',
  build: {
    ssr: true,
    outDir: out,
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    rolldownOptions: {
      input: {
        extension: join(extension, 'src/extension.mts'),
        server: join(extension, 'src/server.mts'),
      },
      external: ['vscode', 'typescript'],
      output: { format: 'cjs', entryFileNames: '[name].js' },
    },
  },
  ssr: { noExternal: true, target: 'node' },
});

// The compiler and the lib files of TypeScript, without its language service and translations.
const typescript = dirname(createRequire(import.meta.url).resolve('typescript/package.json'));
const target = join(out, 'node_modules/typescript');

mkdirSync(join(target, 'lib'), { recursive: true });
cpSync(join(typescript, 'package.json'), join(target, 'package.json'));
for (const file of readdirSync(join(typescript, 'lib'))) {
  if (file === 'typescript.js' || /^lib\..*\.d\.ts$/.test(file)) {
    cpSync(join(typescript, 'lib', file), join(target, 'lib', file));
  }
}

// The Marketplace shows the license of the package, and it is the one of the repository.
cpSync(join(root, 'LICENSE'), join(extension, 'LICENSE'));
