# codex-account-switch

Codex CLI multi-account switching for Windows, macOS, and Linux.

It provides both a CLI and a VS Code extension.

## Project Structure

```text
packages/
  core/     - Shared logic for account management, auth, quota lookup, import, and export
  cli/      - CLI package published to npm
  vscode/   - VS Code extension
```

## How It Works

- `add` runs `codex login`, then copies `~/.codex/auth.json` to `~/.codex/auth_{name}.json`
- `use` first syncs the latest current account auth back to its saved `auth_{name}.json`, then restores the selected account into `~/.codex/auth.json`, clears any active `model_provider`, and switches Codex CLI back to account mode
- `quota` queries the ChatGPT backend API for live usage data across the 5-hour and 7-day windows
- `refresh` uses the stored `refresh_token` to refresh an expired access token and writes rotated tokens back to the saved account file
- `mode` switches between normal account mode and provider modes such as `provider`, synchronizing both `auth.json` and `config.toml`
- Saved `auth_{name}.json` files can live in a separate directory; if not configured, the default Codex config directory is used

## CLI Installation

```bash
npm install -g codex-account-switch
```

## CLI Demo

Animated CLI usage demo showing `ls`, `use`, and `quota`:

![codex-account-switch CLI demo](./assets/generated/codex-account-switch-demo-terminal-real.gif)

## CLI Commands

| Command | Description |
|---|---|
| `codex-account-switch add <name>` | Run `codex login` and save the result as a named account |
| `codex-account-switch list` | List all saved accounts |
| `codex-account-switch use <name>` | Switch to the specified account and restore account mode |
| `codex-account-switch mode [name]` | Show the current mode or switch to a provider/account mode |
| `codex-account-switch remove <name>` | Remove a saved account |
| `codex-account-switch quota [name]` | Show quota usage for an account |
| `codex-account-switch current` | Show the current active account or mode |
| `codex-account-switch refresh [name]` | Refresh the access token for an account |
| `codex-account-switch export [file]` | Export accounts to a JSON file |
| `codex-account-switch import <file>` | Import accounts from a JSON file |

You can override the saved-account directory per invocation:

```bash
codex-account-switch --auth-dir /path/to/accounts list
```

You can also use the environment variable `CODEX_ACCOUNT_SWITCH_AUTH_DIR`.

## VS Code Extension

Activity Bar account view:

![VS Code extension account view](./packages/vscode/resources/account-view.png)

### Features

- Activity Bar view with account list and quota details
- Add, remove, switch, import, and export accounts
- Mode-aware status bar display for the current account or provider mode
- Token refresh actions for saved accounts
- Background quota refresh that rotates through saved accounts one at a time on a configurable interval
- Shared local quota cache so multiple VS Code windows can reuse recent results before querying again
- Optional prompt or automatic window reload after switching accounts so the Codex extension can re-read `~/.codex/auth.json`

### Settings

| Setting | Default | Description |
|---|---|---|
| `codex-account-switch.quotaRefreshInterval` | `30` | Automatic background quota refresh interval, in seconds; minimum `5`; each interval refreshes one saved account quota in rotation |
| `codex-account-switch.showStatusBar` | `true` | Show the current account quota in the status bar |
| `codex-account-switch.reloadWindowAfterSwitch` | `prompt` | Whether to prompt or automatically reload the window after switching accounts |
| `codex-account-switch.authDirectory` | `""` | Directory used to save and load `auth_{name}.json`; empty means the default Codex config directory |

## Development

```bash
# Install dependencies
npm install

# Build everything
npm run build

# Build individual packages
npm run build:core
npm run build:cli
npm run build:vscode
```

## Publish The VS Code Extension

```bash
# Build the VS Code extension
npm run build:vscode

# Create a VSIX package
npm run package:vscode

# Publish to the Visual Studio Marketplace
# Requires VSCE_PAT to be available in the environment, or pass extra args via npm --
npm run publish:vscode

# Publish a pre-release version to the Visual Studio Marketplace
npm run publish:vscode:preview

# Publish to Open VSX
# Requires an Open VSX token via OVSX_PAT or OPEN_VSX_TOKEN; publishes the prebuilt VSIX and passes args via npm --
npm run publish:vscode:openvsx
```

Examples:

```bash
npm run publish:vscode -- --pat <your-pat>
npm run publish:vscode -- patch
npm run publish:vscode:preview -- patch
npm run publish:vscode:openvsx -- -p <your-openvsx-token>
```

Before the first Open VSX publish, create the `techfetch-dev` namespace if it does not already exist:

```bash
npx ovsx create-namespace techfetch-dev -p <your-openvsx-token>
```

## Publish The CLI To npm

```bash
# Build the CLI package
npm run build:cli

# Publish to npm
npm run publish:cli
```

Examples:

```bash
npm run publish:cli -- --tag next
npm run publish:cli -- --otp <code>
```

## Data Storage

Each saved account is stored as `auth_{name}.json` inside the configured account directory. By default this is the Codex config directory, typically `~/.codex`. Before any account or provider switch overwrites `~/.codex/auth.json`, the tool first syncs the latest current account auth back to its matching saved `auth_{name}.json`. Switching accounts then restores the selected file into `~/.codex/auth.json` and clears the active `model_provider` in `~/.codex/config.toml`.

When `refresh` or `quota` rotates tokens for a saved account, the updated auth payload is written back to the saved account file. If that account is currently active, `~/.codex/auth.json` is updated too so future switches do not restore an older refresh token snapshot.

In the VS Code extension, automatic write-back after background/manual quota refresh is controlled by the shared `codex-account-switch.tokenAutoUpdate` and `codex-account-switch.tokenAutoUpdateIntervalHours` settings for both local and cloud saved accounts. Manual `Refresh Token` still writes immediately.

Some tools and extensions that depend on `~/.codex/auth.json` may cache authentication state on startup. For those cases, replacing `auth.json` alone may not take effect immediately, and a VS Code window reload is required.

Provider modes are stored separately as `provider_{name}.json`. A provider profile contains the raw auth payload to write into `auth.json` plus the provider block that should be synchronized into `config.toml`. Export files still only include saved accounts.


