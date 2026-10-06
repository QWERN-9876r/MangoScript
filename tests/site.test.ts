import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { build } from '../src/build.ts';

// The test site (site/) is a real MangoScript program: building it checks the compiler on real
// code, and its model can be run without a browser.

const site = (path: string) => new URL(`../site/${path}`, import.meta.url).pathname;

interface Todo {
  id: number;
  title: string;
  done: boolean;
}

interface TodoList {
  add(title: string): Todo;
  toggle(id: number): void;
  remove(id: number): void;
  clearDone(): void;
  visible(filter: string): Todo[];
  counts(): [number, number];
}

interface TodosModule {
  parseTitle: (input: string) => [string, Error | null];
  TodoList: new (items: Todo[]) => TodoList;
}

describe('test site', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'mango-site-'));
  const result = build([site('src'), site('server.mango')], { outDir });

  it('compiles without errors', () => {
    expect(result.errors.flatMap((error) => error.diagnostics)).toEqual([]);
    expect(result.outputs.map((output) => output.output.slice(outDir.length + 1)).sort()).toEqual([
      'server.js',
      'src/app.js',
      'src/storage.js',
      'src/todos.js',
    ]);
  });

  it('runs the todo list model', async () => {
    for (const { output, code } of result.outputs) {
      mkdirSync(join(output, '..'), { recursive: true });
      writeFileSync(output, code);
    }
    const { parseTitle, TodoList } = (await import(
      pathToFileURL(join(outDir, 'src/todos.js')).href
    )) as TodosModule;

    expect(parseTitle('  milk  ')).toEqual(['milk', null]);
    expect(parseTitle('   ')[1]?.message).toBe('Сначала напишите задачу');

    const todos = new TodoList([{ id: 7, title: 'saved', done: false }]);
    expect(todos.add('new').id).toBe(8);
    todos.toggle(7);
    expect(todos.visible('done').map((todo) => todo.title)).toEqual(['saved']);
    expect(todos.visible('active').map((todo) => todo.title)).toEqual(['new']);
    expect(todos.counts()).toEqual([1, 1]);
    todos.clearDone();
    expect(todos.visible('all').map((todo) => todo.title)).toEqual(['new']);
  });
});
