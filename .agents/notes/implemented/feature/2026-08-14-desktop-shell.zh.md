# Agent Note: DeepSeek Harness Web UI 的桌面外壳

Status: implemented

English | [英文](2026-08-14-desktop-shell.md)

## Problem

Harness Web UI 需要浏览器标签页和手动管理的本地服务。桌面用户需要一个原生入口，同时不改变 Web UI 的 API、持久化模型或安全姿态。

## Decision

`apps/desktop/` 提供一个 Windows Electron 应用：它通过仅回环地址的临时端口启动已发布的 `@deepseek-ai/dsh` CLI，并在一个隔离的 BrowserWindow 中加载其宣布的 URL。该外壳把 `DSH_HOME` 保存到 Electron 用户数据目录下，因此会话和设置与源码检出目录分离。启动前会检查选定的系统 Node.js 运行时，并通过一个小型启动器用进程 IPC 报告就绪 URL；关闭时优先请求 CLI 已有的有界资源释放，超时后才回退到进程树终止。运行时 manifest 与 `runtime/node_modules` 使用两个独立的 Electron Builder 资源集：依赖资源集直接指向 `runtime/node_modules`，使 Electron Builder 无法把它当作根 `node_modules` 目录丢弃。Windows 包只保留 x64 终端二进制，并使用 ZIP 压缩。`afterPack` 钩子会拒绝缺少已发布 CLI 入口 `resources/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js` 的暂存应用。

主进程拥有子服务。关闭窗口时应用会隐藏到系统托盘；托盘可重新打开窗口、重启服务、打开私有数据目录或退出应用。Windows 窗口隐藏标题栏，并将原生窗口按钮覆盖在页面上；桌面壳自有的顶部拖拽区域不依赖 Web UI 选择器。预加载桥只暴露页面需要的桌面壳操作：生命周期与启动诊断、打开本地 URL 或私有数据目录、图片和文字剪贴板写入、图片保存及 Windows OCR。剪贴板操作会优先使用浏览器 API，并在失败时回退到预加载桥。Windows 文字写入会通过标准输入把 Unicode 内容传给系统剪贴板工具；图片写入会先清除陈旧格式，并且仅在原生回读成功后报告成功。主进程为可编辑区域和已选文字提供原生剪切、复制、粘贴与全选右键菜单。桌面壳会保存普通窗口位置尺寸和最大化状态。

## Alternatives considered

**一个新的桌面 UI。** 未采用，因为现有 Web UI 拥有产品交互模型和浏览器 API；第二个 UI 会复制实现并与 Harness 功能产生偏差。

**固定端口。** 未采用，因为硬编码端口会和已有本地服务冲突。外壳使用 `dsh web --port 0` 并消费运行时宣布的 URL。

**绑定到局域网。** 未采用，因为桌面外壳是本地应用。它明确绑定 `127.0.0.1`，保留 CLI 的仅本地安全姿态。

## Consequences

安装后的应用包含 Electron、Windows x64 所需的 Harness 已发布生产依赖树和官方黑鲸鱼图标资源，核心 Harness 变更通过 npm 包独立交付。遗漏必需运行时依赖会生成无效包，并在 `afterPack` 阶段失败。桌面包面向 Windows NSIS 安装程序；需要获得更新后的已发布 Harness 版本时，应发布新的桌面包版本。运行时仍依赖受支持的系统 Node.js 安装；预检失败时会显示可操作的启动页，而不是等待进程错误超时。
