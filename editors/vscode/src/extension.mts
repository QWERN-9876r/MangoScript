import { join } from 'node:path';
import { workspace, type ExtensionContext } from 'vscode';
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from 'vscode-languageclient/node';

// The extension starts the language server (server.mts) for `.mango` files.

let client: LanguageClient | undefined;

export async function activate(context: ExtensionContext): Promise<void> {
  const module = context.asAbsolutePath(join('dist', 'server.js'));
  const serverOptions: ServerOptions = {
    run: { module, transport: TransportKind.ipc },
    // "Attach to Node Process" on port 6009 debugs the server.
    debug: { module, transport: TransportKind.ipc, options: { execArgv: ['--inspect=6009'] } },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ language: 'mangoscript' }],
    // Changes on disk of the modules and the CSS a file imports.
    synchronize: { fileEvents: workspace.createFileSystemWatcher('**/*.{mango,css}') },
  };

  client = new LanguageClient('mangoscript', 'MangoScript', serverOptions, clientOptions);
  await client.start();
}

export async function deactivate(): Promise<void> {
  await client?.stop();
}
