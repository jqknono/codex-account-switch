# Synced Cloud State 验收用例

| 场景 | 前置条件 / 输入 | 预期结果 |
| --- | --- | --- |
| 缺失 payload 的索引保留 | `accountNames/providerNames` 中列出了名称，但独立 key、聚合 payload、旧设置 payload 暂未同步到本机 | 激活时保留这些 names-only 条目并继续注册独立 key 到 `setKeysForSync`。 |
| 延迟到达的 cloud payload | 第二台机器先收到 `apple1` 的索引，随后才收到 `codex-account-switch.syncedCloudAccount.v1.apple1` payload | `apple1` payload 到达前显示为 `Payload pending`，不显示为 invalid；payload 到达后刷新列表即可显示为可用 cloud account。 |
| 普通 cloud 新增缺少显式基线 | 用户通过 Add Account 直接把 `alice1` 保存到 cloud，但写入调用没有给出“期望当前不存在”的同步基线 | 命令失败并提示 cloud 写入缺少显式同步基线；不写入 payload，不把保存结果当作成功。 |
| 直接新增 cloud account 后 payload 不可读 | 用户通过 Add Account 直接把 `bob1990` 保存到 cloud，独立 payload 写入后同窗口读回失败或 payload 缺失 | 命令失败并提示 cloud 写入无法验证；不把保存结果当作成功；保留对应保护副本供后续显式恢复。 |
| 迁移到 cloud 后 payload 不可读 | local account `apple1` 执行 Move Account To Cloud，写入独立 payload 后同窗口读回失败或 payload 缺失 | 命令失败并提示 cloud 写入无法验证；本地 `auth_apple1.json` 保留，不删除 local 副本。 |
| 正常迁移到 cloud | local account `apple1` 执行 Move Account To Cloud，独立 payload 可读回，保护副本可写入 | 删除本地 `auth_apple1.json`，cloud account 进入 ready 状态，索引和独立 payload 一起参与 Settings Sync，并保留加密保护副本。 |
| 同步合并后 payload 丢失 | `bob1990` 已迁移到 cloud 且有保护副本，随后 VS Code extension state 合并为 index-only：`accountNames` 包含 `bob1990`，但 `codex-account-switch.syncedCloudAccount.v1.bob1990` 缺失 | `bob1990` 显示 `Payload pending` 和可恢复状态，不自动写回 payload，不自动切换到本地。 |
| 同步合并后 index 和 payload 都丢失 | `fanfan` 已迁移到 cloud 且有保护副本，随后 VS Code extension state 合并后 `accountNames` 和 `codex-account-switch.syncedCloudAccount.v1.fanfan` 都缺失 | `fanfan` 仍从保护副本目录显示为 `Payload pending` 和可恢复状态，不自动写回 payload；用户可执行显式恢复。 |
| 版本化 marker 遇到缺失 payload | 当前激活的是 cloud account `stale`，marker 记录了旧版本，但 synced payload 已缺失 | 切换账号、同步当前 auth、刷新 token 时都不自动重建 payload，而是返回 payload missing / refresh after sync；除显式恢复外不写回。 |
| 显式恢复保护副本 | 对可恢复的 `bob1990` 执行 Restore Cloud Payload From Protected Backup | 扩展把保护副本中的加密 payload 写回独立 cloud key，通过普通 cloud 读取路径验证后，`bob1990` 回到 ready 状态。 |
| 删除 cloud account 写 tombstone | `cloud-old` 当前存在于 cloud，另一台机器仍保留旧 payload 快照 | 删除时写入更高 `entryVersion` 的 tombstone，并清理保护副本；旧 payload 后续同步回来时不会让 `cloud-old` 重新出现在列表中。 |
| Provider 删除写 tombstone | cloud provider `proxy` 当前存在于 cloud，另一台机器仍保留旧 provider payload 快照 | 删除时写入更高 `entryVersion` 的 tombstone；旧 provider payload 后续同步回来时不会让 `proxy` 重新出现在列表中。 |
| 清理保护副本 | cloud account 被删除，或执行 Move Account To Local 成功 | 对应 `globalStorage/cloud-account-recovery/accounts/{name}.json` 被删除。 |
