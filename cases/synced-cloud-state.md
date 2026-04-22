# Synced Cloud State Acceptance Cases

| 场景 | 前置条件 / 输入 | 预期结果 |
| --- | --- | --- |
| 首次迁移旧设置 | `codex-account-switch.syncedStorage` 中已有 cloud accounts/providers/devices，新的 synced `globalState` key 为空 | 激活时自动迁移全部云状态到 synced `globalState`，后续读写都使用新存储。 |
| 旧设置清理失败 | 首次迁移成功，但删除旧 `syncedStorage` 设置时返回写入错误 | 扩展显示非致命提示并继续工作；relogin、move-to-cloud、refresh token 不再依赖 `settings.json`。 |
| 重新登录 cloud 账号 | 选中 cloud account，完成 `codex login`，本机 `settings.json` 不可写 | 新 auth 写入 synced `globalState`，账号树刷新后显示新状态，不再因为用户设置写入失败而报错。 |
| 第二台机器同步 | 另一台机器通过 Settings Sync 拿到 synced `globalState` 中的 cloud state，但本机尚未保存密码 | 账号/Provider 条目可见但处于 locked；输入同一密码后可以正常解密和使用。 |
| 设备授权同步 | synced cloud state 中已有 `devices` 与 `autoRefreshDeviceName` | 激活后保持原有设备选择逻辑，定时自动刷新只在被授权设备上执行。 |
