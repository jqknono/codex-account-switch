# Account Tree Acceptance Cases

| 场景 | 前置条件 / 输入 | 预期结果 |
| --- | --- | --- |
| 账号详情展示精简 | 同时存在 local account 与 cloud account，并展开账号详情 | 不显示 `Source`、`Current device`、`Auto-refresh here`；保留 `Email`、`Plan`、token/quota 字段；cloud account 仍可显示 `Sync version`、`Updated`、`Auto-refresh device` 等同步诊断信息。 |
| quota 失败账号保留在来源分组 | `3` 个 cloud accounts 的 quota 请求失败，节点描述显示 `Quota unavailable` 或具体失败原因 | 这 `3` 个账号仍保留在 `Cloud Accounts` 中，不单独生成 `Quota Failed` 分组；失败态仅通过账号描述、tooltip 与详情字段表达。 |
