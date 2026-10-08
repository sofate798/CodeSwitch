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

- **IDE 自动探测**：优先扫描家目录标记，再探测常见安装路径与配置文件位置，自动识别已安装的 AI IDE，并显示其当前状态（默认 / 已自定义 / 配置异常 / 未安装）。
- **能力分级**：每款 IDE 按可自动化程度标注为「一键写入（auto）」或「辅助配置（assist）」，UI 据此启用或降级应用按钮，避免对无法安全直写的 IDE 强行改写。
- **供应商管理**：新增、编辑、删除 AI 供应商，必须显式选择协议类型（OpenAI / Anthropic），支持分组、连接测试与 JSON 导入导出。
- **一键应用与恢复**：对单个或全部 IDE 应用供应商配置；修改前自动备份，支持一键恢复官方默认设置与失败自动回滚。数据库 / TOML 类 IDE 写入前会检测其是否在运行，未关闭时拒绝写入以防配置被覆盖或损坏。
- **配置生成与复制**：对辅助型 IDE（如 GitHub Copilot）或无法自动定位凭证槽位的情况，可一键生成对应格式的配置文本并复制，按提示在 IDE 设置界面手动粘贴。
- **快照管理**：保存当前所有 IDE 的供应商绑定状态，可随时一键切换回某个快照。
- **备份中心**：按 IDE 归档历史备份（含 SQLite 的 `-wal` / `-shm` 附属文件），支持查看、恢复与删除。
- **操作日志**：记录每一次修改 / 恢复操作，内存缓冲 + 按日文件落盘，便于追溯。
- **API Key 加密**：CodeSwitch 自有存储使用 AES-256-GCM 加密，密钥由设备指纹经 scrypt 派生并绑定本机，UI 中默认脱敏显示（`sk-****xxxx`）；写入目标 IDE 数据库时还会镜像其原生加密格式（Windows DPAPI）。
- **系统托盘**：关闭窗口最小化到托盘，常驻后台。
- **国际化与主题**：内置中文 / English 双语，支持深色 / 浅色 / 跟随系统主题。
- **自动更新**：集成 electron-updater 检查更新（打包环境下生效）。

---

## 支持的 IDE

CodeSwitch 采用数据驱动的适配器注册表（见 [`electron/adapters/registry.ts`](electron/adapters/registry.ts)），当前内置以下 11 款 IDE。其中 10 款支持一键写入，仅 GitHub Copilot 因密钥存于系统级密钥库（DPAPI）无法安全直写，采用「生成配置 + 手动粘贴」的辅助方式：

| IDE | 支持协议 | 配置载体 | 自动化能力 |
| --- | --- | --- | --- |
| Cursor | OpenAI / Anthropic | 应用数据库 `state.vscdb`（SQLite，凭证 DPAPI 加密） | 一键写入（需 Pro 及以上订阅，写入前关闭 Cursor） |
| Windsurf | OpenAI / Anthropic | 应用数据库 `state.vscdb`（SQLite，自适应探测凭证行） | 一键写入（写入前关闭 Windsurf） |
| Trae | OpenAI / Anthropic | 应用数据库 `state.vscdb`（SQLite，自适应探测） | 一键写入（写入前关闭 Trae） |
| Zed | OpenAI / Anthropic | `settings.json`（明文 JSON） | 一键写入（文件不存在时自动创建） |
| GitHub Copilot (VS Code) | OpenAI | VS Code 系统密钥库（DPAPI），无法安全直写 | 辅助：生成配置 + 一键复制，需在设置手动粘贴 |
| Kiro | OpenAI / Anthropic | 应用数据库 `state.vscdb`（SQLite，自适应探测） | 一键写入（写入前关闭 Kiro） |
| CodeBuddy | OpenAI | 应用数据库 `state.vscdb`（SQLite，自适应探测） | 一键写入（写入前关闭 CodeBuddy） |
| Qoder | OpenAI | 应用数据库 `state.vscdb`（SQLite，自适应探测） | 一键写入（写入前关闭 Qoder） |
| Antigravity | OpenAI / Anthropic | `config.json`（明文 JSON） | 一键写入（若控制台另有校验可能需界面确认） |
| Gemini CLI | OpenAI | `~/.gemini/.env`（KEY=VALUE 文本） | 一键写入（需 CLI 支持 OpenAI 兼容端点方生效） |
| Codex CLI | OpenAI | `~/.codex/config.toml` + `auth.json` | 一键写入（写入 `model_provider=codeswitch`，Key 存入 auth.json） |

### 配置写入策略

适配器通过 `storage` 字段声明供应商三要素（apiKey / baseUrl / model）应如何落盘，主进程按策略分派写入与恢复：

| 策略 | 载体 | 说明 |
| --- | --- | --- |
| `json` | 明文 JSON（Zed / Antigravity） | 按点路径写入字段，文件不存在时可自动创建 |
| `sqlite` | VS Code 系 `state.vscdb`（Cursor / Windsurf / Trae / Kiro / CodeBuddy / Qoder） | 用 sql.js 整库读写 `ItemTable`；已知行键直接定位，未知 schema 用 `probeContains` 自适应探测凭证行；apiKey 镜像原字段的 DPAPI 加密形态 |
| `toml` | `config.toml` + 可选 `auth.json`（Codex） | 写入表段与顶层标量，密钥单独落到 JSON secret 文件 |
| `env` | `.env`（Gemini CLI） | 以 `KEY=VALUE` 形式写入环境变量 |

> 说明：SQLite / TOML 类 IDE 采用「整库 / 整文件回写」，写入前必须先完全关闭对应 IDE，否则其退出时可能覆盖或损坏配置——CodeSwitch 会在检测到进程运行时拒绝写入并提示。当某 IDE 的凭证行无法自动定位时，可改用「生成配置」获取可复制的配置文本手动设置。

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

主进程服务位于 [`electron/services/`](electron/services)，IPC 路由集中在 [`electron/ipc/handlers.ts`](electron/ipc/handlers.ts)，渲染进程可调用的接口类型定义在 [`electron/shared/types.ts`](electron/shared/types.ts) 的 `API` 接口中。其中 IDE 探测与写入（`ideScanner.ts`）按适配器的 `storage` 策略分派到四个存储后端（`sqliteStore` / `tomlStore` / `envStore` 与 JSON 原子写），写入前由 `processGuard.ts` 检测目标 IDE 是否在运行，凭证的 DPAPI 镜像加密由 `secureValue.ts`（封装 Electron `safeStorage`）完成。

前端页面（[`src/views/`](src/views)）：

- `Home.vue`：首页，IDE 卡片网格与状态徽章
- `Providers.vue`：供应商增删改查（含协议选择、连接测试、导入导出）
- `Snapshots.vue`：快照管理
- `Backups.vue`：备份中心
- `Logs.vue`：操作日志
- `Settings.vue`：主题、语言、开机自启、数据目录、更新等设置

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
│   │   ├── ideScanner.ts      # IDE 探测、状态检测与按策略应用/恢复
│   │   ├── provider.ts        # 协议转换与连接测试
│   │   ├── backup.ts          # 备份与恢复（原子写入）
│   │   ├── snapshot.ts        # 快照管理
│   │   ├── crypto.ts          # 自有存储的 AES-256-GCM 加密与脱敏
│   │   ├── secureValue.ts     # 目标 IDE 凭证的 DPAPI 镜像加解密（safeStorage）
│   │   ├── sqliteStore.ts     # sql.js 读写 state.vscdb（ItemTable）
│   │   ├── tomlStore.ts       # TOML 配置读写（Codex）
│   │   ├── envStore.ts        # .env KEY=VALUE 读写（Gemini CLI）
│   │   ├── processGuard.ts    # 写入前检测目标 IDE 进程是否运行
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
├── Doc/开发需求文档.md         # 产品需求文档 (PRD)
└── package.json
```

---

## 数据安全

- **本地优先**：所有数据（供应商、快照、备份、日志）均存储在本机用户数据目录，不上传任何服务器。
- **加密存储**：CodeSwitch 自有存储中的 API Key 使用 AES-256-GCM 加密，密钥由设备指纹（主机名 + MAC）经 scrypt 派生并绑定本机，存储格式为 `enc:<iv>:<tag>:<data>`。
- **格式镜像**：写入目标 IDE 数据库时，apiKey 会镜像其原生加密形态（Windows DPAPI / Electron `safeStorage`）——原值是密文就用同机制重新加密，原值是明文则写明文，绝不写入 IDE 无法解析的格式。
- **脱敏显示**：敏感信息在 UI 中默认脱敏为 `sk-****xxxx`。
- **原子写入**：文件写入采用「写临时文件 + 原子替换」策略，失败自动回滚。
- **写入前守卫**：SQLite / TOML 类 IDE 写入前会检测其进程是否在运行，未关闭时拒绝写入，避免配置被覆盖或损坏。
- **本机测试**：连接测试直接在本机发起，不经中转服务器。

> 由于加密密钥绑定设备指纹，加密后的数据在其他机器上无法解密，请在同一台设备上使用与迁移。

---

## 使用说明

1. **添加供应商**：进入「供应商」页面，填写名称、选择协议类型（OpenAI / Anthropic）、填入 API Key、Base URL 与 Model，保存。可点击「连接测试」验证可用性。
2. **应用配置**：在首页选中目标 IDE，选择要应用的供应商并点击「应用」。应用前会自动备份原配置；若目标为数据库 / TOML 类 IDE（如 Cursor、Windsurf、Codex），需先完全关闭该 IDE。
3. **辅助配置**：对于 GitHub Copilot 等无法安全直写的 IDE，点击「生成配置」获取对应格式的文本，一键复制后按提示在 IDE 设置界面手动粘贴。
4. **恢复默认**：在 IDE 详情或首页点击「恢复默认」，将配置还原为官方默认或此前的备份（危险操作需二次确认）。
5. **快照**：在「快照」页面保存当前所有 IDE 的供应商绑定，之后可一键切换。
6. **设置**：在「设置」页面切换主题、语言、开机自启、数据目录，或检查更新。

---

## 注意事项

- 多数 IDE 已支持一键写入；仅少数（如 GitHub Copilot）因密钥存于系统级密钥库而无法安全直写，需通过「生成配置」手动粘贴。
- 数据库 / TOML 类 IDE（Cursor、Windsurf、Trae、Kiro、CodeBuddy、Qoder、Codex）写入前必须先完全关闭对应 IDE，否则会被拒绝写入。其中 Cursor 还需 Pro 及以上订阅才支持自定义 API。
- 若选择的协议与目标 IDE 不兼容（例如某 IDE 仅支持 OpenAI 协议却应用了 Anthropic 供应商），应用前会给出明确提示。
- 应用或恢复配置后，通常需要重启对应 IDE（或重开终端）才能生效。
- 因加密密钥绑定设备指纹，加密后的数据在其他机器上无法解密；若需跨机迁移供应商，请使用「导出 / 导入」功能。
- 本项目 UI 强制规范：禁止使用任何 Emoji 字符，所有图标均来自矢量图标组件库。

---

## 许可证

本项目基于 MIT License 开源，详见 [LICENSE](LICENSE)。

> 文档中提及的 OpenAI、Anthropic、Cursor、Windsurf 等均为其各自持有者的商标，本项目仅用于兼容性说明，不代表任何官方关联或授权。
