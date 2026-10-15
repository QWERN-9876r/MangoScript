import {
  CompletionItemKind,
  DiagnosticSeverity,
  type CompletionItem,
  type Diagnostic,
} from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { CompileResult, Completion, CompletionList } from '../../../src/index.ts';

// What the compiler gives, as the language server protocol wants it: offsets become positions.

export function toDiagnostics(document: TextDocument, result: CompileResult): Diagnostic[] {
  const convert = (
    { message, start, end }: CompileResult['diagnostics'][number],
    severity: DiagnosticSeverity,
  ): Diagnostic => ({
    message,
    severity,
    source: 'mango',
    range: { start: document.positionAt(start), end: document.positionAt(end) },
  });

  return [
    ...result.diagnostics.map((each) => convert(each, DiagnosticSeverity.Error)),
    ...result.warnings.map((each) => convert(each, DiagnosticSeverity.Warning)),
  ];
}

const KINDS: Record<Completion['kind'], CompletionItemKind> = {
  variable: CompletionItemKind.Variable,
  constant: CompletionItemKind.Constant,
  function: CompletionItemKind.Function,
  class: CompletionItemKind.Class,
  component: CompletionItemKind.Class,
  type: CompletionItemKind.Interface,
  property: CompletionItemKind.Property,
  method: CompletionItemKind.Method,
  keyword: CompletionItemKind.Keyword,
  tag: CompletionItemKind.Property,
  attribute: CompletionItemKind.Value,
};

export function toCompletionItems(document: TextDocument, list: CompletionList): CompletionItem[] {
  const range = { start: document.positionAt(list.start), end: document.positionAt(list.end) };

  // The compiler lists the nearest names first; VS Code keeps that order among equal matches.
  return list.items.map((item, index) => ({
    label: item.name,
    kind: KINDS[item.kind],
    ...(item.detail === undefined ? {} : { detail: item.detail }),
    sortText: String(index).padStart(5, '0'),
    textEdit: { range, newText: item.name },
  }));
}
