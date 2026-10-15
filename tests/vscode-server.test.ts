import { describe, expect, it } from 'vitest';
import { CompletionItemKind, DiagnosticSeverity } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { toCompletionItems, toDiagnostics } from '../editors/vscode/src/convert.mts';
import { compile, complete } from '../src/index.ts';

// The language server of the VS Code extension: what it sends for the results of the compiler.

function document(text: string): TextDocument {
  return TextDocument.create('file:///app.mango', 'mangoscript', 1, text);
}

describe('language server', () => {
  it('sends errors and warnings with their lines and columns', () => {
    const text = 'let a = 1\nlet b string = a\n';
    const [error] = toDiagnostics(document(text), compile(text));

    expect(error).toEqual({
      message: 'cannot use number as string',
      severity: DiagnosticSeverity.Error,
      source: 'mango',
      range: { start: { line: 1, character: 15 }, end: { line: 1, character: 16 } },
    });

    const warnings = toDiagnostics(document(text), {
      code: '',
      diagnostics: [],
      warnings: [{ message: 'unused', start: 0, end: 3 }],
      dependencies: [],
    });

    expect(warnings[0]?.severity).toBe(DiagnosticSeverity.Warning);
  });

  it('sends completion items that replace the name being typed, in the order of the compiler', () => {
    const text = 'let total = 1\nconsole.log(to)';
    const [item] = toCompletionItems(document(text), complete(text, text.length - 1));

    expect(item).toEqual({
      label: 'total',
      kind: CompletionItemKind.Variable,
      detail: 'number',
      sortText: '00000',
      textEdit: {
        range: { start: { line: 1, character: 12 }, end: { line: 1, character: 14 } },
        newText: 'total',
      },
    });
  });
});
