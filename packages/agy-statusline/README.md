# agy-statusline

面向 **Antigravity App (2.0+)** 与 **Antigravity CLI (`agy`)** 的统一实时遥测与配额常驻状态栏插件（`v0.1.3`），单文件零外部运行时依赖（仅需 Node.js `>= 22.13.0` 原生 `node:sqlite` 与全局 `WebSocket`），双端共享同一份 SQLite 解析逻辑与配额缓存（`~/.cache/agy-statusline/quota_cache.json`）。

---

## 核心特性

### 1. Antigravity App 外置底栏与悬停仪表盘
- **外置挂载**：独立全宽挂载在输入框 `[id="antigravity.agentSidePanelInputBox"]` 外框正下方，不挤占模型选择器空间。
- **左侧会话遥测**：
  - 活跃会话：`Ctx XX% 62k/512k · Cache XX% · XX tok/s · TTFT X.Xs · Out XXX`（存在子 Agent 时追加 `+N sub`）。
  - 首页 / 空会话：保持完整指标骨架（`Ctx 0% · Cache -- · -- tok/s`）。
- **右侧配额窗口**：实时监听输入框模型选择器，按模型池（`Gemini` / `Claude · 3P` / `Argon`）自动路由并展示 `5h / 7d` 已用比例与重置倒计时。
- **现代仪表盘悬停卡**：鼠标悬停自动避让视口上下边界展开，展示上下文压缩水位进度条、2×2 KPI 指标网格（生成速率、响应延迟、单步缓存、本步输出）、多步与子 Agent 汇总及双栏配额进度卡。
- **热更新与冷启动接力**：后台守护进程自动为冷启动且未携带 `--remote-debugging-port=0` 的 App 补参接力；CDP 通道就绪后，样式调整或版本升级自动秒级热更新生效，无需重启 App。

### 2. Antigravity CLI `/statusline`
- **终端单行格式**：`4 Carbon Med │ main │ Ctx 16% · Cache 97% · 85 tok/s · 5h 22% 2h15m · 7d 45% 4d08h · +2 sub`。
- **宽度自适应与双向同步**：根据终端列宽多级渐进裁剪并保持 ANSI 动态配色；解析本地 CLI SQLite 库补全速度与命中率，并将 `stdin` 实时配额回写至共享缓存供 App 秒读。

---

## 指标颜色阈值规范

| 指标 | 绿色 (`good`) | 青色 (`info`) | 黄色 (`mid`) | 橙色 (`warn`) | 红色 (`crit`) |
| --- | --- | --- | --- | --- | --- |
| `Ctx%` / `5h` / `7d`（已用率） | `< 50%` | — | `50% ~ 74%` | `75% ~ 89%` | `>= 90%` |
| `Cache%`（缓存命中率） | `>= 80%` | `40% ~ 79%` | — | `< 40%` | — |
| `tok/s`（生成速率） | `40 ~ 99` | `>= 100` | `1 ~ 39` | — | — |
| `TTFT / Hold`（首字/等待延迟） | `<= 2.5s` | — | `2.5s ~ 6s` | `> 6s` | — |

---

## 安装与使用

```sh
# 在插件目录（packages/agy-statusline 或已安装目录 ~/.gemini/config/plugins/agy-statusline）执行：
# 若在源码仓库中首次运行，请先在仓库根目录执行 `npm run build`

# 1. 安装插件、写入 CLI settings.json 与启动 App 后台守护进程
node dist/agy-statusline.mjs install

# 2. 检查运行环境、双端接线、CDP 状态、守护进程与缓存配额
node dist/agy-statusline.mjs doctor

# 3. 手动刷新 5h / 7d 配额缓存
node dist/agy-statusline.mjs quota refresh

# 4. 若运行中的 App 未开启 CDP 调试端口（missing_opt_in_flag），在外部终端平滑重启
node dist/agy-statusline.mjs relaunch

# 5. 彻底卸载插件、自启服务及 CLI 配置项
node dist/agy-statusline.mjs uninstall
```

---

## 个人配置（`~/.config/agy-statusline/config.json`）

```json
{
  "enabled": true,
  "channel": "auto",
  "cacheRateMode": "last",
  "contextLimit": 256000,
  "contextLimitOverride": 0,
  "cli": {
    "showModel": true,
    "showGitBranch": true,
    "color": true
  },
  "app": {
    "enabled": true,
    "cdpAutoRelaunch": true
  }
}
```

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 插件总开关 |
| `channel` | `"auto"` | App 探测通道：`"auto"` / `"stable"` / `"insiders"` |
| `cacheRateMode` | `"last"` | 常驻行 `Cache%` 口径：`"last"`（最新一步）或 `"session"`（会话累计） |
| `contextLimit` | `256000` | 数据库未上报模型真实 `maxCtx` 时的兜底上下文上限（Token） |
| `contextLimitOverride` | `0` | 设为 `> 0` 时强制覆盖所有会话的上下文上限分母（可用于提前压缩预警） |
| `cli.showModel` | `true` | CLI 状态栏是否显示模型简称前缀 |
| `cli.showGitBranch` | `true` | CLI 状态栏是否显示当前 Git 分支 |
| `cli.color` | `true` | CLI 是否启用 ANSI 动态分级配色 |
| `app.enabled` | `true` | 是否启用 Antigravity App 底栏注入 |
| `app.cdpAutoRelaunch` | `true` | 后台守护进程是否对冷启动且未带调试参数的 App 自动接力补参 |
