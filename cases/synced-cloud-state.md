# Synced Cloud State Acceptance Cases

| 场景 | 前置条件 / 输入 | 预期结果 |
| --- | --- | --- |
| 首次迁移旧设置 | `codex-account-switch.syncedStorage` 中已有 cloud accounts/providers/devices，新的 synced `globalState` key 为空 | 激活时自动迁移全部云状态到 synced `globalState`，后续读写都使用新存储。 |
| 旧设置清理失败 | 首次迁移成功，但删除旧 `syncedStorage` 设置时返回写入错误 | 扩展显示非致命提示并继续工作；relogin、move-to-cloud、refresh token 不再依赖 `settings.json`。 |
| 重新登录 cloud 账号 | 选中 cloud account，完成 `codex login`，本机 `settings.json` 不可写 | 新 auth 写入 synced `globalState`，账号树刷新后显示新状态，不再因为用户设置写入失败而报错。 |
| 第二台机器同步 | 另一台机器通过 Settings Sync 拿到 synced `globalState` 中的 cloud state，但本机尚未保存密码 | 账号/Provider 条目可见但处于 locked；输入同一密码后可以正常解密和使用。 |
| Cloud account 独立同步 | 两台机器分别更新不同 cloud account，例如 r7000 更新 `apple2`、本机更新 `apple1` | 每个 cloud account 写入独立 synced key，更新 `apple1` 不会把本机旧的 `apple2` 快照覆盖到云端。 |
| 旧聚合云状态拆分 | `codex-account-switch.syncedCloudState.v1` 中仍聚合保存 `accounts/providers` payload | 激活时把缺失的账号和 Provider payload 写入独立 synced key，索引中的 `accounts/providers` 清空。 |
| 缺失 payload 的索引清理 | `accountNames/providerNames` 中列出了名称，但独立 key、聚合 payload、旧设置 payload 都没有对应数据 | 激活时自动从索引和 `setKeysForSync` 中移除这些 names-only 条目，不创建空账号或 Provider。 |
| 多来源 payload 融合 | 独立 key、旧聚合 payload、旧设置 payload 中存在同名账号或 Provider 的不同快照 | 自动选择有 `entryVersion` 的 payload；多个 payload 都有版本时选择版本号更大的 payload 并物化到独立 key。 |
| 版本化本地快照恢复缺失云 payload | UI/marker 中持有带版本的账号 auth 快照，但当前 synced storage 中该账号 payload 缺失或版本更低 | 写入类操作使用版本更高的本地快照作为基线继续保存，避免把可恢复数据报成 `current version unknown` 冲突。 |
| 独立条目优先 | 旧聚合 key 和独立 entry key 同时存在，且同名独立 entry 更新 | 迁移保留独立 entry，不用旧聚合 payload 覆盖较新的单条数据。 |
| Settings Sync 内部缓存不可迁移 | `settingsSync.ignoredExtensions` 忽略了扩展，完整旧状态只存在于 `state.vscdb` 的 `extensions.lastSyncUserData.skippedExtensions` | 扩展不直接读取 VS Code 内部数据库；如果扩展 API 和配置项都不可读该数据，则放弃自动迁移。 |
| Locked 账号显示邮箱 | cloud account entry 外层已有未加密 `email`，但本机没有 storage password | 账号仍显示为 locked，同时账号行、详情和选择项可显示该 email。 |
| 解锁后补齐邮箱 | 旧加密 cloud account entry 没有外层 `email`，本机已有正确 storage password | 读取账号时从解密 auth 中提取 email 写回 entry 外层，保留原同步版本和更新时间。 |
| Cloud provider 独立同步 | 两个 cloud provider 同时存在，更新其中一个 provider | 只改写目标 provider 的独立 synced key，另一个 provider payload 不变。 |
| 激活自动登记设备 | synced cloud state 中已有 cloud accounts/providers/devices 任一项，当前主机名尚未出现在 `devices` | 激活时自动把当前设备追加到 `devices`；重复激活不会重复追加。 |
| 空云状态不制造设备记录 | synced cloud state 为空，当前机器首次激活扩展 | 不为了“仅本机启动过一次”而创建新的 synced device 记录。 |
| 设备授权同步 | synced cloud state 中已有 `devices` 与 `autoRefreshDeviceName` | 激活后自动登记当前设备；自动 cloud token 刷新仍只在被授权设备上执行。 |
| 非授权设备切走 cloud account | 当前机器不是 `autoRefreshDeviceName`，并且当前选中 cloud account 后切换到其他账号 | 切换前不会把本机 `auth.json` 隐式写回 cloud account，cloud account 的 `entryVersion` / `updatedAt` 保持不变。 |
| Cloud provider 写入审计 | 创建/编辑 cloud provider、从当前 cloud provider 切走、或把 local provider 移动到 cloud | 云端 provider 条目写入 `lastWriterDeviceName` 和 `lastWriterAction`，Provider 树详情可见。 |
| Cloud provider 冲突提示 | 本机缓存的 cloud provider 版本落后于同步后的真实版本 | 冲突提示显示当前版本、更新时间、`lastWriterDeviceName`、`lastWriterAction`，便于定位是谁改写了条目。 |
