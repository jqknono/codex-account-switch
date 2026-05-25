# Synced Cloud State

## Responsibilities

| Area | Storage | Notes |
| --- | --- | --- |
| Cloud account index | VS Code `globalState` synced key `codex-account-switch.syncedCloudState.v1` | Stores account names plus shared cloud metadata; account payloads are not stored in this aggregate key. |
| Cloud accounts | Per-account VS Code `globalState` synced keys `codex-account-switch.syncedCloudAccount.v1.{name}` | Payload stays encrypted with the saved-auth passphrase; updating one account does not rewrite sibling accounts. |
| Cloud providers | Per-provider VS Code `globalState` synced keys `codex-account-switch.syncedCloudProvider.v1.{name}` | Uses the same encrypted envelope format as accounts, plus sync revision metadata and provider audit metadata (`lastWriterAction`). |
| Saved-auth passphrase | VS Code `SecretStorage` | Local-only secret, never synced. |
| Current selection marker | VS Code `globalState` unsynced key | Local UI state. |

## Sync Behavior

```mermaid
flowchart LR
  A[Legacy syncedStorage setting] -->|first activation migration| B[globalState synced cloud state]
  B -->|accountNames index| I[Per-account synced keys]
  B -->|providerNames index| J[Per-provider synced keys]
  B --> D[Settings Sync]
  G[SecretStorage passphrase] --> H[Decrypt encrypted envelopes locally]
  B --> H
```

## Migration Rules

| Rule | Behavior |
| --- | --- |
| New synced key already exists | Use it as the only source of truth. |
| New synced key missing and legacy setting has data | Copy legacy entries into per-account/per-provider synced `globalState` keys and keep only index metadata in the aggregate key. |
| Aggregate key contains legacy payloads | Materialize missing per-entry keys, prefer already-existing per-entry keys, then clear aggregate `accounts` and `providers`. |
| Multiple sources contain the same entry | Prefer payloads with `entryVersion`; when more than one source has a version, keep the highest version and materialize it into the per-entry key. |
| Local operation snapshot has a newer version | Use the versioned local snapshot as the write baseline when current synced storage is missing or older, then write the next version. |
| Index name has no payload | Preserve the name and keep its per-entry key registered for sync; treat it as a pending payload rather than deleting it. |
| Legacy cleanup succeeds | Remove the old `codex-account-switch.syncedStorage` setting. |
| Legacy cleanup fails | Keep the migrated `globalState` data active, log a warning, and show a non-fatal notice. |

## Legacy Device Fields

| Rule | Behavior |
| --- | --- |
| Legacy `devices` exists | Ignore it during migration, activation, refresh, and UI rendering. |
| Legacy `autoRefreshDeviceName` exists | Ignore it; any machine with the saved-auth passphrase may refresh and persist cloud tokens. |
| New writes | Do not write `devices`, `autoRefreshDeviceName`, or provider `lastWriterDeviceName`. |

## Constraints

| Constraint | Effect |
| --- | --- |
| No `globalState` change event for remote sync | Reload/activation or explicit refresh is the supported pickup boundary. |
| Passphrase is local-only | A second machine must enter the same password before synced cloud entries can be decrypted. |
| Index and payload may arrive separately | A device can temporarily see `accountNames/providerNames` before the matching per-entry payload key; that state must not be interpreted as deletion. |
| Envelope format must stay unchanged | `@codex-account-switch/core` remains the canonical serializer/deserializer. |
| Account/provider writes are per-entry | Updating one cloud account or provider must not rewrite sibling payload keys. |
| Public account email | Stored unencrypted on each cloud account entry so locked entries can still show the email; tokens remain encrypted. |
| VS Code internal caches stay private | The extension does not read `state.vscdb` or other VS Code internal storage; if data is only present there, automatic migration is abandoned. |

## Provider Audit Metadata

| Field | Scope | Meaning |
| --- | --- | --- |
| `lastWriterAction` | Cloud provider entry | Action that last wrote the provider entry, such as `save_provider_profile`, `sync_current_provider_auth`, or `move_provider_to_cloud`. |

| Write Path | Stored `lastWriterAction` |
| --- | --- |
| Manual create or edit of a cloud provider profile | `save_provider_profile` |
| Switching away from the active cloud provider and syncing its auth | `sync_current_provider_auth` |
| Moving a local provider into cloud storage | `move_provider_to_cloud` |
