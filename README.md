<p align="center">
  <img src="build/icon.png" width="72" height="72" alt="Atrium Logo" />
</p>

<h1 align="center">Atrium</h1>

<p align="center">
  <strong>Official Open-Source Desktop Client — A Calm, Warm Studio AI Agent Workbench</strong>
</p>

<p align="center">
  <strong>English</strong> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="https://github.com/yasmeendawnelle-spec/Atrium/releases">Releases (Download)</a> ·
  <a href="#local-development">Local Development</a> ·
  <a href="LICENSE">MIT License</a>
</p>

<p align="center">
  <a href="https://github.com/yasmeendawnelle-spec/Atrium/releases/latest">
    <img src="https://img.shields.io/github/v/release/yasmeendawnelle-spec/Atrium?label=Latest%20Release&color=c46342" alt="Latest Release" />
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-MIT-2e7a52" alt="MIT License" />
  </a>
</p>

---

## Download & Install (Releases)

Looking for the Windows desktop installer without building from source?

- **Latest Version**: **[Download Latest Release (GitHub Releases)](https://github.com/yasmeendawnelle-spec/Atrium/releases/latest)**
- **All Versions**: **[Browse All Releases](https://github.com/yasmeendawnelle-spec/Atrium/releases)**
  - Open a release, expand **Assets** at the bottom, and download `Atrium-Setup-<version>.exe`.
  - Built-in auto-updater is included (`v0.2.0` and above can automatically check for and install newer updates inside the app).
  - **Windows SmartScreen Note**: Release builds are currently unsigned (`signExecutable: false`). If Windows shows *"Windows protected your PC"*, click **More info -> Run anyway**.

> **Account & BYOK Note**: Because this is the official Atrium client, signing in with an Atrium account (via Google, GitHub, or email registration/password) is required before opening the main workbench. Once signed in, you can use built-in Atrium Cloud models or add your own custom API keys (BYOK) and local Ollama endpoints anytime.

---

## Key Capabilities

- **Multi-Protocol LLM Engine & 2-Level Collapsible Model Picker**
  - Supports **Anthropic Messages**, **OpenAI Responses (Codex)**, and **Chat Completions** alongside custom third-party providers (BYOK) and local Ollama.
  - Organizes models into a clean **Provider (Level 1) -> Model Family (Level 2)** collapsible hierarchy across chat, settings, and provider forms.
  - Configurable context window limits (`Auto`, `64k`, `128k`, `200k`, `256k`, `400k`, `1M`) with dynamic auto-compaction scaled to 80% of the active context budget.

- **Built-in Browser & Dedicated Atrium Virtual Cursor (Computer Use)**
  - Prioritizes an isolated, per-conversation Chromium panel driven by Atrium's virtual cursor overlay and `sendInputEvent` so agent actions never hijack your physical OS mouse—while keeping an explicit opt-in toggle for full OS desktop control.
  - Supports switching between Edge (Bing) and Google search modes.

- **Visual MCP Marketplace, GitHub Inspector, Plugins & Skills**
  - Browse the official MCP registry or inspect any GitHub repository (read-only over API) before installing servers or plugin bundles.
  - Manage local Plugins, Skills, and optional lifecycle hooks (`PreToolUse`, `PostToolUse`, `Stop`).

- **Interactive Artifacts & Real PTY Terminal**
  - Offline sandboxed preview for React/JSX/TSX, HTML, Mermaid diagrams, Recharts visualizations, SVG, and structured Git diff review.
  - Integrated resizable PTY terminal drawer (`@xterm/xterm`) and Git worktree session isolation.

- **Knowledge Base, Long-Term Memory, Automations & Spotlight Quick Entry**
  - Local BM25 search across Markdown, code, PDF, DOCX, and XLSX documents plus cross-session memory extraction and management.
  - Cron and interval-based background automations.
  - Minimalist global floating bar (`Alt+Space`) with one-click screen capture, clipboard image paste, voice dictation, and instant handoff to the main workbench.

---

<a id="local-development"></a>

## Local Development

### Prerequisites

- **Node.js** >= 22 (uses `--experimental-strip-types` to run TypeScript tests directly)
- **npm** >= 10
- **OS**: Windows (primary packaged target; renderer and shared core follow cross-platform Electron patterns)

### Commands

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

## Project Structure

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

## License

This project is open-sourced under the [MIT License](LICENSE).
