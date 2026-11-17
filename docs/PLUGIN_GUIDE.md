# 插件开发指南（协议 apiVersion 1）

本文写给想为 Plugin Harness 写插件的开发者。读完「5 分钟上手」就能跑起第一个插件；后面的章节是完整参考。

---

## 5 分钟上手

```bash
node bin/harness.js create ~/my-plugins/hello --id hello   # 1. 生成骨架
node bin/harness.js dev ~/my-plugins/hello                 # 2. 链接安装 + 启动 Web + 保存即重载
node bin/harness.js call hello.greet name=Alice            # 3. 另开终端直接调用（或在 Web「调试工具」页调用）
```

骨架里只有 4 个文件：

```
hello/
├── plugin.json     # 清单：身份、兼容版本、权限、贡献点、配置项
├── index.js        # 入口：导出 { activate, tools, hooks, providers }
├── harness.d.ts    # 类型提示（可选，零运行时依赖）
└── README.md
```

`harness dev` 会：

- 以「开发模式」链接安装：不复制目录，直接运行你的源码；
- 监听目录，保存后自动重启插件进程；
- 清单写错时立刻在终端报出具体字段；
- 新增权限时询问是否授予；
- 把插件日志实时打印到终端。

在 Web 界面打开插件详情，「调试工具」页可以绕过模型直接调用工具，「日志」页可以看到插件的 `console.log`。

调试小技巧：

- `HARNESS_VERBOSE=1 harness call …` 打印所有日志；
- `harness validate <目录>` 只校验清单；
- `harness logs <id> -f` 跟随日志文件。

---

## 插件是什么

插件是一个目录，包含一份**声明式清单**（`plugin.json`）和一个 **Node.js 入口**。宿主先读清单，因此在**不执行任何插件代码**的情况下就知道这些信息：

- 插件是谁、兼容哪个宿主版本；
- 想要哪些权限；
- 提供哪些工具、hook、Provider、配置项。

列表展示、权限审批、兼容性判断、配置表单都基于清单完成。

运行时，每个插件都在**独立的 Node 子进程**里运行，并带有 `--permission` 沙箱。插件与宿主通过 IPC 上的 JSON-RPC 通信。插件不需要依赖任何 SDK 包：入口导出一个普通对象即可。

---

## 清单 `plugin.json`

```jsonc
{
  "id": "workspace-notes",          // 必填，小写字母/数字/连字符，全局唯一
  "name": "工作区笔记",              // 必填，展示名
  "version": "1.1.0",               // 必填，semver；更新以它判断新旧
  "description": "…",
  "author": "…",
  "apiVersion": 1,                  // 必填，插件协议版本；宿主只接受相同的大版本
  "engines": { "harness": "^1.0.0" },  // 必填，兼容的宿主版本范围（^ ~ >= < || 均可）
  "main": "index.js",               // 默认 index.js
  "memoryMb": 128,                  // 可选，堆内存上限 32–256
  "activationTimeoutMs": 5000,      // 可选，activate 超时

  "permissions": {                  // 申请的权限，见「权限」
    "fs.read":  ["${workspace}"],
    "fs.write": ["${workspace}/notes"],
    "network":  ["api.example.com", "*.cdn.example.com"],
    "secrets":  ["MY_API_KEY"]
  },

  "contributes": {
    "tools": [ … ],                 // 给 Agent / 用户调用的工具
    "hooks": [ … ],                 // 订阅宿主事件，改写或拦截数据
    "providers": [ … ],             // Agent 的「大脑」（模型提供方）
    "settings": { … }               // 配置项，宿主自动生成表单
  }
}
```

### tools

```json
{
  "name": "search",
  "description": "Full-text search across notes…",
  "input": { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"] },
  "timeoutMs": 15000,
  "patterns": ["^搜索笔记\\s*(?<query>.+)$"],
  "examples": ["搜索笔记 插件"]
}
```

| 字段 | 作用 |
|---|---|
| `name` | 工具名；对外全名是 `<插件id>.<name>`（发给模型时为 `<插件id>__<name>`） |
| `description` | **模型靠它决定何时调用**，请写清楚做什么、返回什么 |
| `input` | JSON Schema（type/required/properties/enum/min/max）。宿主会先校验输入、转换类型，再交给插件 |
| `timeoutMs` | 单次调用超时，默认 15s，上限 120s |
| `patterns` | 可选。正则的命名分组即参数；离线的 rule-router Provider 用它理解自然语言 |
| `examples` | 可选。显示在对话页的「试试」按钮里 |

### hooks

```json
{ "event": "tool.afterCall", "priority": 10, "failMode": "closed", "timeoutMs": 3000 }
```

| 事件 | payload | 可以返回 |
|---|---|---|
| `chat.userMessage` | `{ text }` | `{ payload: { text } }` 改写；`{ block: true, reason }` 拦截 |
| `tool.beforeCall` | `{ tool, pluginId, input }` | 改写 `input` 或拦截 |
| `tool.afterCall` | `{ tool, pluginId, input, result: { content, data } }` | 改写 `result` 或拦截 |

所有 hook 都可以额外返回 `{ note: "…" }`，这句话会显示在对话记录里，让用户知道发生了什么。

- **priority**：数字小的先执行，默认 100。
- **failMode**：hook 失败、超时或插件不可用时怎么办。
  - `open`（默认）：跳过这个 hook，并在对话中提示。
  - `closed`：阻止这次操作。适合安全类 hook，攻击者不能靠「把它弄崩」来绕过检查。

### providers

```json
{ "name": "openrouter", "label": "OpenRouter", "description": "需要 OPENROUTER_API_KEY" }
```

Provider 决定 Agent 下一步「说什么 / 调用哪个工具」。用户在对话页选择当前 Provider。接口见下文 `complete()`。

### settings

```json
"settings": {
  "maxResults": { "type": "number", "title": "搜索结果上限", "default": 20, "min": 1, "max": 200 },
  "units":      { "type": "select", "title": "温度单位", "options": ["celsius", "fahrenheit"], "default": "celsius" },
  "enabled":    { "type": "boolean", "title": "…", "default": true },
  "notesDir":   { "type": "string", "title": "…", "default": "notes", "description": "表单下方的说明" }
}
```

- 宿主根据这份定义自动生成配置表单和 CLI 校验。
- 配置修改后**热更新**，不重启插件：`host.config` 会被原地替换，并触发 `onConfigChange` 回调。
- **不要把密钥放在 settings 里**，请使用 `secrets` 权限。

---

## 入口 `index.js`

```js
/** @type {import('./harness').Plugin} */
module.exports = {
  async activate(host) { /* 初始化；抛错 = 激活失败，用户会看到错误信息 */ },
  async deactivate() { /* 可选，进程退出前清理 */ },

  tools: {
    async search({ query }, ctx) {
      ctx.progress('正在搜索…');          // 实时显示在 UI 工具卡片上
      if (ctx.signal.aborted) return;      // 超时 / 取消时 signal 会 abort
      return { content: '给模型看的文本', data: [...], display: { type: 'table', columns: ['file', 'line'] } };
      // 也可以直接 return '字符串'；抛错 = 工具失败，错误消息会交给模型和用户
    },
  },

  hooks: {
    'tool.afterCall'({ result }) { return { payload: { result: { ...result, content: '…' } }, note: '已脱敏 1 处' }; },
  },

  providers: {
    openrouter: { async complete({ system, messages, tools }, ctx) { /* 见下 */ } },
  },
};
```

导出的对象也可以换成函数 `module.exports = (host) => ({ … })`。

**契约检查**：清单里声明的每个 tool / hook / provider，入口中都必须有同名实现，否则激活失败，并明确提示缺了哪一个。

### `host` 对象

| 成员 | 说明 |
|---|---|
| `host.config` | 当前配置（默认值已与用户值合并） |
| `host.workspace` | 用户工作区的绝对路径（读写仍需 fs 权限） |
| `host.dataDir` | 插件私有数据目录，**始终可读写**，无需申请 |
| `host.permissions` | 实际**已授予**的权限（变量已展开）。可据此优雅降级，见 weather 插件的 AQI |
| `host.log.debug/info/warn/error` | 写入宿主日志；`console.*` 也会被转发 |
| `host.fetch` / 全局 `fetch` | 由宿主代理，按 `network` 权限校验，支持重定向逐跳校验，响应上限 2MB |
| `host.secrets.get(name)` | 向宿主索取已授予的密钥（异步） |
| `host.onConfigChange(cb)` | 配置变更回调 |

### Provider 的 `complete()`

输入是与具体模型无关的中立格式：

```ts
messages: (
  | { role: 'user', content: string }
  | { role: 'assistant', content: string, toolCalls?: {id,name,input}[], raw?: any }
  | { role: 'tool', results: { toolCallId, name, content, isError }[] }
)[]
tools: { name, description, input_schema, patterns, examples }[]
```

返回以下两种之一：

```ts
{ type: 'text', text, raw? }
{ type: 'tool_calls', calls: [{ id, name, input }], text?, raw? }
```

`raw` 用于保存模型自己的原始回复，例如 OpenRouter 返回的 `reasoning_details`。宿主会原样存进历史，下一轮再交还给同一个 Provider。可以参考 `plugins/rule-router`（约 70 行）和 `plugins/openrouter-provider`。

---

## 权限

| 类型 | 值 | 如何强制执行 |
|---|---|---|
| `fs.read` | `${workspace}…`、`${pluginData}…` 或绝对路径（禁止 `/` 与 `..`） | Node `--permission --allow-fs-read`，**由运行时强制执行**，绕不过去 |
| `fs.write` | 同上 | `--allow-fs-write` |
| `network` | 主机名或 `*.domain` | 宿主代理 `fetch` 逐个请求校验；插件进程内的直接 socket（net/tls/http/dgram）被禁用 |
| `secrets` | 大写名称 | 插件进程的环境变量是干净的；只能通过 `host.secrets.get` 获取已授权的密钥 |
| 子进程 / worker / 原生扩展 | 不可申请 | Node 权限模型默认拒绝 |

要点：

- **申请 ≠ 获得**：用户安装时可以逐项取消，之后也可以随时撤销。撤销后插件进程立即带着新的权限重启。请根据 `host.permissions` 做降级处理，不要假设所有权限都在。
- **更新时新增的权限**不会自动授予。插件会进入「等待批准新权限」状态：用户批准后才启动；用户拒绝则按原权限运行。
- **能用 `${pluginData}` 就不要申请工作区写权限**，申请的权限越少，用户越愿意装。

---

## 生命周期

```
安装 ──▶ 校验清单 / 兼容性 ──▶ 用户审批权限 ──▶ 启用
                                             │
             ┌───────────────────────────────┘
             ▼
        spawn 子进程（--permission 沙箱，干净 env，内存上限）
             │  activate(host)    超时/抛错 ──▶ failed（不重试，展示原因）
             ▼
          running ──── 调用 tools / hooks / providers（各自超时）
             │           连续 2 次超时 ──▶ 强制重启进程
             │ 崩溃 / OOM
             ▼
          crashed ──▶ 退避重启 0.5s / 1s ──▶ 60s 内第 3 次崩溃 ──▶ failed（熔断，需手动重启）

配置修改 ──▶ config.changed（热更新，失败才重启）
权限 / 版本变化 ──▶ 优雅停止 → 以新参数重启
禁用 / 卸载 ──▶ deactivate()（1.5s）→ 断开 IPC → 1s 后 SIGKILL
```

## 限额（宿主默认值）

| 项目 | 值 |
|---|---|
| 激活超时 | 5s（清单可调） |
| 工具调用超时 | 15s（每个工具可调，上限 120s） |
| hook 超时 | 3s |
| Provider 超时 | 180s |
| 插件堆内存 | 128MB（清单可调 32–256） |
| 工具结果 | 20,000 字符（超出会截断并注明） |
| fetch 响应 | 2MB |
| Agent 单轮最大步数 | 8 |

---

## 兼容性与版本

- `apiVersion`：插件协议的大版本。宿主只加载与自己相同 `apiVersion` 的插件。只有在不兼容地修改协议时才会提升。
- `engines.harness`：插件声明兼容的宿主版本范围。不满足时，插件可以安装和查看，但**无法启用**，界面会明确显示原因（参见 `examples/legacy-plugin`）。
- 新增**可选**能力（新的 hook 事件、新的 `host` 成员）不会提升 `apiVersion`。插件应当检测能力是否存在再使用。

## 发布到插件目录

宿主扫描 `catalog.json` 中的 `sources` 目录，以及环境变量 `HARNESS_CATALOG` 中列出的目录（用 `:` 分隔），把每个含 `plugin.json` 的子目录当作一个可安装的插件版本：

- **同一 id 的多个版本**可以并存，默认安装最新版。
- 需要特定版本时，用 `harness install weather@1.0.0` 安装。
- 发布新版本时，把新目录放进来即可。用户会在「发现」页和 `harness outdated` 中看到可更新，同时看到新版申请了哪些新权限。

## 示例插件导读

| 插件 | 演示什么 |
|---|---|
| `plugins/workspace-notes` | 工具 + 文件权限 + 配置热更新 + 路径越界防护 + 表格展示 |
| `plugins/weather` | 网络权限 + 代理 fetch + 进度上报 + 卡片展示 + 按权限降级（v1.1 的 AQI） |
| `plugins/pii-guard` | 纯 hook、零权限、`failMode: closed` |
| `plugins/rule-router` | 不依赖任何模型的 Provider，用其他插件的 `patterns` 路由 |
| `plugins/openrouter-provider` | 真实 LLM Provider（OpenAI 兼容接口）：网络 + 密钥权限，原样回传 assistant 消息 |
| `examples/chaos-monkey` | 各种「作恶」，用来验证沙箱与稳定性 |
| `examples/legacy-plugin` | 版本不兼容时的表现 |
