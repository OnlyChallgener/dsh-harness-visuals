# Agent Note: Desktop shell for the DeepSeek Harness Web UI

Status: implemented

English | [中文](2026-08-14-desktop-shell.zh.md)

## Problem

The Harness Web UI requires a browser tab and a manually managed local server. Desktop users need a native entry point without changing the Web UI's API, persistence model, or security posture.

## Decision

`apps/desktop/` provides a Windows Electron application that starts the published `@deepseek-ai/dsh` CLI with a loopback-only ephemeral port and loads the announced URL in one isolated BrowserWindow. The shell stores `DSH_HOME` below Electron's user-data directory, so its sessions and settings remain separate from a source checkout. It validates the selected system Node.js runtime before boot and uses a small launcher process that reports the ready URL over process IPC, requests the CLI's existing bounded disposal during shutdown, and falls back to process-tree termination. The runtime manifests and `runtime/node_modules` use separate Electron Builder resource sets: the dependency set points directly at `runtime/node_modules` so Electron Builder cannot discard it as a root `node_modules` directory. Windows packages retain only x64 terminal binaries and use ZIP compression. An `afterPack` hook rejects staged applications without the published CLI entry at `resources/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js`.

The main process owns the child server. Closing the window hides it to the system tray, and the tray can reopen the window, restart the server, open the private data directory, or quit the application. The Windows window uses a hidden title bar with native window controls overlaid on the page; a shell-owned, top-edge drag region does not depend on Web UI selectors. The preload bridge exposes only the shell operations used by the page: lifecycle and startup diagnostics, opening the local URL or private data directory, image and text clipboard writes, image save, and Windows OCR. Clipboard actions prefer the browser API and fall back to the bridge. Windows text writes send Unicode content to the system clipboard utility over standard input, while image writes clear stale formats and report success only after a native readback. The main process supplies native cut, copy, paste, and select-all context menus for editable fields and selected text. The shell persists the normal window bounds and maximized state.

## Alternatives considered

**A new desktop UI.** Rejected because the existing Web UI owns the product interaction model and browser API; a second UI would duplicate it and diverge from Harness features.

**A fixed port.** Rejected because a hard-coded port conflicts with existing local services. The shell starts `dsh web --port 0` and consumes the runtime's announced URL.

**Binding to the LAN.** Rejected because the desktop shell is a local application. It explicitly binds `127.0.0.1`, retaining the CLI's local-only safety posture.

## Consequences

The installed application includes Electron, the published Harness production dependency tree required on Windows x64, and the official whale icon resource, while core Harness changes ship independently through the npm package. Omitting a required runtime dependency produces an invalid package and fails during `afterPack`. The desktop package targets Windows NSIS installers and needs a new release when it should pick up a newer published Harness version. The runtime remains dependent on a supported system Node.js installation; a failed preflight produces an actionable startup page instead of a delayed process error.
