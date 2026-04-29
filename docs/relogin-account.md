# Relogin Account

## Expected Behavior

| 动作 | 当前使用账号 | 保存账号 | UI 行为 |
| --- | --- | --- | --- |
| `relogin` 非当前账号 | 保持不变 | 覆盖目标账号的保存认证 | 成功后只提示已更新，不提示 reload。 |
| `relogin` 当前账号 | 保持同一账号 | 覆盖当前账号的保存认证 | 成功后只提示已更新，不提示 reload。 |

## Flow

```mermaid
flowchart LR
  A[记录 relogin 前当前选择] --> B[执行 codex login]
  B --> C[把新的 auth 保存到目标账号]
  C --> D{是否需要恢复原选择}
  D -->|是| E[恢复原账号或 Provider 模式]
  D -->|否| F[保持现状]
  E --> G[显示成功或恢复失败提示]
  F --> G
  G --> H[不触发 reload prompt]
```
