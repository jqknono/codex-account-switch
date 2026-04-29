# Refresh Command Acceptance Cases

| 场景 | 前置条件 / 输入 | 预期结果 |
| --- | --- | --- |
| 视图标题触发刷新菜单 | 用户从 Accounts 视图标题点击 `Refresh`，没有选中具体账号节点 | 弹出刷新动作选择菜单，不抛异常；`Refresh Token` 使用通用提示 `Select an account or All to refresh token and quota`。 |
| 刷新菜单批量刷新 token | 用户从 Accounts 视图标题点击 `Refresh -> Refresh Token -> All` | 所有 saved accounts 依次执行 token refresh；成功账号统一补一次 quota refresh，并弹出批量结果摘要。 |
| 非账号上下文误传 payload | `codex-account-switch.refresh` 被传入不包含 `account` 的节点对象 | 命令继续可用，`Refresh Token` / `Refresh Quota` 回退到通用描述，不读取不存在的 `account.name`。 |
