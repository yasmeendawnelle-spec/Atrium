<p align="center">
  <img src="build/icon.png" width="72" height="72" alt="Atrium Logo" />
</p>

<h1 align="center">Atrium</h1>

<p align="center">
  <strong>Atrium 官方开源桌面客户端 · 温暖工作室风格的本地与云端 AI Agent 工作台</strong><br/>
  <strong>Official Open-Source Desktop Client — A Calm, Warm Studio AI Agent Workbench</strong>
</p>

<p align="center">
  <a href="#中文说明">中文说明</a> ·
  <a href="#english">English</a> ·
  <a href="#development">Local Development</a> ·
  <a href="LICENSE">MIT License</a>
</p>

---

<a id="中文说明"></a>

## 中文说明

**Atrium** 是采用 Electron + React + TypeScript 构建的 **Atrium 官方开源桌面 AI Agent 工作台**。它在保持桌面端原生工具控制力、MCP 生态扩展性与本地开发深度整合的同时，用温暖克制的工作室视觉语言提供从对话、编程到自动化任务的一体化体验。

> **关于账号与模型接入说明**：本仓库为 Atrium 官方客户端源码。使用桌面端前需先在应用内登录 **Atrium 官方账号**（支持 Google / GitHub 授权或受支持的邮箱注册与密码登录）；登录后既可直接使用云端聚合模型与订阅额度，也可随时添加自有 API Key（BYOK）或本地 Ollama 服务。

### 核心特性

- **多协议模型引擎与双层折叠管理**
  - 原生兼容 **Anthropic Messages**、**OpenAI Responses（Codex）** 与 **Chat Completions** 三大协议，支持 Atrium Cloud、自定义第三方 API（BYOK）及本地 Ollama。
  - **两级可折叠模型列表**：外层按用户配置的「模型供应商大类」默认折叠，展开后按模型系列自动划分「模型分类小类」收纳，避免长模型列表刷屏。
  - 支持在对话与设置中手动覆盖上下文窗口上限（Auto ～ 1M tokens），并按有效上限的 80% 动态触发自动上下文压缩。

- **对话内嵌 Chromium 浏览器与独立虚拟光标（Computer Use）**
  - 每个对话拥有隔离的内置 Chromium 浏览器会话与专属 **Atrium 独立虚拟光标**，Agent 可直接在内置浏览器中点击、输入、滚动和抓取控制台与可交互元素引用，**不会抢占或移动用户自己的物理鼠标**；同时保留一键切换直接操控系统桌面的显式开关。
  - 支持 Edge（国内直连 Bing）与 Google 双浏览器模式切换。

- **可视化 MCP 市场、GitHub 导入与 Plugin / Skill 生态**
  - 内置官方 MCP 注册表搜索，支持贴入任意 GitHub 仓库链接并只读解析清单与 README，安装前清晰预览所需命令与环境变量。
  - 支持导入与管理 Claude/Atrium 风格的 **Plugins**、**Skills** 与钩子（Hooks），支持对 `PreToolUse` / `PostToolUse` 等生命周期进行扩展。

- **交互式 Artifacts 与内置 PTY 终端**
  - 离线沙箱实时渲染 React（JSX/TSX）、HTML、Mermaid 图表、Recharts 数据图、SVG 及结构化代码 Diff 审阅。
  - 集成可拖拽调整大小的真实 PTY 终端抽屉（`xterm.js`），与 Git 工作区 Diff、Worktree 分支隔离协作深度结合。

- **项目知识库、跨会话长期记忆、自动化与全局快捷悬浮窗**
  - 基于 BM25 的项目文档检索（支持 PDF、Word、Excel、Markdown 等多格式索引与拖拽入库）与跨会话长期记忆管理。
  - 支持 Cron / 固定间隔本地定时自动化任务。
  - **全局快捷悬浮窗（Spotlight Bar）**：通过全局快捷键（默认 `Alt+Space`）随时呼出极简悬浮条，支持一键截屏、剪贴板贴图、语音听写提问与一键切回主工作台。

---

### 下载与安装提示

- 可前往仓库的 **Releases** 页面下载 Windows 安装包（`Atrium-Setup-<version>.exe`），客户端内置应用更新检查。
- 当前 Windows 发布包暂未购买商业代码签名证书（`signExecutable: false`），首次运行时如遇 Windows SmartScreen 拦截提示，点击「更多信息 → 仍要运行」即可。

---

<a id="english"></a>

## English

**Atrium** is the **official open-source desktop client** built with Electron, React, and TypeScript. It brings multi-protocol LLM orchestration, isolated per-chat browser Computer Use, visual MCP management, interactive artifacts, knowledge indexing, and desktop workflows into a calm, warm-studio desktop interface.

> **Account & BYOK Note**: Because this is the official Atrium client, signing in with an Atrium account (via Google, GitHub, or email registration/password) is required before opening the main workbench. Once signed in, you can use built-in Atrium Cloud models or add your own custom API keys (BYOK) and local Ollama endpoints anytime.

### Key Capabilities

- **Multi-Protocol LLM Engine & 2-Level Model Picker**
  - Supports **Anthropic Messages**, **OpenAI Responses**, and **Chat Completions** alongside custom API providers and local Ollama.
  - Organizes models into a clean **Provider (Level 1) -> Model Family (Level 2)** collapsible hierarchy.
  - Configurable context window overrides (up to 1M tokens) with dynamic auto-compaction scaled to 80% of the active context budget.

- **Built-in Browser & Dedicated Atrium Virtual Cursor (Computer Use)**
  - Prioritizes a sandboxed, per-conversation Chromium panel driven by Atrium's virtual cursor overlay and `sendInputEvent` so agent actions never hijack your physical OS mouse—while keeping an explicit opt-in toggle for full OS desktop automation.

- **Visual MCP Marketplace, GitHub Inspector, Plugins & Skills**
  - Browse the official MCP registry or inspect any GitHub repository (read-only over API) before installing servers or plugin bundles.
  - Manage local Plugins, Skills, and optional lifecycle hooks (`PreToolUse`, `PostToolUse`, `Stop`).

- **Interactive Artifacts & Real PTY Terminal**
  - Offline sandboxed preview for React/JSX/TSX, HTML, Mermaid, Recharts, SVG, and interactive Git diff review.
  - Integrated PTY terminal drawer (`@xterm/xterm`) and Git worktree session isolation.

- **Knowledge Base, Long-Term Memory, Automations & Spotlight Quick Entry**
  - Local BM25 search across Markdown, code, PDF, DOCX, and XLSX documents plus cross-session memory management.
  - Cron and interval-based background automations.
  - Minimalist global floating bar (`Alt+Space`) with one-click screen capture, clipboard image paste, voice dictation, and instant handoff to the main workbench.

---

<a id="development"></a>

## 本地开发与构建 / Local Development

### 环境要求 / Prerequisites

- **Node.js** >= 22 (uses `--experimental-strip-types` for running TypeScript tests directly)
- **npm** >= 10
- **OS**: Windows (primary packaged target; renderer and shared core follow cross-platform Electron patterns)

### 常用命令 / Commands

```bash
# 1. Install dependencies
npm install

# 2. Start Electron + Vite dev server
npm run dev

# 3. Run TypeScript checks (Node & Web)
npm run typecheck

# 4. Run full unit test suite
npm test

# 5. Build production bundle (out/)
npm run build

# 6. Package Windows NSIS installer
npm run dist:installer
```

---

## 目录结构 / Project Structure

```text
atrium/
├── src/
│   ├── main/        # Electron main process, browser manager, quick entry, desktop driver, auto-updater
│   ├── core/        # Isolated core engine (agent loop, providers/, tools/, mcp/, knowledge, plugins, PTY)
│   ├── preload/     # Context-isolated preload bridge
│   ├── renderer/    # React + Vite frontend views, components, locales & design tokens
│   └── shared/      # Shared TypeScript types, presets, IPC contracts & cloud helpers
├── test/            # Node native unit test suite
├── scripts/         # Artifact runtime bundler & release helper scripts
├── deploy/          # Generic Cloudflare Worker update server setup
├── docs/            # Design system notes
└── build/           # Application icons & brand SVG assets
```

---

## 开源协议 / License

本项目基于 [MIT License](LICENSE) 开源发布。
