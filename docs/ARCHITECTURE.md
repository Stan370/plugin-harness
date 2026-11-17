# 架构与设计决策

## 总览

```
                ┌───────────── 本机 127.0.0.1 ─────────────┐
 浏览器 Web UI ─┤ HTTP + 一次性 token + Host/Origin 校验 + CSP │
 harness CLI ───┤                                           │
                └──────────────┬────────────────────────────┘
                               ▼
┌──────────────────────── Host（宿主进程）──────────────────────────┐
│ Registry   安装/更新/启用/配置/授权 —— 只读写 state.json           │
│ Host       reconcile(): 让运行中的进程与 state.json 保持一致      │
│            broker: 网络代理（按 host 白名单）/ 密钥下发 / 审计日志 │
│            invokeTool(): 参数校验 → beforeCall hooks → 调用 →     │
│                          afterCall hooks → 截断 → 审计            │
│ Agent      provider.complete() ↔ tools 循环（最多 8 步）           │
│ LogStore   内存环形缓冲 + 每插件日志文件；SSE 推送                 │
└───────┬───────────────────┬───────────────────┬──────────────────┘
        │ IPC JSON-RPC      │                   │
┌───────▼──────┐   ┌────────▼─────┐    ┌────────▼─────┐
│ plugin proc  │   │ plugin proc  │ …  │ plugin proc  │   每个插件一个 Node 进程
│ --permission │   │ --permission │    │ --permission │   fs 白名单、禁子进程/worker/addon
│ runtime.js   │   │ runtime.js   │    │ runtime.js   │   socket 禁用、fetch 走宿主
│ 插件代码     │   │ 插件代码     │    │ 插件代码     │   干净 env、堆上限
└──────────────┘   └──────────────┘    └──────────────┘
```

代码量：宿主 + CLI 约 3,000 行，Web UI（JS + CSS）约 1,200 行，零 npm 依赖。

## 关键决策

### 1. 宿主不内置任何「功能」

宿主只提供机制，所有能力都来自插件：

- **工具**：workspace-notes、weather
- **数据治理**：pii-guard
- **Agent 的决策层**：rule-router 和 openrouter-provider 都是插件

这样就能证明插件机制确实能扩展宿主。全部禁用后，对话页只剩 `/help`，而且会提示「没有选择 Provider」。

Provider 也是插件，这一点尤其重要。它让同一套工具既可以离线、可预测地运行（便于演示与测试），也可以交给真实的 LLM。

### 2. 清单优先（declarative-first）

工具的 schema、hook 订阅、Provider、配置项、权限都写在 `plugin.json` 里。宿主**不执行插件代码**就能完成这些事：

- 列表展示、安装前的权限审批、兼容性判断；
- 生成配置表单；
- 校验工具输入。

插件崩溃时，用户仍然能看到它是什么、要了什么权限、哪里坏了。运行时如果实现与清单对不上，激活就会失败，所以清单不会「说谎」。

### 3. 每个插件一个进程

| 方案 | 隔离 | 崩溃影响 | 权限强制 | 成本 |
|---|---|---|---|---|
| 同进程 `require` | 无 | 拖垮宿主 | 无 | 最低 |
| `vm` / ShadowRealm | 弱（vm 不是安全边界） | 同进程 | 弱 | 低 |
| worker_threads | 内存独立，共享进程 | OOM、`process.exit` 会波及宿主 | Node 权限模型是进程级的 | 中 |
| **子进程 + `--permission`** | **OS 进程 + 运行时文件沙箱** | **只影响自己** | **fs/子进程/worker/addon 由运行时强制** | 实测每个插件约 41MB RSS，单个插件冷启动约 25ms |
| 容器 / WASM | 最强 | 只影响自己 | 最强 | 依赖重，开发体验差 |

我选了子进程方案。对一个「本地、单用户、插件数个到十几个」的 Harness 来说，这是隔离强度和开发体验之间的最佳点。插件开发者写的就是普通 Node 代码，`fs`、`fetch`、`console` 都照常可用。

### 4. 宿主是唯一的出口（capability broker）

- **文件**：由 Node 运行时按授权路径强制执行。宿主把 `${workspace}` 等变量解析为 realpath 后传给 `--allow-fs-*`。
- **网络**：Node 24 的权限模型还不能限制网络，所以分两层：
  1. 插件进程启动时，runtime 先禁用 `net.Socket#connect` 和 `dgram`，再加载插件代码。这些禁用会覆盖 http/https/tls/fetch/WebSocket 的底层；`process.binding` 已被权限模型禁止。
  2. 全局 `fetch` 被替换成 IPC 代理。宿主逐个请求校验主机名，重定向逐跳校验，响应大小有上限，每个请求都写入审计日志。
- **密钥**：子进程 env 只有 `HARNESS_PLUGIN_ID / NODE_ENV / TZ / LANG`。密钥必须通过 `host.secrets.get()` 获取，宿主检查授权并记录审计；密钥文件权限为 0600。Web UI 对密钥只写不读。

### 5. 声明式状态 + reconcile

`state.json` 是唯一的真相源，CLI 和 Web 都只修改它（原子写）。宿主在两种时机执行 `reconcile()`：自己改完之后，以及 `watchFile` 发现 CLI 修改之后。每个插件按签名（路径、版本、授权、工作区）比较期望状态与实际进程：

- 签名变化：重启；
- 只有配置变化：热更新；
- 不再期望运行：停止。

正因为如此，在服务运行时执行 `harness disable weather`，约 1 秒后 Web 上的状态就会自动同步。

## 稳定性机制

| 故障 | 处理 | 用户看到什么 |
|---|---|---|
| 清单无效 | 拒绝安装 / 启用 | 逐条字段级错误 |
| 版本不兼容 | 可安装、不可启用 | 「插件要求宿主版本 ^0.9.0，当前宿主为 1.0.0」 |
| 激活抛错 / 超时 | `failed`，**不重试**（确定性错误） | 错误消息 + stderr 末尾 15 行 + 「重新启动」 |
| 工具超时 | 本次调用失败，并向插件发送 cancel（`ctx.signal`） | 工具卡片显示 `timeout` |
| 连续 2 次超时（如死循环） | SIGKILL 回收进程，然后自动重启 | 日志：「连续 2 次超时，强制重启」 |
| 崩溃 / OOM | 正在进行的调用立即失败；退避 0.5s、1s 后重启 | 「插件崩溃：内存超出上限（64MB）被终止」 |
| 60s 内第 3 次崩溃 | 熔断，停止自动重启 | 红色状态 +「熔断」说明 + 手动重启按钮 |
| hook 失败 | `open` 时跳过并提示；`closed` 时阻止操作 | 对话中的 note / 错误 |
| Provider 不可用 | 本轮报错，历史回滚到上一个合法状态 | 提示具体原因与修复办法 |
| 工具结果过大 | 截断到 20k 字符并注明 | — |
| Agent 死循环 | 单轮最多 8 步 | 「已达到单轮最大步数」 |
| `state.json` 损坏 | 备份为 `.corrupt-*` 后重置 | 启动警告 |

这些情况都有自动化测试覆盖（`test/host.test.js`），由 `examples/chaos-monkey` 真实触发。

## Web 服务的安全

- 只监听 `127.0.0.1`。
- 每次启动生成一个随机 token，放在 URL 的 `#fragment` 里：fragment 不会进入请求日志和 Referer。前端读取后存入 sessionStorage，并把它从地址栏移除。
- `Host` 头必须是 `127.0.0.1:端口` 或 `localhost:端口`，以防御 DNS 重绑定；如果带 `Origin` 头，必须同源，以防御 CSRF。
- 严格的 CSP：`script-src 'self'`，不允许内联脚本。所有插件提供的字符串都以 `textContent` 渲染，从不使用 `innerHTML`。恶意插件无法通过工具结果对 UI 做 XSS。
- 插件**不能**向 UI 注入 JS。插件影响 UI 的方式是声明式的：settings 生成表单，结果用 `display: table/card` 展示，`examples` 生成快捷按钮，`note` 显示在对话中。

## 威胁模型与已知边界

**已防御**：

- 插件读写授权之外的文件；
- 插件启动子进程或 worker、加载原生扩展；
- 插件直连未授权的主机，或通过重定向绕过白名单；
- 插件从 env 偷取密钥，或读取未授权的密钥；
- 单个插件崩溃、卡死或内存泄漏拖垮宿主；
- 其他网站对本地服务发起请求。

**未防御 / 需要说明**：

1. **网络隔离是进程内防护，不是 OS 级隔离。** 文件沙箱由 Node 运行时强制执行，而网络限制依赖 runtime 在插件代码之前打的补丁。目前已知的绕过路径（`process.binding`、worker、子进程、addon）都已被权限模型封住，但它的强度仍然弱于 OS 防火墙。另外 DNS 查询没有被拦截，理论上可以把数据编码进 DNS 请求外泄。对于完全不可信的插件，建议在此之上叠加 OS 沙箱（macOS `sandbox-exec`、Linux namespaces / seccomp）或容器。
2. **密钥一旦授予，插件就拿到了明文**，宿主无法阻止它在授权的网络范围内使用。降低风险的办法是让用户在安装和设置页明确看到「哪个插件用哪个密钥」，并通过审计日志追溯。
3. **没有插件签名或来源校验**。插件目录在本地，信任来自用户的安装行为。
4. **CPU 没有配额**，只能靠「连续超时就回收」间接控制。
5. Provider 收到的工具描述来自插件，恶意插件可能借此做提示注入。pii-guard 这类 hook 可以缓解，但不能根治。

## 协议（IPC JSON-RPC，`serialization: 'json'`）

宿主 → 插件：

| method | params | 说明 |
|---|---|---|
| `activate` | id, version, hostVersion, apiVersion, config, workspace, dataDir, permissions, contributes | 加载入口、检查契约、调用 `activate(host)` |
| `tool.invoke` | name, input, callId | — |
| `hook.run` | event, payload | — |
| `provider.complete` | name, request | — |
| `config.changed` | config | 热更新 |
| `deactivate` | — | — |
| `cancel`（通知） | id | 调用超时，`ctx.signal` 被 abort |

插件 → 宿主：

| method | 说明 |
|---|---|
| `http.fetch`（请求） | 网络代理，按授权校验 |
| `secrets.get`（请求） | 密钥下发，按授权校验 |
| `log`（通知） | `console.*` 和 `host.log` |
| `progress`（通知） | 工具进度，实时推送到 UI |

响应格式：成功为 `{ id, result }`，失败为 `{ id, error: { message, code, resource } }`。宿主会把 `ERR_ACCESS_DENIED` 等底层错误翻译成用户能理解的说明，例如「插件 X 尝试访问未授权的文件 /etc/passwd」。

## 目录与数据

```
.harness-data/            （HARNESS_HOME，可覆盖）
├── state.json            已安装插件、授权、配置、当前 Provider
├── secrets.json          0600
├── server.json           运行中的 Web 服务 pid / 端口（不含 token）
├── plugins/<id>/<ver>/   安装副本（dev 模式直接指向源码目录）
├── data/<id>/            插件私有数据（始终可写；卸载时默认保留）
├── logs/<id>.log         每个插件的日志（超过 1MB 轮转）
├── logs/audit.jsonl      工具调用、网络、密钥访问审计
├── sessions/*.json       对话记录
└── workspace/            用户工作区（HARNESS_WORKSPACE 可覆盖）
```
