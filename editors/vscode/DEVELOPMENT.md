# Developing the Rook extension for VS Code

**English** · [Русский](DEVELOPMENT.ru.md)

How to build the extension from this repository and work on it. What it does for its users is in
[README.md](README.md).

## Building from source

From the root of the repository:

```sh
npm run vscode:install
```

The command bundles the client and the language server with the compiler into
`editors/vscode/dist` (`npm run vscode:build`), packs `editors/vscode/rooklang.vsix` and installs
it with `code`. After changes to the grammar or the compiler, run it again and reload the VS Code
window.

For working on the extension, a window with it loaded straight from this folder is handier; build it
first:

```sh
npm run vscode:build
code --extensionDevelopmentPath="$PWD/editors/vscode"
```

The sources of the extension are in `src/`: `extension.mts` starts the server, `server.mts` answers
VS Code, and completion itself is in the compiler (`src/completion.ts` and the last layer of the
checker, `src/checker/completion.ts`). They are tested in `tests/completion.test.ts` and
`tests/vscode-server.test.ts`.

The grammar is checked by the tests in `tests/vscode-grammar.test.ts` with the same engine that VS
Code uses (`vscode-textmate`). The scopes under the cursor are shown by the command
"Developer: Inspect Editor Tokens and Scopes".

## Publishing

A new `version` in `package.json` on `main` publishes the extension:
[.github/workflows/vscode.yml](../../.github/workflows/vscode.yml) checks the repository, packs
`rooklang.vsix` and publishes it to each store that does not have this version yet, then tags the
commit `vscode-v0.1.1`. If one store fails, running the workflow again (Actions → VS Code extension
→ Run workflow) publishes to that store only. The Marketplace is skipped until `AZURE_CLIENT_ID`
is set.

Open VSX trusts the workflow itself (trusted publishing): on [open-vsx.org](https://open-vsx.org),
under Settings → Trusted Publishers, the namespace `Qwern9876r` registers GitHub Actions with the
owner `QWERN-9876r`, the repository `RookLang` and the workflow `vscode.yml`. Only an owner of the
namespace can do it, and Open VSX makes one of its creator when it approves the claim of the
namespace. Until then the workflow publishes with a token from Settings → Access Tokens in the
secret `OVSX_PAT` of the repository (Settings → Secrets and variables → Actions); once the workflow
is registered, the secret is deleted, since a token takes precedence over trusted publishing.

The Marketplace no longer takes Azure DevOps tokens. It trusts a managed identity of Azure, and the
workflow signs in as it with GitHub's OIDC token, so the repository keeps no secret for it. Set up
once:

1. In the [Azure portal](https://portal.azure.com), with the Microsoft account of the publisher,
   create a user-assigned managed identity (Managed Identities → Create) in any resource group.
2. In the identity, under Settings → Federated credentials → Add credential, choose "GitHub Actions
   deploying Azure resources": organization `QWERN-9876r`, repository `RookLang`, entity Branch,
   branch `main`.
3. Put the Client ID and the Tenant ID of the identity (its Overview) into the variables
   `AZURE_CLIENT_ID` and `AZURE_TENANT_ID` of the repository (Settings → Secrets and variables →
   Actions → Variables).
4. Run the workflow by hand with "Only print the Azure DevOps id" checked. It prints the profile of
   the identity in Azure DevOps; copy its `id`.
5. On the [publisher's page](https://marketplace.visualstudio.com/manage/publishers/qwern9876r)
   of the Marketplace, under Members, add that id with the role Contributor.

By hand, a `.vsix` from `npm run vscode:package` can be uploaded on the same page of the
Marketplace, and `npx ovsx publish rooklang.vsix -p <token>` publishes it to Open VSX.
