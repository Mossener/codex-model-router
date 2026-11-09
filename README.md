# codex-model-router

[中文](#中文文档) · [English](#english)

一个跑在本机的 **Responses API 统一网关**，把多个上游（自建 / 第三方 API / 多账号号池 / Google Gemini）收敛成一个 `http://127.0.0.1:18179/v1` 入口，供 Codex CLI 一类只认 Responses API 的客户端使用。

它最初是为了解决一个很具体的问题：**Codex 每一轮都会把整段对话重新上传**，于是长会话会依次撞上三个墙 —— 客户端的内存量、本地网关的读入上限、上游 nginx 的 `client_max_body_size`。这个项目把这三层都处理掉了，并且保证错误尽量不落到上游那边。

```
Codex CLI ──► 127.0.0.1:18179 (router.mjs)
                 │
                 ├─ original     → 你自己配置的默认上游（原样透传）
                 ├─ opencode     → opencode.ai
                 ├─ agentrouter  → agentrouter.org（多账号号池，自动轮转/冷却）
                 ├─ gemini       → Google Gemini（Responses ⇄ chat/completions 双向翻译）
                 └─ antigravity  → 本机 Antigravity Manager
             ▲
             └── RouterHost.exe（看门狗 + 托盘，崩溃自动拉起）
```

## 中文文档
### 特性

- **按模型 id 路由**：映射表里的模型走号池，其余原样透传给默认上游，行为与直连一致。
- **AgentRouter 账号池**：新会话在可用账号间轮转，线程绑定滑动过期；凭据失效或余额不足冷却 30 分钟；429/供给限制只临时避开该账号并可等待重开。
- **大请求自动重建**：撞击上限时按「损失从小到大」逐级压缩，而不是直接报错（详见下文）。
- **截图降质而非删除**：纯 JS 实现 PNG 解码 / 盒式缩放 / 重编码，无原生依赖。
- **本机安全边界**：只接受回环地址、校验 Host 与 Origin；日志只记状态码、字节数、token 数量与预定义错误分类，**不保存请求/响应正文**。
- **用量面板**：请求统计、模型排行、缓存命中率、余额与消耗趋势（纯静态页面，无外部依赖）。
- **看门狗**：C# 托管的父进程监控 `/health`，worker 真挂了才拉起；忙（例如正在处理 64 MiB 重放）不算挂。

### 目录结构

```
router.mjs              路由核心：鉴权、路由、账号池调度、重建阶梯、请求日志
dashboard.mjs           用量面板的 HTTP 层与统计接口
account-pool.mjs        账号池：轮转、线程绑定、冷却、退避
account-settings.mjs    账号启用/停用的持久化
gemini.mjs              Responses ⇄ chat/completions 翻译与流式事件转换
image-shrink.mjs        PNG 解码 / 缩放 / 重编码（无依赖）
response-observer.mjs   流式响应观察：用量、终态事件、失败分类
prefix-reuse.mjs        提示词前缀复用度量（缓存命中率解释）
usage-metrics.mjs       用量聚合
balance-spend.mjs       余额消耗增量计算
security-metadata.mjs   日志字段白名单（唯一允许写盘的事件形状）
sanitize-history.mjs    历史日志清理
check-catalog.mjs       Codex 模型目录检查
patch-catalog.mjs       Codex 模型目录补丁
RouterHost.cs           Windows 看门狗 + 托盘 + `--token` 凭据助手
build.ps1               编译 RouterHost.cs → CodexModelRouter.exe / RouterToken.exe
reload-gateway.ps1      校验并热重载 worker
web/                    内置面板（index.html / app.js / usage.js / styles.css）
*.test.mjs              测试（node:test，无第三方依赖）
```

### 快速开始

依赖：

- Windows（看门狗是 .NET Framework 4.x 程序；核心路由器本身跨平台）
- Node.js 20+
- 编译看门狗需要 `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`（系统自带）

```powershell
git clone <this repo>
cd codex-model-router

# 1) 编译看门狗（可选，直接用 node router.mjs 也能跑）
.\build.ps1

# 2) 配置：复制模板后按需修改，务必不要提交 settings.json
Copy-Item settings.example.json settings.json
notepad settings.json

# 3) 启动
.\CodexModelRouter.exe --watch --home "$PWD"
# 或者前台直接跑核心：
node router.mjs
```

健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:18179/health
```

面板：`http://127.0.0.1:18179/dashboard`

### 配置

`settings.json` 全部字段见 `settings.example.json`，关键项：

| 字段 | 说明 |
|---|---|
| `port` | 监听端口，默认 `18179`（只绑 `127.0.0.1`） |
| `defaultBaseUrl` | `original` 路由的上游，必须兼容 Responses API |
| `authPath` | Codex 的 `auth.json`；其中的 `OPENAI_API_KEY` 就是本网关的客户端令牌 |
| `catalogPath` / `activeCatalogPath` | Codex 模型目录文件 |
| `agentrouterBaseUrl` / `agentrouterKeyPath` | AgentRouter 与它的默认 Key |
| `agentrouterAccountsPath` | 账号池文件（含每账号 Key，**不要提交**） |
| `agentrouterProxy` | 访问 AgentRouter 的本地代理，例如 `http://127.0.0.1:10808` |
| `agentrouterModels` | 形如 `"gpt-6.1-sol-ar": "gpt-6.1-sol"`，命中即走号池 |
| `opencodeBaseUrl` / `opencodeKeyPath` | opencode 线路 |
| `geminiBaseUrl` / `geminiKeyPath` / `geminiModels` | Gemini 线路 |
| `antigravityBaseUrl` / `antigravityKeyPath` | 本机 Antigravity Manager |
| `dashboardEnabled` | 是否挂载 `/dashboard` |
| `instanceId` | 网关身份标识；换实例时 `reload-gateway.ps1` 用它确认自己连的是哪个进程 |

### 接入 Codex

```toml
# ~/.codex/config.toml
model = "gpt-6.1-sol"
model_provider = "local-gateway"

[model_providers.local-gateway]
name = "本机统一网关"
wire_api = "responses"
base_url = "http://127.0.0.1:18179/v1"
supports_websockets = false

[model_providers.local-gateway.auth]
command = "C:/path/to/RouterToken.exe"
args = ["--token"]
refresh_interval_ms = 5000
timeout_ms = 15000
```

`RouterToken.exe --token` 只是把 `authPath` 里的 `OPENAI_API_KEY` 读出来打印，客户端因此不需要再单独保存一份令牌。

### 大请求是怎么被处理的

这是整个项目里最费笔墨的部分，因为上游会以三种完全不同的方式拒绝一个过大的重放：

| 现象 | 产生者 | 处理 |
|---|---|---|
| 本地直接拒绝（`route: local`） | 网关读入上限（默认 64 MiB） | 逐级重建，压不下去才拒绝 |
| `413 Payload Too Large` | 上游 nginx `client_max_body_size`（agentrouter 是 20 MiB） | 目标按 `上限 × 0.8` 重建后重发一次 |
| `400 ... encrypted_content` | 另一台上游签发的 reasoning 句柄 | 剥掉句柄与 `item.id` 后重发一次 |

重建阶梯（每一步都只在还没达标时才做，达标即停）：

1. 剥掉另一资源签发的 reasoning 句柄、`item.id`、`item_reference` 与 `include`
2. 只保留最新 2 张截图，更早的换成一行可读说明
3. 把剩下的截图**降到 1/2 分辨率**，必要时再降到 1/4
4. 只保留最新 1 张截图
5. 把旧工具输出截到 4 KB
6. 最后的兜底：所有截图换成说明文字

关键在于顺序：**先丢过时画面，再降画质，最后才彻底放弃**。一张能看清的半分辨率截图，对模型的价值远高于没有截图。

实测（agentrouter 16 MiB 目标）：

- 12 张 1280×800 截图、21.6 MiB → **3.60 MiB / 76 ms**，保留最新 2 张，分辨率不变
- 2 张 4K 截图、50.1 MiB → **11.77 MiB / 1.2 s**，两张都保留，3840×2160 → 1920×1080

`image-shrink.mjs` 只处理它能正确解码的 PNG（8-bit、非隔行、灰/RGB/调色板/灰+alpha/RGBA，五种行滤波全支持）；认不出的图片**原样保留**，绝不写坏。

### 测试

```powershell
node --test *.test.mjs
```

294 项测试，覆盖路由、账号池、面板、日志脱敏、PNG 编解码、看门狗。全部无第三方依赖，`node:test` 直接跑。

看门狗相关的用例需要先 `.\build.ps1`，未编译时自动跳过。

### 安全与隐私

- 只监听 `127.0.0.1`，只接受回环来源；面板额外校验 `Host`、`Origin`、`Sec-Fetch-Site` 与自定义请求头。
- 请求日志与失败诊断只写状态码、字节数、重建等级、token 数量、预定义错误分类（`security-metadata.mjs` 的白名单），**不写正文、不写上游错误原文、不写凭据**。
- `keys/`、`settings.json`、`account-pool.json`、日志与历史都已列入 `.gitignore`。**发布前请确认它们没有被提交。**
- 本机同一用户的其它进程仍然能读到这些文件；网关不是操作系统级隔离。

### 已知限制

- 余额/签到面板依赖一个外部的签到项目（`checkInDirectory`），本仓库不含该项目；不配置时相关按钮不可用，路由功能不受影响。
- 可选的现代化面板（`web-axonhub/`）是另一个前端工程的构建产物，未包含在本仓库；缺少时自动回退到内置的 `web/` 页面。
- 成本统计未接入权威计费数据，只有 token 与缓存读数。
- 账号池分配不按余额加权。

## License

[MIT](LICENSE)

## English

A local **Responses API gateway** for Codex-style clients. It multiplexes several upstreams (a default passthrough, an opencode route, an AgentRouter account pool, Google Gemini via bidirectional translation, and a local Antigravity manager) behind one `http://127.0.0.1:18179/v1` endpoint.

Because Codex re-uploads the whole thread every turn, long sessions hit three different limits. The gateway answers all three, and prefers rebuilding a request over surfacing an error:

1. Local read cap → progressive rebuild (strip foreign handles → keep newest screenshots → **halve screenshot resolution** → keep one → truncate old tool output → replace images with notes).
2. Upstream `413` → rebuild against `limit × 0.8` and resend once.
3. `400 encrypted_content` (a reasoning blob minted by another upstream resource) → strip handles and retry once.

Screenshots are re-encoded smaller in pure JavaScript (`image-shrink.mjs`: PNG decode, box-filter downscale, re-encode) rather than dropped, and images it cannot decode are left untouched.

Run `node --test *.test.mjs` for the 294-test suite, `.\build.ps1` to compile the Windows watchdog, and see `settings.example.json` for configuration. Secrets never belong in the repository — `keys/`, `settings.json`, `account-pool.json` and request logs are all ignored.

MIT licensed.
