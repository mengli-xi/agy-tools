# AGENTS.md

本文档供在本仓库进行开发、调试、打包与提交的编码 Agent 遵循。

---

## 1. 仓库定位与硬性技术约束

- **工作区结构**：根目录采用 npm Workspaces（`"workspaces": ["packages/*"]`），当前核心包为 `packages/agy-statusline/`。
- **零外部运行时依赖**：所有发布包仅允许依赖 **Node.js `>= 22.13.0`** 原生 API（`node:sqlite`、全局 `WebSocket`、`node:test`、`node:crypto`、`node:child_process`），**禁止**在子包添加运行时 npm `dependencies`。
- **TypeScript 与编译期工具链锁定**：根目录 `devDependencies` 将 `typescript` 锁定为 `~5.8.2`（切勿升级到 `7.x`），由 `esbuild` 打包；`tsconfig.base.json` 启用 `strict`、`noUnusedLocals` 与 `noUnusedParameters`。
- **禁止修改无关与忽略目录**：`samples/` 已在 `.gitignore` 中忽略，仅作参考只读，严禁修改或提交其中的文件。

---

## 2. `packages/agy-statusline` 架构与开发约定

### 2.1 双阶段构建链路 (`packages/agy-statusline/scripts/build.mjs`)
1. Stage 1：将 `src/app/capsule.css` 内联为 `__AG_CAPSULE_CSS__`，把 `src/app/browser-runtime.ts` 打包为浏览器端单文件脚本字符串。
2. Stage 2：将该脚本字符串以 `__AG_BROWSER_RUNTIME_CODE__` 注入 `src/cli.ts`，产出独立可执行产物 `dist/agy-statusline.mjs`（同样机制用于测试构建 `build/test/*.test.mjs`）。
3. **版本同步红线**：升级版本号时必须**同时**修改以下三处：
   - `packages/agy-statusline/package.json`（`"version"`）
   - `packages/agy-statusline/plugin.json`（`"version"`）
   - `packages/agy-statusline/src/app/daemon.ts`（`export const APP_VERSION = '...'`）

### 2.2 核心模块分工
| 模块路径 | 职责 |
| --- | --- |
| `src/core/proto.ts` & `sqlite-metrics.ts` | 零依赖 Protobuf 解码、只读 SQLite 增量尾行游标、子 Agent 血缘 BFS 汇总（兼容 WSL2 UNC 复制降级） |
| `src/core/quota-store.ts` & `usage-runner.ts` | `quota_cache.json` 原子合并与文件锁、模型桶路由（`Gemini` / `3P` / `Argon`）、过期重置占位、~/.gemini/bin/agy `/usage` 后台刷新与退避 |
| `src/core/format.ts` | `MetricTone` 阈值色阶计算、`buildAppPayload` 双栏 HTML 与仪表盘 Hover 弹窗 HTML 构建 |
| `src/core/config.ts` | `~/.config/agy-statusline/config.json` 与只读宿主插件开关 `~/.gemini/config/config.json` 加载 |
| `src/statusline/{ansi,git,render}.ts` | CLI `/statusline` 宽/窄终端自适应渲染、ANSI 动态着色、`.git/HEAD` 零子进程分支读取 |
| `src/app/browser-runtime.ts` & `capsule.css` | 将 `.ag-statusline-bar` 外置于 `[id="antigravity.agentSidePanelInputBox"]` 正下方（`box.after(bar)`）、视口自适应防裁切 Tooltip、热替换自清理 |
| `src/app/host-probe.ts` & `service.ts` | POSIX `etime` 解析、基于进程树 + `lsof` 的精准 `.db-wal` 归属判定、安装/卸载/`doctor`/`relaunch`（含 LaunchAgent/systemd PATH 注入） |
| `src/app/daemon.ts` | CDP Target 发现、脚本哈希热更新推送、面板订阅响应及 **M2 冷启动自动接力**（`cdpAutoRelaunch`） |

---

## 3. 宿主边界与测试红线

1. **禁止触碰或杀掉 `Antigravity IDE.app`**：
   - `Antigravity IDE.app`（`agy --hub`）与独立版 `Antigravity.app` 共用 `~/.gemini/antigravity/conversations/` 目录。
   - 检查活跃 `.db-wal` 时必须使用 `findRecentActiveWal(..., appRootPids)` 结合 `lsof` 与 `ps` 进程树校验句柄归属，严禁只按目录 mtime 拦截，也禁止影响 IDE 会话进程。
2. **macOS Agent 子终端沙盒限制**：
   - 运行在 IDE Agent 工具沙盒内时，macOS Seatbelt 会拦截 `/usr/bin/open` 拉起 GUI `.app`。**不要**在 Agent 工具命令内尝试 `relaunch` 或重启宿主应用。
   - 若 App 处于 `app cdp: ready`，直接运行 `install` 同步插件目录，守护进程会在 1~2 秒内通过现有 CDP 通道自动完成热更新。
3. **单测沙盒隔离**：
   - `test/statusline-and-install.test.ts` 与其他单测必须使用临时目录 + `--home <tmpDir>`，严禁在测试过程中读写或修改真实用户目录（`~/.gemini`、`~/.config`、`~/.cache`、`~/Library/LaunchAgents`）。

---

## 4. 标准开发、打包与验证流程

每次修改代码后，在仓库根目录或 `packages/agy-statusline` 执行：

```sh
# 1. 类型检查 + 编译单测 + 全量测试 + 打包干净发布包
npm test && npm run stage

# 2. 官方插件清单严格校验（必须 findings: []）
agy plugin validate packages/agy-statusline/release/agy-statusline --strict --json

# 3. 同步本机安装（当 App CDP 就绪时自动热更新）
node packages/agy-statusline/dist/agy-statusline.mjs install
node "$HOME/.gemini/config/plugins/agy-statusline/dist/agy-statusline.mjs" doctor
```

---

## 5. Git 提交规范（遵循 `/commit-it`）

凡涉及到 `git commit`，必须严格遵守以下全部规则：

1. **先确认后提交**：必须先将完整的提交说明（Commit Message）展示给用户，**等待用户明确确认后再执行 `git commit`**。每次只做一个提交。
2. **提交范围**：
   - 仅提交当前会话中修改并审查过的改动，以及用户明确要求一并提交的改动，按会话上下文确定文件清单，不盲目以当前暂存区或整个工作区为准。
   - 若工作区中存在其他不属于本次会话的改动不纳入提交，在向用户确认时用一句话说明“未包含其他未改动/工作区其余文件”，不逐个列出文件路径。
3. **禁止写任务序号**：首行与正文**均不写**技术方案或计划里的任务编号（例如「T3」「任务 2」「阶段一第 4 步」），直接写这一步实现或修复的具体内容。
4. **首行规范**：
   - 格式：`type(module): 做了什么`（例如 `feat(statusline): 接入输入框外置底栏与数值动态配色`）。
   - 长度不超过 **72 列**（一个汉字算 2 列，约 36 字内）。
   - **禁止使用空泛词**：禁用「优化」「完善」「修复问题」等看不出具体改动结果的词汇。
   - 允许的 `type`：
     - `feat`（新增功能）、`fix`（修复缺陷）、`refactor`（不改外部行为的结构调整）、`perf`（性能优化）
     - `docs`（仅改文档）、`style`（仅改代码格式）、`test`（新增或修改测试）
     - `build`（构建脚本/打包配置/依赖版本）、`ci`（CI 配置）、`chore`（不涉源码和测试的其他改动）、`revert`（回退）
   - 常用 `module`：`statusline`、`daemon`、`quota`、`service`、`repo`。
5. **正文规范**：
   - 首行之后**必须空一行**再写正文；若首行已经说清则不写正文、不分点；首行说不全时按编号分点（`1. ...`），每点只写一件事。
   - 改动原因从首行和代码中看不出来时，补充一两句书面表述说明原问题与改动缘由（仅写本次会话中有真实依据的原因，不自行推测）。
   - **先写外部可见的行为变化**；函数名、文件名只在解释原因时提及，不逐项罗列实现细节。
   - 只写最终改动结果，不写审查修改过程（禁止出现「根据反馈调整」等），**不写测试情况**。
6. **拆分建议与禁止尾注**：
   - 若本次改动混有几件互不相关的事项，在提交说明后附上拆分建议（仍然只提供一个当前提交方案）。
   - 严禁添加 `Authored by` / `Co-authored-by` 等署名尾注。
