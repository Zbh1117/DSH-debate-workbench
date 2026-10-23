# 参与贡献

感谢你愿意改进「辩论工作台」。这个仓库是 DSH（DeepSeek Harness）插件，欢迎 Issue 与 Pull Request。

## 本地开发

1. 安装 DSH 桌面版（本项目在 `0.2.0-rc.2` 上开发验证）。
2. 把本仓库装进你的 DSH profile：

   ```
   plugin_manager install_bundle target=file:<本仓库绝对路径>
   ```

3. 重启一次 DSH：Host 代码（`lib/`）与客户端加载器（`assets/client.js`）改动需要重启；
   之后只改界面（`assets/ui.js`）会自动热更新，不必再重启。
4. 跑自测（不需要 DSH 运行时）：

   ```powershell
   node tests/apply.test.mjs
   node tests/logic.test.mjs
   node tests/api.test.mjs
   node tests/client.test.mjs
   ```

   或者 `npm test`（package.json 里的 `scripts.test` 会串起四套）。

## 代码约定

- 零运行时依赖：只允许 Node 内置模块（`fs` / `path` / `crypto` 等）与本包内文件。
- 宿主工具返回值必须是 **lossless JSON**（不能含 `undefined` / 函数）；`lib/tools.js` 的 `lossless()` 统一兜底。
- 数据模型以 DebateWeaver 的 `ProjectExportBundle` 为唯一事实来源；新增字段要通过 `data.details` 之类的自由字段，避免破坏 app 兼容。
- 界面侧不引入 JSX/打包器：客户端插件只有有限的种子模块，`assets/ui.js` 用 `React.createElement` 原生写法。
- 证据相关硬规则：**不编造**数据、年份、机构、论文标题、法条；证据卡必须有 `source` 或 `url`。

## 提交

- 一个 PR 只做一件事，附上复现/验证方式。
- 改协议或数据结构时同步更新 `CHANGELOG.md` 与 `README.md`。
- 提交前确认四套自测全绿。

## 许可证

提交贡献即表示你同意以本仓库的 MIT 许可证发布你的贡献。
