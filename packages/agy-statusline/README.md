# agy-statusline

面向 **Antigravity App (2.0+)**、**Antigravity IDE / VS Code** 与 **Antigravity CLI (`agy`)** 的三端统一实时遥测、精细上下文分析与模型配额常驻状态栏插件（`v0.3.0`）。零外部运行时依赖（基于 Node.js `>= 22.13.0` 原生 `node:sqlite` 与全局 `WebSocket`），三端共享同一份 SQLite 解析内核与配额缓存（`~/.cache/agy-statusline/quota_cache.json`）。

---

## 核心特性

### 1. 精细上下文窗口分析（SQLite 真实计数 + 本地懒加载扫描）
- **12 类真实 Token 细粒度拆分**：直接解码 SQLite `gen_metadata` 原生 `TokenBreakdown`，精确拆分「用户提问 / 模型回复（可展开正文回复与思考推理）/ 工具调用（可展开工具返回、调用参数与高占用调用 Top 榜）/ 系统提示词 / 内置工具定义 / MCP 工具定义 / MCP 服务指令 / 规则与记忆 / Skills 技能 / 子 Agent 与插件 / 系统消息 / 压缩缓冲」。
- **双视图切换与双向悬停联动**：支持「分段比例条形图（含 `85%` 自动压缩刻度线）」与「`100` 格比例矩阵网格（每格 `1%`）」一键切换，鼠标悬停在色块或分类行上双向联动高亮。
- **压缩节省与渐进懒加载统计**：自动识别会话 `CHECKPOINT` 及压缩落差（展示 `已压缩 N 次 · 省 Xk`），并扫描本地 `<appData>/mcp/`、`SKILL.md` 与按需规则统计「懒加载已省 Token（`0` 活跃占用）」。

### 2. Antigravity App 三级防重叠布局与交互式浮窗
- **自适应防重叠双区布局**：宽/中屏挂载于输入框工具栏右侧（`128 tok/s · Cache 96%/85% · ◐ 16% · TTFT 5.5s · Out 28k`），右下角独立展示 `5h / 7d` 配额；窄分栏通过 `ResizeObserver` 自动下沉至左下角防挤压。
- **Obsidian Prism 兼容与内存态配额直读**：原生适配深浅主题，App 运行期优先通过宿主内存只读 `retrieveUserQuotaSummary` 刷新配额缓存。
- **多模型池一键切换**：内置 `Gemini` / `Claude` / `Argon` 标签切换器与额度状态徽章（`充裕` / `余量偏紧` / `额度偏低`）。

### 3. Antigravity IDE / VS Code 原生状态栏与 Webview 面板
- **底部常驻 `StatusBarItem`**：根据当前打开的工作区自动匹配活跃或最新 Antigravity 会话，实时展示 `$(pulse) 4 Carbon Med · Ctx 19% · Cache 97% · 85 tok/s │ 5h 22% · 7d 45%` 及阈值告警背景色，悬停弹出带快捷命令的 Markdown 摘要卡片。
- **点击打开 `AGY Context & Quota` 详情面板**：提供会话切换器（支持自动跟随当前工作区或手动固定会话）、完整双视图上下文拆分、高占用工具调用 / 规则 / Skills **一键在编辑器打开对应文件**、上下文增长曲线及多池配额仪表盘。
- **跨 Node 版本兼容**：Extension Host 内置 `node:sqlite` 时进程内零开销直读；旧版 Electron Host 自动桥接本机 Node `>= 22.13` CLI `inspect --json`。

### 4. Antigravity CLI `/statusline`
- **终端单行自适应渲染**：`4 Carbon Med │ main │ [192.3k/1M] 19% · Cache 97%/92% · 85 tok/s · 5h 22% 2h15m · 7d 45% 4d08h · +2 sub`，按列宽多级裁剪并保持 ANSI 动态配色。

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
# 1. 一键安装插件、同步 Antigravity IDE / VS Code 扩展、配置 CLI 并启动 App 守护进程
node dist/agy-statusline.mjs install

# 2. 检查三端接线、IDE 扩展状态、CDP 状态、守护进程与缓存配额
node dist/agy-statusline.mjs doctor

# 3. 在终端直接查看当前工作区会话的精细上下文拆分快照
node dist/agy-statusline.mjs inspect

# 4. 手动刷新 5h / 7d 配额缓存
node dist/agy-statusline.mjs quota refresh

# 5. 若运行中的 App 未开启 CDP 调试端口（missing_opt_in_flag），在外部终端平滑重启
node dist/agy-statusline.mjs relaunch

# 6. 彻底卸载插件、IDE 扩展、自启服务及 CLI 配置项
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
  "proxy": "",
  "cli": {
    "showModel": true,
    "showGitBranch": true,
    "color": true
  },
  "app": {
    "enabled": true,
    "cdpAutoRelaunch": true
  },
  "ide": {
    "enabled": true,
    "alignment": "right"
  }
}
```

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 插件总开关 |
| `channel` | `"auto"` | 会话与 App 探测通道：`"auto"` / `"stable"` / `"insiders"` |
| `cacheRateMode` | `"last"` | 常驻行 `Cache%` 口径：`"last"`（最新一步）或 `"session"`（会话累计） |
| `contextLimit` | `256000` | 数据库未上报模型真实 `maxCtx` 时的兜底上下文上限（Token） |
| `contextLimitOverride` | `0` | 设为 `> 0` 时强制覆盖所有会话的上下文上限分母（可用于提前压缩预警） |
| `proxy` | `""` | 可选 HTTP/HTTPS/SOCKS 代理地址；留空时 `install` 自动继承终端代理变量 |
| `cli.showModel` | `true` | CLI 状态栏是否显示模型简称前缀 |
| `cli.showGitBranch` | `true` | CLI 状态栏是否显示当前 Git 分支 |
| `cli.color` | `true` | CLI 是否启用 ANSI 动态分级配色 |
| `app.enabled` | `true` | 是否启用 Antigravity App 底栏注入 |
| `app.cdpAutoRelaunch` | `true` | 后台守护进程是否对冷启动且未带调试参数的 App 自动接力补参 |
| `ide.enabled` | `true` | 是否启用 Antigravity IDE / VS Code 底部状态栏 |
| `ide.alignment` | `"right"` | IDE 底部状态栏停靠位置：`"right"` 或 `"left"` |
