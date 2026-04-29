# Account Tree Acceptance Cases

| 场景 | 前置条件 / 输入 | 预期结果 |
| --- | --- | --- |
| 账号详情展示精简 | 同时存在 local account 与 cloud account，并展开账号详情 | 不显示 `Source`、`Current device`、`Auto-refresh here`；保留 `Email`、`Plan`、token/quota 字段；cloud account 仍可显示 `Sync version`、`Updated`、`Auto-refresh device` 等同步诊断信息。 |
