# DeepSeek Harness Desktop

English | [中文](README.zh.md)

DeepSeek Harness Desktop is a Windows Electron application that runs the published `@deepseek-ai/dsh` Web UI locally and displays it in a native window.

## Development

Install Node.js `^22.19.0` or `>=24.0.0`. From the repository root, install dependencies and start the desktop application:

```sh
pnpm install
pnpm --filter @deepseek-ai/dsh-desktop dev
```

The application stores Harness sessions and settings under its Electron user-data directory, not in the repository. It uses the system Node.js runtime and a pinned, embedded Harness npm runtime. Packaging overlays the workspace-built `@deepseek-ai/dsh-host-apiproxy` bundle into that runtime so Host-side admission behavior ships with the installer. Configure the DeepSeek API key in the app's Harness settings after it opens.

Clipboard actions prefer the browser API and fall back to the preload bridge. On Windows, native text writes pass Unicode content to the system clipboard utility over standard input; image writes clear stale formats and report success only after Electron can read an image back. The main process also provides native cut, copy, paste, and select-all context menus.

## Package for Windows

```sh
pnpm --filter @deepseek-ai/dsh-desktop dist:win
```

The complete command builds the workspace before packaging. After the workspace build and focused tests are current, use `pnpm --filter @deepseek-ai/dsh-desktop dist:win:fast` to synchronize the embedded runtime and package it without rebuilding every workspace package. The NSIS installer is written to `apps/desktop/dist-win/`.

The embedded `runtime/node_modules` tree is a dedicated Electron Builder resource set because a general resource set excludes a root directory named `node_modules`. Windows packages retain only the x64 terminal binaries and use ZIP compression to keep packaging time bounded without shipping an uncompressed installer. The `afterPack` check rejects any staged application that does not contain `resources/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js`.
