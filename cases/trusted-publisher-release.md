# CLI 本地发布验收用例

| 场景 | 前置条件 / 输入 | 预期结果 |
| --- | --- | --- |
| 发布稳定版 CLI | `main` 分支已提交 `packages/cli/package.json` 版本，例如 `1.8.0`，执行 `npm run publish:cli` | 本地脚本完成依赖安装、CLI 测试与 `npm publish`，并将 `codex-account-switch@1.8.0` 发布到 npm 的 `latest` tag。 |
| 发布预发布 CLI | `packages/cli/package.json` 版本为预发布版本，例如 `1.9.0-beta.1`，执行 `npm run publish:cli` | 本地脚本将该版本发布到 npm 的 `next` tag，不覆盖 `latest`。 |
| 指定版本与包版本不匹配 | 执行 `npm run publish:cli -- -Version 1.8.0`，但 `packages/cli/package.json` 版本不是 `1.8.0` | 脚本在发布前失败，npm 上不会出现错误版本。 |
| 非主分支误发版 | 当前分支不是 `main`，直接执行 `npm run publish:cli` | 本地脚本拒绝发布，并提示需要从 `main` 分支执行。 |
| 工作区有未提交改动 | 仓库存在未提交文件，执行 `npm run publish:cli` | 本地脚本拒绝发布，避免本地源码与已发布包不一致。 |
| 本地 npm 凭证不可用 | 本地执行 `npm run publish:cli:check` 或 `npm run publish:cli`，且 `npm whoami` 或 `npm ping` 失败 | 脚本在发布前失败，并提示先执行 `npm login` 或配置本地 npm token。 |
