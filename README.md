# agy-tools

面向 Google **Antigravity App (2.0+)**、**Antigravity IDE / VS Code** 与 **Antigravity CLI (`agy`)** 的轻量工具集合仓库（npm Workspaces），采用零外部运行时依赖设计，基于原生 Node.js 构建。

## 包含工具

| 工具 | 说明 | 版本 | 文档 |
| --- | --- | --- | --- |
| `agy-statusline` | 覆盖 App / IDE / CLI 三端的统一实时遥测（上下文圆环、12 类精细上下文与懒加载分析、压缩节省、`Cache 单步/整体`、`tok/s`、`TTFT`、`+sub`、Orchestrator 阶段）与 `5h / 7d` 模型配额常驻状态栏插件 | `v0.3.0` | [查看文档](./packages/agy-statusline/README.md) |

## 环境与开发命令

- **运行环境**：Node.js `>= 22.13.0`（使用内置 `node:sqlite` 与全局 `WebSocket`）
- **常用工作区脚本**（仓库根目录执行）：

```sh
# 安装编译期依赖（typescript ~5.8.2 + esbuild）
npm install

# 编译全量单文件产物
npm run build

# 类型检查 + 全量单测
npm test

# 打包插件发布目录与归档包
npm run stage
```

开发规范与提交流程请参考 [AGENTS.md](./AGENTS.md)。
