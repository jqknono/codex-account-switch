# Synced Cloud State 验收用例

| 场景 | 前置条件 / 输入 | 预期结果 |
| --- | --- | --- |
| 缺失 payload 的索引保留 | `accountNames/providerNames` 中列出了名称，但独立 key、聚合 payload、旧设置 payload 暂未同步到本机 | 激活时保留这些 names-only 条目并继续注册独立 key 到 `setKeysForSync`。 |
| 延迟到达的 cloud payload | 第二台机器先收到 `apple1` 的索引，随后才收到 `codex-account-switch.syncedCloudAccount.v1.apple1` payload | `apple1` payload 到达前显示为 `Payload pending`，不显示为 invalid；payload 到达后刷新列表即可显示为可用 cloud account。 |
| 迁移到 cloud 后 payload 不可读 | local account `apple1` 执行 Move Account To Cloud，写入独立 payload 后同窗口读回失败或 payload 缺失 | 命令失败并提示 cloud 写入无法验证；本地 `auth_apple1.json` 保留，不删除 local 副本。 |
| 正常迁移到 cloud | local account `apple1` 执行 Move Account To Cloud，独立 payload 可读回 | 删除本地 `auth_apple1.json`，cloud account 进入 ready 状态，索引和独立 payload 一起参与 Settings Sync。 |
