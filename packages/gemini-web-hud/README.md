# gemini-web-hud

面向 **Google Gemini 网页端（`https://gemini.google.com/`）** 的轻量 Chrome / Edge Manifest V3 浏览器扩展，零外部运行时依赖。

## 核心功能

1. **左侧圆点导航轨与悬停目录面板（TOC）**
   - 自动提取当前对话中的所有用户提问，在对话区左侧边缘展示极简圆点导航轨（当前可视提问高亮发光），支持直接点击圆点跳转。
   - 鼠标悬停时从左侧平滑淡出偏高的完整目录面板（带序号、总数徽章、关键词筛选与首条/最新快捷跳转）。
   - 完整适配 Gemini 网页端 **Trusted Types / CSP**、左侧边栏展开/收起与 SPA 路由切换，自动跟随深浅主题。
2. **输入框底部内联真实对话余额（同步 `/usage` 官方配额）**
   - 通过同源隐藏 iframe + `declarativeNetRequest` 静默读取 `https://gemini.google.com/usage` 的真实额度数据（优先拦截 `GEMINI_WEB_GRAPHQL` 结构化返回，DOM 文本解析兜底），**不做任何虚假估算**。
   - 直接并入输入框底部免责声明同一行展示 **5h / 7d 真实余额百分比与重置倒计时**（无多余胶囊），悬停弹出详细进度条与精确本地重置时间。
   - 每轮 AI 回复完成自动静默刷新，同时支持一键手动刷新与多标签页同步。

---

## 本地构建与浏览器安装

在仓库根目录执行构建：

```sh
npm run build
```

构建完成后，扩展产物位于 `packages/gemini-web-hud/dist/`：

1. 在浏览器打开扩展管理页：
   - Chrome：`chrome://extensions/`
   - Edge：`edge://extensions/`
2. 开启 **「开发者模式」**。
3. 点击 **「加载已解压的扩展程序」**，选择 `packages/gemini-web-hud/dist` 文件夹。
4. 打开或刷新 `https://gemini.google.com/` 即可使用。
