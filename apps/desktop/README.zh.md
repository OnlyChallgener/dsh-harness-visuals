# DeepSeek Harness 桌面端

[English](README.md) | 中文

DeepSeek Harness 桌面端是一个 Windows Electron 应用。它在本机运行已发布的 `@deepseek-ai/dsh` Web UI，并在原生窗口中显示。

## 开发运行

请先安装 Node.js `^22.19.0` 或 `>=24.0.0`。然后在仓库根目录安装依赖并启动桌面端：

```sh
pnpm install
pnpm --filter @deepseek-ai/dsh-desktop dev
```

应用会把 Harness 的会话和设置保存到 Electron 的用户数据目录，不会写入仓库。它使用系统 Node.js 运行时以及锁定并嵌入安装包的 Harness npm 运行时。打包时会把工作区构建出的 `@deepseek-ai/dsh-host-apiproxy` bundle 覆盖到该运行时中，因此 Host 侧的准入行为会随安装程序一起发布。打开应用后，在 Harness 设置中配置 DeepSeek API Key。

剪贴板操作会优先使用浏览器 API，并在失败时回退到预加载桥。Windows 原生文字写入会通过标准输入把 Unicode 内容传给系统剪贴板工具；图片写入会先清除陈旧格式，并且仅在 Electron 能回读图片后报告成功。主进程还提供原生的剪切、复制、粘贴和全选右键菜单。

## 打包 Windows 安装程序

```sh
pnpm --filter @deepseek-ai/dsh-desktop dist:win
```

完整命令会先构建整个工作区。工作区构建和针对性测试已是最新状态时，可使用 `pnpm --filter @deepseek-ai/dsh-desktop dist:win:fast`，仅同步嵌入运行时并封装，避免重新构建每个工作区包。NSIS 安装程序输出到 `apps/desktop/dist-win/`。

嵌入的 `runtime/node_modules` 树使用独立的 Electron Builder 资源集，因为通用资源集会排除名为 `node_modules` 的根目录。Windows 包只保留 x64 终端二进制，并使用 ZIP 压缩，在避免生成未压缩大包的同时限制封装耗时。`afterPack` 检查会拒绝任何缺少 `resources/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js` 的暂存应用。
