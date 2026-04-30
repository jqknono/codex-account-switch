# Rotating Quota Auto Refresh Acceptance Cases

| 场景 | 前置条件 / 输入 | 预期结果 |
| --- | --- | --- |
| 默认后台刷新 | 有多个 saved account，未修改 `codex-account-switch.quotaRefreshInterval` | 插件每 `30s` 在后台只刷新 1 个 account 的 quota，按轮转方式推进，不阻塞其余账号。 |
| 修改刷新周期 | 用户把 `codex-account-switch.quotaRefreshInterval` 改为 `5` | 旧 timer 被释放，新 timer 按 `5s` 生效，后续后台刷新采用新周期。 |
| 低于下限的刷新周期 | 用户绕过设置 UI 把 `codex-account-switch.quotaRefreshInterval` 写成 `1` | 后台 timer 按 `5s` 下限执行，共享 quota cache 的节流窗口也按 `5s` 计算。 |
| 分组右键批量刷新 | 用户在 `Local Accounts` 或 `Cloud Accounts` 分组节点点击右键并选择 `Refresh Quota` | 仅刷新该分组内全部 accounts 的 quota，不要求逐个手动点击账号。 |
| 第二个 VS Code 窗口启动 | 同机已有另一个 VS Code 实例刚查询过同一套 saved accounts 的 quota | 新窗口优先从插件共享 cache 显示最近一次 quota 结果，不重复立刻发起同样的 quota 请求。 |
| 查询失败但已有旧结果 | quota API 临时失败，但本地 cache 中已有最近一次成功查询结果 | 插件继续显示上次成功查询的 quota 数据，优先避免树节点回退到 `No data`。 |
| 当前选择不是本轮账号 | 当前模式为 provider，或当前 account 不是本次轮到的账号 | 本轮只查询被轮转命中的账号 quota；不会额外为状态栏再打一次当前账号 quota 请求。 |
| 刷新进行中再次触发 | 一次 quota 刷新尚未完成，期间又到达下一次 auto refresh，或用户触发一次自动目标刷新 | 新请求不会并发重复打到多个账号；当前轮完成后会继续执行排队的刷新。 |
| 关闭自动 token 回写 | `codex-account-switch.tokenAutoUpdate = false`，轮转到当前 local account 或 cloud account | 自动 quota 刷新仍可刷新当前 `auth.json` 以维持正在使用的会话，但不会把新 token 回写到对应 saved account。 |
| 自动 token 回写节流 | `codex-account-switch.tokenAutoUpdate = true` 且 `tokenAutoUpdateIntervalHours = 24`，saved account 最近刚完成过一次自动回写 | 后续 quota 刷新在间隔未到前跳过 saved account 回写；间隔到达后才再次写回。 |
