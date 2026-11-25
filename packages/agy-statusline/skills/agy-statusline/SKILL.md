---
name: agy-statusline
description: Manage, diagnose, install, inspect, and refresh the unified Antigravity App, IDE, and CLI statusline (`agy-statusline`) showing Ctx% breakdown, Cache%, TPS, and 5h/7d quota.
---

# agy-statusline 操作指南

`agy-statusline` 为 Antigravity App、Antigravity IDE / VS Code 与 CLI 提供统一实时遥测、精细上下文窗口拆分与配额状态栏，核心可执行入口位于插件目录 `dist/agy-statusline.mjs`，IDE 扩展位于 `ide/dist/extension.cjs`。

## 常用命令

1. **检查三端健康状态**：
   ```sh
   node ~/.gemini/config/plugins/agy-statusline/dist/agy-statusline.mjs doctor --json
   ```
2. **安装或修复三端接线**（同步插件、安装 Antigravity IDE / VS Code 扩展、写入 `~/.gemini/antigravity-cli/settings.json` 的 `statusLine`、注册并启动 App CDP 守护进程）：
   ```sh
   node ~/.gemini/config/plugins/agy-statusline/dist/agy-statusline.mjs install
   ```
3. **查看当前工作区会话的精细上下文拆分**：
   ```sh
   node ~/.gemini/config/plugins/agy-statusline/dist/agy-statusline.mjs inspect
   ```
4. **手动刷新 5h/7d 配额缓存**：
   ```sh
   node ~/.gemini/config/plugins/agy-statusline/dist/agy-statusline.mjs quota refresh
   ```
5. **若 App 处于 `missing_opt_in_flag`（未开启 CDP 调试端口）**：
   - 如果当前正在 Antigravity App 会话内执行，**切勿直接带 `--force` 重启自断对话**，请提示用户在空闲时手动重启 App，或在外部终端运行：
     ```sh
     node ~/.gemini/config/plugins/agy-statusline/dist/agy-statusline.mjs relaunch
     ```
6. **卸载清理**：
   ```sh
   node ~/.gemini/config/plugins/agy-statusline/dist/agy-statusline.mjs uninstall
   ```

## 用户配置文件路径

- 个人配置：`~/.config/agy-statusline/config.json`（支持调整 `cacheRateMode: "last" | "session"`、`cli.*`、`app.*`、`ide.enabled`、`ide.alignment: "left" | "right"`）
- 共享配额缓存：`~/.cache/agy-statusline/quota_cache.json`
