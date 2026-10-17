# Разработка расширения Rook для VS Code

[English](DEVELOPMENT.md) · **Русский**

Как собрать расширение из этого репозитория и работать над ним. Что оно даёт пользователям — в
[README.ru.md](README.ru.md).

## Сборка из исходников

Из корня репозитория:

```sh
npm run vscode:install
```

Команда собирает клиент и языковой сервер вместе с компилятором в `editors/vscode/dist`
(`npm run vscode:build`), упаковывает `editors/vscode/rooklang.vsix` и устанавливает его через
`code`. После изменений в грамматике или компиляторе её нужно запустить снова и перезагрузить окно
VS Code.

Для разработки расширения удобнее окно, в котором оно загружено прямо из этой папки; сначала его
нужно собрать:

```sh
npm run vscode:build
code --extensionDevelopmentPath="$PWD/editors/vscode"
```

Исходники расширения лежат в `src/`: `extension.mts` запускает сервер, `server.mts` отвечает VS
Code, а само автодополнение — в компиляторе (`src/completion.ts` и последний слой проверки типов,
`src/checker/completion.ts`). Их проверяют `tests/completion.test.ts` и
`tests/vscode-server.test.ts`.

Грамматика проверяется тестами в `tests/vscode-grammar.test.ts` тем же движком, что использует VS
Code (`vscode-textmate`). Посмотреть области под курсором можно командой «Developer: Inspect Editor
Tokens and Scopes».

## Публикация

Новая `version` в `package.json` в `main` публикует расширение:
[.github/workflows/vscode.yml](../../.github/workflows/vscode.yml) проверяет репозиторий,
упаковывает `rooklang.vsix` и публикует его в каждый магазин, где этой версии ещё нет, а потом
ставит на коммит тег `vscode-v0.1.1`. Если один магазин не принял пакет, повторный запуск workflow
(Actions → VS Code extension → Run workflow) опубликует только в него. Marketplace пропускается,
пока не задана `AZURE_CLIENT_ID`.

Open VSX доверяет самому workflow (trusted publishing): на [open-vsx.org](https://open-vsx.org), в
Settings → Trusted Publishers, пространство имён `Qwern9876r` регистрирует GitHub Actions с
владельцем `QWERN-9876r`, репозиторием `RookLang` и workflow `vscode.yml`. Сделать это может только
владелец пространства имён, а им Open VSX делает создателя, когда одобряет заявку на пространство
имён. До тех пор workflow публикует с токеном из Settings → Access Tokens в секрете `OVSX_PAT`
репозитория (Settings → Secrets and variables → Actions); когда workflow зарегистрирован, секрет
удаляют, потому что токен важнее trusted publishing.

Marketplace больше не принимает токены Azure DevOps. Он доверяет управляемой идентичности Azure, и
workflow входит под ней с OIDC-токеном GitHub, так что секрета для него в репозитории нет.
Настраивается один раз:

1. В [портале Azure](https://portal.azure.com) под аккаунтом Microsoft издателя создайте
   user-assigned managed identity (Managed Identities → Create) в любой группе ресурсов.
2. В идентичности, в Settings → Federated credentials → Add credential, выберите «GitHub Actions
   deploying Azure resources»: организация `QWERN-9876r`, репозиторий `RookLang`, entity Branch,
   ветка `main`.
3. Client ID и Tenant ID идентичности (на её странице Overview) положите в переменные
   `AZURE_CLIENT_ID` и `AZURE_TENANT_ID` репозитория (Settings → Secrets and variables → Actions →
   Variables).
4. Запустите workflow вручную с галочкой «Only print the Azure DevOps id». Он выведет профиль
   идентичности в Azure DevOps; скопируйте его `id`.
5. На [странице издателя](https://marketplace.visualstudio.com/manage/publishers/qwern9876r) в
   Marketplace, в Members, добавьте этот id с ролью Contributor.

Вручную `.vsix` из `npm run vscode:package` можно загрузить на той же странице Marketplace, а
`npx ovsx publish rooklang.vsix -p <токен>` опубликует его в Open VSX.
