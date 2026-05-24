# Token Auto Refresh Acceptance Cases

| 场景 | 前置条件 / 输入 | 预期结果 |
| --- | --- | --- |
| 默认开启自动刷新 token | 用户未修改 `codex-account-switch.tokenAutoUpdate` | 后台 timer 会在轮转命中账号时检查 token 剩余有效期，并在剩余 `< 120h` 或已过期时刷新 token。 |
| 关闭自动刷新 token | 用户把 `codex-account-switch.tokenAutoUpdate` 设置为 `false` | 后台 timer 跳过 token maintenance，只继续执行独立的 quota 轮转刷新。 |
| 本地账号 token 临近过期 | local saved account 的 access token 或可解码 refresh token 剩余有效期 `< 120h`，后台轮转命中该账号 | 插件自动刷新 token，并写回 saved auth；如果该账号当前正在使用，则 `auth.json` 也同步更新。 |
| cloud 账号 token 临近过期 | cloud saved account 的 token 剩余有效期 `< 120h`，后台轮转命中该账号 | 插件自动刷新 token，并写回 synced cloud state；不按机器或旧设备字段限制。 |
| token endpoint 要求重新登录 | 后台 token 刷新返回 `refresh_token_reused`、`refresh_token_invalidated` 或等价 sign-in-again 错误 | 账号树显示 `Relogin required`；当前轮跳过该账号 quota 查询。 |
| quota API 拒绝当前 token | quota 刷新返回 `401/403`，包括 `error.code = token_invalidated` | quota 结果标记为 `quota_token_rejected`；账号树显示 `Quota API rejected current token` 或 `Quota API rejected current token (token_invalidated)`，不误提示 `Relogin required`；已有 quota cache 只作为回退展示。 |
| quota 手动刷新 | 用户手动执行 `Refresh Quota` | 不触发 token 刷新，仅刷新 quota。 |
| cloud token 刷新前快照过期 | 用户对 cloud account 执行 `Refresh Token`，但当前窗口持有的账号节点仍是旧 `syncVersion`，云端已被其他窗口写入新 refresh token | 刷新前重新读取最新 cloud account，使用最新 refresh token 调 token endpoint，并把新 access/refresh token 写回更新后的云端版本。 |
| cloud token 已消费后写回冲突 | token endpoint 已成功返回新 access/refresh token，但写回 cloud account 时发现云端 metadata 已变化且仍保存同一个旧 refresh token | 不丢弃新 token；以当前云端版本为基底合并新 access/refresh token 后重试写回，避免下一次继续使用已消费的旧 refresh token。 |
| stale cloud marker 指向旧账号 | 当前 `auth.json` 已经是另一个账号，但本地 cloud marker 仍指向旧 cloud account | 切换账号前不把当前 auth 写入旧 marker 指向的 cloud account；记录 identity mismatch 并把 marker 修正到当前 auth 对应的已保存账号。 |
| 当前 local account 迁移到 cloud | 当前正在使用的 local account 执行 `Move to Cloud` | 迁移成功后 current marker 更新为同名 cloud account，包含最新 `entryVersion` / `updatedAt`，后续同步不会继续指向旧账号。 |
