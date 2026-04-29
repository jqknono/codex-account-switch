# Synced Cloud State

## Responsibilities

| Area | Storage | Notes |
| --- | --- | --- |
| Cloud accounts | VS Code `globalState` synced key | Payload stays encrypted with the saved-auth passphrase. |
| Cloud providers | VS Code `globalState` synced key | Uses the same encrypted envelope format as accounts. |
| Device list | VS Code `globalState` synced key | Shared across machines through Settings Sync. |
| Auto-refresh device | VS Code `globalState` synced key | Syncs with the rest of the cloud state. |
| Saved-auth passphrase | VS Code `SecretStorage` | Local-only secret, never synced. |
| Current selection marker | VS Code `globalState` unsynced key | Per-device UI state. |

## Sync Behavior

```mermaid
flowchart LR
  A[Legacy syncedStorage setting] -->|first activation migration| B[globalState synced cloud state]
  B -->|activation appends current hostname when cloud state exists| C[Device list]
  B --> D[Settings Sync]
  E[Selected auto-refresh device] --> F[Only this device may refresh and persist cloud tokens]
  D --> F
  G[SecretStorage passphrase] --> H[Decrypt encrypted envelopes locally]
  B --> H
```

## Migration Rules

| Rule | Behavior |
| --- | --- |
| New synced key already exists | Use it as the only source of truth. |
| New synced key missing and legacy setting has data | Copy the full legacy object into synced `globalState`. |
| Legacy cleanup succeeds | Remove the old `codex-account-switch.syncedStorage` setting. |
| Legacy cleanup fails | Keep the migrated `globalState` data active, log a warning, and show a non-fatal notice. |

## Device Registration

| Rule | Behavior |
| --- | --- |
| Activation sees existing synced cloud state | Append the current hostname into `devices` if it is missing. |
| Activation runs again on the same machine | Keep a single entry for that hostname; do not duplicate it. |
| Synced cloud state is still empty | Do not create a device record just because the extension activated once. |
| `autoRefreshDeviceName` is unset | The first synced device remains the effective refresh authority until the user explicitly changes it. |
| Current machine is not the selected auto-refresh device | This machine can still read synced entries and appear in the device list, but it must not persist refreshed cloud tokens. |

## Constraints

| Constraint | Effect |
| --- | --- |
| No `globalState` change event for remote sync | Reload/activation or explicit refresh is the supported pickup boundary. |
| Passphrase is local-only | A second machine must enter the same password before synced cloud entries can be decrypted. |
| Envelope format must stay unchanged | `@codex-account-switch/core` remains the canonical serializer/deserializer. |
