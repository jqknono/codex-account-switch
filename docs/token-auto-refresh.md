# Token Auto Refresh

## Responsibilities

| Area | Owner | Notes |
| --- | --- | --- |
| Background token check | `RefreshCoordinator` | Uses the extension background timer and checks one saved account per rotation step. |
| Threshold evaluation | `RefreshCoordinator` | Refreshes when access token is expired, within `120h`, or when a decodable refresh token is within `120h`. |
| Token refresh execution | `refreshSavedAccountEntry` | Reuses the same write-back path as manual `Refresh Token`. |
| Cloud device authority | synced `autoRefreshDeviceName` | Only the selected synced device may automatically refresh cloud saved accounts. |
| Quota separation | `AccountTreeProvider` + `querySavedAccountQuota` | Quota refresh never refreshes tokens by itself. |

## Flow

```mermaid
flowchart LR
  A[quotaRefreshInterval timer tick] --> B[Pick next saved account]
  B --> C{Token expires within 120h?}
  C -->|no| D[Skip token refresh]
  C -->|yes| E{Cloud account on authorized device?}
  E -->|no| D
  E -->|yes| F[Refresh token and persist updated auth]
  F --> G[Continue with independent quota refresh]
  D --> G
```

## Rules

| Rule | Behavior |
| --- | --- |
| Threshold | `120` hours (`5` days). |
| Rotation | Each timer step checks at most `1` saved account for token refresh. |
| Local accounts | Automatic token refresh is always allowed. |
| Cloud accounts | Automatic token refresh requires the current device to be the effective auto-refresh device. |
| Manual refresh | `Refresh Token` ignores device authority and still works immediately. |
| Quota refresh | Manual or timer-driven quota refresh does not trigger token refresh unless the background token check already did so before the quota step. |
| Re-login required | If token refresh returns `refresh_token_reused` or an equivalent sign-in-again error, the account is marked `Relogin required` and the timer skips quota for that account in the current step. |
