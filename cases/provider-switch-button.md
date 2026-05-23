# Provider Switch Button

| 场景 | Given | When | Then |
| --- | --- | --- | --- |
| 隐藏通用模式切换入口 | VS Code 扩展显示 Accounts 或 Providers 视图 | 用户查看视图标题栏或 Providers 空态欢迎内容 | 不显示 `Switch Mode` 按钮或 `Switch mode` 欢迎链接。 |
| 隐藏自动切换设置按钮 | VS Code 扩展显示 Accounts 视图 | 用户查看视图标题栏 | 不显示 `Auto-Switch Settings` 按钮；自动切换配置项本身仍保留。 |
| Provider 行内切换 | Providers 视图存在 local 或 cloud provider 条目 | 用户点击 provider 条目的 `Switch Provider` 行内操作 | 执行现有 provider 切换逻辑，刷新视图使用 `provider-switch`，不触发账号 quota 请求。 |
| Provider 命令选择器 | 用户从命令面板运行 `Switch Provider` 且未传入 provider 条目 | 扩展显示 provider 选择器并选择一个 provider | 切换到所选 provider，locked、invalid、冲突处理沿用现有 provider 切换流程。 |
