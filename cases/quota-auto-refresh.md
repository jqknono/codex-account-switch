# Current Account Quota Auto Refresh Acceptance Cases

| 场景 | 前置条件 / 输入 | 预期结果 |
| --- | --- | --- |
| 默认后台刷新 | 当前选择为 account，未修改 `codex-account-switch.quotaRefreshInterval` | 插件每 `300s` 在后台刷新当前 account 的 quota，并同步更新账号树与状态栏。 |
| 修改刷新周期 | 用户把 `codex-account-switch.quotaRefreshInterval` 改为 `180` | 旧 timer 被释放，新 timer 按 `180s` 生效，后续后台刷新采用新周期。 |
| 当前选择不是 account | 当前模式为 provider，或没有活动 account | 后台 timer 不查询 account quota；状态栏只更新当前模式显示，不触发无效 quota 请求。 |
| 刷新进行中再次触发 | 一次 quota 刷新尚未完成，期间又到达下一次 auto refresh，或用户触发一次自动目标刷新 | 新请求不会并发重复打到同一个当前 account；当前轮完成后会继续执行排队的刷新。 |
