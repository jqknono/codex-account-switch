# Token Auto Refresh Acceptance Cases

| 场景 | 前置条件 / 输入 | 预期结果 |
| --- | --- | --- |
| 本地账号 token 临近过期 | local saved account 的 access token 或可解码 refresh token 剩余有效期 `< 120h`，后台轮转命中该账号 | 插件自动刷新 token，并写回 saved auth；如果该账号当前正在使用，则 `auth.json` 也同步更新。 |
| cloud 账号 token 临近过期 | cloud saved account 的 token 剩余有效期 `< 120h`，后台轮转命中该账号 | 插件自动刷新 token，并写回 synced cloud state；不按机器或旧设备字段限制。 |
| token endpoint 要求重新登录 | 后台 token 刷新返回 `refresh_token_reused` 或等价 sign-in-again 错误 | 账号树显示 `Relogin required`；当前轮跳过该账号 quota 查询。 |
| quota API 判定 token 已失效 | quota 刷新返回 `error.code = token_invalidated` | quota 结果标记为 `relogin_required`；账号树显示 `Relogin required`，已有 quota cache 只作为回退展示。 |
| quota 手动刷新 | 用户手动执行 `Refresh Quota` | 不触发 token 刷新，仅刷新 quota。 |
