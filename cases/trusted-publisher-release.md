# Trusted Publisher Release Acceptance Cases

| 场景 | 前置条件 / 输入 | 预期结果 |
| --- | --- | --- |
| 发布稳定版 CLI | `main` 分支已提交 `packages/cli/package.json` 版本，例如 `1.8.0`，执行 `npm run publish:cli` | 本地创建并推送 `cli-v1.8.0` tag，GitHub Actions 使用 Trusted Publisher 将 `codex-account-switch@1.8.0` 发布到 npm 的 `latest` tag。 |
| 发布预发布 CLI | `packages/cli/package.json` 版本为预发布版本，例如 `1.9.0-beta.1`，执行 `npm run publish:cli` | GitHub Actions 将该版本发布到 npm 的 `next` tag，不覆盖 `latest`。 |
| 版本与 tag 不匹配 | workflow 由 `cli-v1.8.0` 触发，但 `packages/cli/package.json` 版本不是 `1.8.0` | workflow 在发布前失败，npm 上不会出现错误版本。 |
| 非主分支误发版 | 当前分支不是 `main`，直接执行 `npm run publish:cli` | 本地脚本拒绝创建发布 tag，并提示需要从 `main` 分支执行。 |
| 工作区有未提交改动 | 仓库存在未提交文件，执行 `npm run publish:cli` | 本地脚本拒绝发布，避免 GitHub 发布的源码与本地预期不一致。 |
