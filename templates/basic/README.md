# {{name}}

由 `harness create` 生成的插件骨架。

```bash
harness dev .          # 链接安装 + 启动 Web + 改代码自动重载
harness validate .     # 只校验清单
harness call {{id}}.greet name=Alice
```

- `plugin.json`：清单（身份、兼容版本、权限、贡献点、配置项）
- `index.js`：入口，导出 `{ activate, tools, hooks, providers }`
- `harness.d.ts`：类型提示（可选）

完整协议见宿主仓库 `docs/PLUGIN_GUIDE.md`。
