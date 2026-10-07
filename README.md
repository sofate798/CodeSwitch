# CodeSwitch

> 一个按钮，切换你的 AI 大脑 —— 统一管理多个 AI IDE 的供应商配置

CodeSwitch 是一款基于 Electron 的桌面工具，用于集中管理各类 AI IDE（Cursor、Windsurf、Trae、Zed 等）的自定义 AI 供应商配置。它支持一键应用供应商、一键恢复官方默认、配置快照与备份，帮助开发者在多个模型和 API 之间快速切换，避免手动改配置文件的繁琐与遗漏。

当前版本：**v1.1.0 (MVP)** ｜ 许可证：**MIT** ｜ 主要平台：**Windows 10/11 x64**（macOS / Linux 规划中）

---

## 目录

- [核心特性](#核心特性)
- [支持的 IDE](#支持的-ide)
- [支持的协议](#支持的协议)
- [技术栈](#技术栈)
- [架构设计](#架构设计)
- [快速开始](#快速开始)
- [构建与打包](#构建与打包)
- [项目结构](#项目结构)
- [数据安全](#数据安全)
- [使用说明](#使用说明)
- [注意事项](#注意事项)
- [许可证](#许可证)

---

## 核心特性

- **IDE 自动探测**：扫描系统常见安装路径、家目录标记与注册位置，自动识别已安装的 AI IDE，并显示其当前状态（默认 / 已自定义 / 异常 / 未安装）。
- **供应商管理**：新增、编辑、删除 AI 供应商，必须显式选择协议类型（OpenAI / Anthropic），支持分组、连接测试与 JSON 导入导出。
- **一键应用与恢复**：对单个或全部 IDE 应用供应商配置；修改前自动备份，支持一键恢复官方默认设置与失败回滚。
- **快照管理**：保存当前所有 IDE 的供应商绑定状态，可随时一键切换回某个快照。
- **备份中心**：按 IDE 归档历史备份，支持查看、恢复与删除。
- **操作日志**：记录每一次修改 / 恢复操作，便于追溯。
- **API Key 加密**：使用 AES-256-GCM 本地加密，密钥由设备指纹派生，UI 中默认脱敏显示（`sk-****xxxx`）。
- **系统托盘**：关闭窗口最小化到托盘，常驻后台。
- **国际化与主题**：内置中文 / English 双语，支持深色 / 浅色 / 跟随系统主题。
- **自动更新**：集成 electron-updater 检查更新（打包环境下生效）。

---

## 支持的 IDE

CodeSwitch 采用数据驱动的适配器注册表（见 [`electron/adapters/registry.ts`](electron/adapters/registry.ts)），当前内置以下 11 款 IDE：

| IDE | 支持协议 | 配置写入方式 |
| --- | --- | --- |
| Cursor | OpenAI / Anthropic | 凭证加密存储于应用内数据库，需在设置中手动填写 |
| Windsurf | OpenAI / Anthropic | 新版为 Protobuf 二进制配置，需手动配置 |
| Trae | OpenAI / Anthropic | 凭证加密存储，需手动配置 |
| Zed | OpenAI / Anthropic | 明文 JSON，**支持一键写入** |
| GitHub Copilot (VS Code) | OpenAI | 由 VS Code / GitHub 统一管理，需通过代理或设置调整 |
| Kiro | OpenAI / Anthropic | 凭证加密存储，需手动配置 |
| CodeBuddy | OpenAI | 系统加密存储，需手动配置 |
| Qoder | OpenAI | 凭证加密存储，需手动配置 |
| Antigravity | OpenAI / Anthropic | 由控制台统一管理，需手动配置 |
| Gemini CLI | OpenAI | 默认 OAuth 登录，自定义接口需环境变量或代理 |
| Codex CLI | OpenAI | TOML 配置，需手动编辑 |

> 说明：多数 IDE 出于安全考虑将凭证加密存储在其私有数据库 / 二进制配置中，CodeSwitch 不会强行改写这些文件，而是探测状态、生成对应格式的配置片段并提示用户在 IDE 设置界面手动填写。其中 Zed 使用明文 JSON，可直接一键写入。

---

## 支持的协议

创建供应商时必须二选一：

**OpenAI 兼容协议**

- 请求路径：`{base_url}/v1/chat/completions`
- 请求头：`Authorization: Bearer {api_key}`
- 连接测试：调用 `{base_url}/v1/models` 或最小 Chat Completion 请求
- 典型 Base URL：`https://api.openai.com/v1`、`https://api.deepseek.com/v1`、`https://openrouter.ai/api/v1`

**Anthropic 协议**

- 请求路径：`{base_url}/v1/messages`
- 请求头：`x-api-key: {api_key}`、`anthropic-version: 2023-06-01`
- 连接测试：向 `{base_url}/v1/messages` 发送最小消息
- 典型 Base URL：`https://api.anthropic.com`

连接测试超时 5s，返回 200 视为成功，并展示延迟与错误信息。

---

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 桌面框架 | Electron 31 |
| 构建编排 | electron-vite 2 |
| 前端框架 | Vue 3 + TypeScript 5 |
| UI 组件库 | Naive UI |
| 图标库 | @vicons/ionicons5、@vicons/material（矢量组件，全项目禁用 Emoji） |
| 状态管理 | Pinia |
| 路由 | Vue Router（Hash 模式） |
| 国际化 | vue-i18n |
| 本地存储 | electron-store |
| 数据解析 | sql.js（SQLite）、smol-toml（TOML） |
| HTTP | axios |
| 加密 | Node.js crypto（AES-256-GCM + scrypt） |
| 打包 | electron-builder |
| 更新 | electron-updater |

---

## 架构设计

CodeSwitch 由 electron-vite 拆分为三个构建目标：`main`（主进程）、`preload`（预加载桥接）、`renderer`（Vue 前端）。渲染进程通过 `contextBridge` 暴露的 `window.api` 与主进程进行 IPC 通信。

```text
┌─────────────────────────────────────────┐
│            Renderer Process             │
│  Vue 3 UI (IDE 列表 / 供应商 / 快照)      │
└──────────────┬──────────────────────────┘
               │ IPC (contextBridge)
┌──────────────▼──────────────────────────┐
│              Main Process               │
│  ├── IDE Scanner Service                │
│  ├── Config Adapter (Registry)          │
│  ├── Provider Service (OpenAI/Anthropic)│
│  ├── Backup Service                     │
│  ├── Crypto Service (AES-256-GCM)       │
│  ├── Snapshot Service                   │
│  └── Logger Service                     │
└──────────────┬──────────────────────────┘
               │ fs / http
┌──────────────▼──────────────────────────┐
│     File System / IDE Configs / API     │
└─────────────────────────────────────────┘
```

主进程服务位于 [`electron/services/`](electron/services)，IPC 路由集中在 [`electron/ipc/handlers.ts`](electron/ipc/handlers.ts)，渲染进程可调用的接口类型定义在 [`electron/shared/types.ts`](electron/shared/types.ts) 的 `API` 接口中。

前端页面（[`src/views/`](src/views)）：

- `Home.vue`：首页，IDE 卡片网格与状态徽章
- `Providers.vue`：供应商增删改查（含协议选择、连接测试、导入导出）
- `Snapshots.vue`：快照管理
- `Backups.vue`：备份中心
- `Logs.vue`：操作日志
- `Settings.vue`：主题、语言、数据目录、更新等设置

---

## 快速开始

### 环境要求

- Node.js 24+（推荐 LTS）
- npm
- Windows 10/11 x64（开发与运行的主要目标平台）

### 安装依赖

```bash
npm install
```

### 启动开发模式

```bash
npm run dev
```

electron-vite 将启动开发服务器并加载 Electron 窗口，支持热更新。

---

## 构建与打包

| 命令 | 说明 |
| --- | --- |
| `npm run typecheck` | 分别对前端（vue-tsc）与主/预加载侧（tsc）执行类型检查 |
| `npm run build` | 先执行 typecheck，再用 electron-vite 构建三端产物到 `out/` |
| `npm run preview` | 预览已构建的产物 |
| `npm run build:win` | 构建并生成 Windows NSIS 安装包，输出到 `release/` |
| `npm run build:dir` | 构建并输出未签名的可调试目录 |

Windows 打包配置见 [`electron-builder.yml`](electron-builder.yml)（appId `com.codeswitch.app`，NSIS 安装器，支持自定义安装目录与桌面快捷方式）。项目也提供了封装一键构建流程的 [`build.bat`](build.bat)。

---

## 项目结构

```text
CodeSwitch/
├── electron/                  # 主进程与预加载侧
│   ├── main/index.ts          # 主进程入口：窗口、托盘、自动更新
│   ├── preload/index.ts       # contextBridge 桥接，暴露 window.api
│   ├── ipc/handlers.ts        # IPC 路由与处理器
│   ├── adapters/registry.ts   # 数据驱动的 IDE 适配器注册表
│   ├── services/              # 核心服务
│   │   ├── ideScanner.ts      # IDE 探测与状态检测
│   │   ├── provider.ts        # 协议转换与连接测试
│   │   ├── backup.ts          # 备份与恢复
│   │   ├── snapshot.ts        # 快照管理
│   │   ├── crypto.ts          # AES-256-GCM 加密与脱敏
│   │   ├── store.ts           # electron-store 持久化
│   │   └── logger.ts          # 内存缓冲 + 按日文件落盘日志
│   └── shared/types.ts        # 跨进程共享类型定义
├── src/                       # Vue 渲染进程
│   ├── views/                 # 页面组件
│   ├── stores/app.ts          # Pinia 状态
│   ├── router/index.ts        # 路由
│   ├── locales/               # zh-CN / en-US 语言包
│   ├── icons/                 # 自定义品牌 SVG 组件
│   ├── i18n.ts                # 国际化入口
│   ├── App.vue
│   └── main.ts
├── resources/icons/           # 应用图标（ico/png，仅用于打包）
├── scripts/build-icon.mjs     # 图标生成脚本
├── electron.vite.config.ts    # 三端构建配置
├── electron-builder.yml       # 打包配置
├── package.json
└── 开发需求文档.md             # 产品需求文档 (PRD)
```

---

## 数据安全

- **本地优先**：所有数据（供应商、快照、备份、日志）均存储在本机用户数据目录，不上传任何服务器。
- **加密存储**：API Key 使用 AES-256-GCM 加密，密钥由设备指纹（主机名 + MAC）经 scrypt 派生并绑定本机，存储格式为 `enc:<iv>:<tag>:<data>`。
- **脱敏显示**：敏感信息在 UI 中默认脱敏为 `sk-****xxxx`。
- **原子写入**：文件写入采用「写临时文件 + 原子替换」策略，失败自动回滚。
- **本机测试**：连接测试直接在本机发起，不经中转服务器。

> 由于加密密钥绑定设备指纹，加密后的数据在其他机器上无法解密，请在同一台设备上使用与迁移。

---

## 使用说明

1. **添加供应商**：进入「供应商」页面，填写名称、选择协议类型（OpenAI / Anthropic）、填入 API Key、Base URL 与 Model，保存。可点击「连接测试」验证可用性。
2. **应用配置**：在首页选中目标 IDE，选择要应用的供应商并点击「应用」。应用前会自动备份原配置。
3. **恢复默认**：在 IDE 详情或首页点击「恢复默认」，将配置还原为官方默认或此前的备份（危险操作需二次确认）。
4. **快照**：在「快照」页面保存当前所有 IDE 的供应商绑定，之后可一键切换。
5. **设置**：在「设置」页面切换主题、语言、数据目录，或检查更新。

---

## 注意事项

- 多数 IDE 的凭证由其自身加密管理，CodeSwitch 会生成对应格式的配置并提示手动填写路径，请按提示在 IDE 设置界面完成配置。
- 若选择的协议与目标 IDE 不兼容（例如某 IDE 仅支持 OpenAI 协议却应用了 Anthropic 供应商），应用前会给出明确提示。
- 应用或恢复配置后，通常需要重启对应 IDE 才能生效。
- 本项目 UI 强制规范：禁止使用任何 Emoji 字符，所有图标均来自矢量图标组件库。

---

## 许可证

本项目基于 MIT License 开源，详见 [LICENSE](LICENSE)。

> 文档中提及的 OpenAI、Anthropic、Cursor、Windsurf 等均为其各自持有者的商标，本项目仅用于兼容性说明，不代表任何官方关联或授权。
