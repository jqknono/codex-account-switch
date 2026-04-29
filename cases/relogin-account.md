# Relogin Account Acceptance Cases

| 场景 | 前置条件 / 输入 | 预期结果 |
| --- | --- | --- |
| relogin 非当前账号 | 当前正在使用账号 A，列表中对已保存账号 B 执行 `relogin` 并完成 `codex login` | B 的保存认证被更新；`auth.json` 恢复为账号 A；不弹出 `Reload/Later` 提示，不执行 window reload。 |
| relogin 当前账号 | 当前正在使用账号 A，对账号 A 执行 `relogin` 并完成 `codex login` | A 的保存认证被更新；当前仍是账号 A；显示成功提示，但不提示 reload window。 |
| relogin 后恢复失败 | 当前正在使用账号 A，对账号 B 执行 `relogin`，但恢复 A 失败 | B 的保存认证已更新；界面显示恢复失败 warning；不额外提示 reload window。 |
