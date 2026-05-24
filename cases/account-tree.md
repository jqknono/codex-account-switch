# Account Tree Acceptance Cases

| 场景 | 前置条件 / 输入 | 预期结果 |
| --- | --- | --- |
| 账号详情展示精简 | 同时存在 local account 与 cloud account，并展开账号详情 | 不显示 `Source` 或自动刷新设备信息；保留 `Email`、`Plan`、token/quota 字段；cloud account 仍可显示 `Sync version`、`Updated` 等同步诊断信息。 |
| quota 失败账号保留在来源分组 | `3` 个 cloud accounts 的 quota 请求失败，节点描述显示 `Quota unavailable` 或具体失败原因 | 这 `3` 个账号仍保留在 `Cloud Accounts` 中，不单独生成 `Quota Failed` 分组；失败态仅通过账号描述、tooltip 与详情字段表达。 |
| 当前账号 quota 更新失败且无缓存 | 当前选中的 `apple1` 账号 quota 请求失败，且没有可用缓存 | `apple1` 仍显示当前账号图标，但图标颜色为红色 `errorForeground`，不显示绿色成功态。 |
| 当前账号 quota 使用缓存 | 当前选中的 `apple1` 账号未获得最新 quota 数据，但存在可用缓存 | `apple1` 仍显示当前账号图标，但图标颜色为黄色 `editorWarning.foreground`，详情中显示 quota freshness 为 `Cached`。 |
| Accounts 标题栏图标按语义分组展示 | 用户打开 Accounts 视图并查看标题栏操作图标 | 图标顺序为刷新列表、展开全部、新增账号、导入账号、重载窗口、启用/禁用自动切换、自动切换设置。 |
| refresh token 不可恢复 | 手动 `Refresh Token` 返回 `refresh_token_reused` 或提示必须重新登录 | 账号节点描述显示 `Relogin required`；tooltip 与详情中显示需要重新登录，旧 quota 缓存可继续作为参考展示。 |
