# agy-statusline

面向 **Antigravity App (2.0+)** 与 **Antigravity CLI (`agy`)** 的统一实时遥测与配额常驻状态栏插件（`v0.2.3`），单文件零外部运行时依赖（仅需 Node.js `>= 22.13.0` 原生 `node:sqlite` 与全局 `WebSocket`），双端共享同一份 SQLite 解析逻辑与配额缓存（`~/.cache/agy-statusline/quota_cache.json`）。

---

## 核心特性

### 1. Antigravity App 三级防重叠布局、Prism 主题兼容与交互式浮窗
- **自适应防重叠双区布局**：
  - **宽屏 / 中屏**：会话指标挂载在输入框工具栏右侧（`Turbo` 左侧）：`128 tok/s · Cache 96%/85% · ◐ 16% · TTFT 5.5s · Out 28k`（上下文采用 SVG 动态阈值进度圆环）；输入框外右下角独立展示 `5h / 7d` 配额。
  - **窄分栏自动下沉**：当侧栏宽度不足时，`ResizeObserver` 自动将会话指标下沉至输入框外左下角（与右下角配额分列），避免挤压模型选择器与 `Turbo` 按钮；仅鼠标悬停在指标文字上才触发浮窗，空白区完全透传。
- **Obsidian Prism 兼容**：保留 Prism 全部主题、滑块、宠物与思考翻译能力，自动接管并替换其内置遥测芯片，原生适配四套深浅光学主题。
- **App 内存态直读配额 RPC**：App 运行期间优先通过宿主渲染进程只读 `retrieveUserQuotaSummary` 直接刷新共享配额缓存，零子进程开销（纯 CLI 离线场景自动回退 `agy -p /usage`）。
- **现代仪表盘悬停浮窗**：
  - **真实五维上下文分布与压缩点**：直接解析 SQLite `TokenBreakdown` 及其逐条步骤明细，拆分展示「系统 / 工具定义 / 工具调用 / 模型 / 提问」五段彩色进度条，并标注 `85%` 自动压缩点刻度。
  - **多模型池一键切换**：内置 `Gemini` / `Claude`（及 `Argon`）标签切换器与额度状态徽章（`充裕` / `余量偏紧` / `额度偏低`），点击即可在浮窗内切换查看各池 `5h / 周额度`。

### 2. Antigravity CLI `/statusline`
- **终端单行格式**：`4 Carbon Med │ main │ [192.3k/1M] 19% · Cache 97%/92% · 85 tok/s · 5h 22% 2h15m · 7d 45% 4d08h · +2 sub`。
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
  "proxy": "",
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
| `proxy` | `""` | 可选 HTTP/HTTPS/SOCKS 代理地址（如 `"http://127.0.0.1:7902"`）；留空时 `install` 自动继承终端代理变量并持久化至后台守护服务，同时自动将 `localhost,127.0.0.1,::1` 加入 `NO_PROXY` |
| `cli.showModel` | `true` | CLI 状态栏是否显示模型简称前缀 |
| `cli.showGitBranch` | `true` | CLI 状态栏是否显示当前 Git 分支 |
| `cli.color` | `true` | CLI 是否启用 ANSI 动态分级配色 |
| `app.enabled` | `true` | 是否启用 Antigravity App 底栏注入 |
| `app.cdpAutoRelaunch` | `true` | 后台守护进程是否对冷启动且未带调试参数的 App 自动接力补参 |
