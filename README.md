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
| `codex-account-switch list` | List all saved accounts and providers |
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

CLI diagnostic logs such as performance traces are written to `~/.codex/logs/codex-account-switch-cli.log` by default instead of being printed in command output. If `CODEX_HOME` is set, the log file is written under that directory's `logs/`.

## VS Code Extension

Activity Bar account view:

![VS Code extension account view](./packages/vscode/resources/account-view.png)

### Features

- Activity Bar view with account list and quota details
- Add, remove, switch, import, and export accounts
- Mode-aware status bar display for the current account or provider mode
- Token refresh actions for saved accounts
- Background token maintenance that checks saved accounts for tokens expiring within 120 hours
- Background quota refresh that rotates through saved accounts one at a time on a configurable interval
- Shared local quota cache so multiple VS Code windows can reuse recent results before querying again
- Optional prompt or automatic window reload after switching accounts so the Codex extension can re-read `~/.codex/auth.json`

### Settings

| Setting | Default | Description |
|---|---|---|
| `codex-account-switch.quotaRefreshInterval` | `5` | Background maintenance interval, in seconds; minimum `5`; each interval checks one saved account for token refresh and rotates one saved account quota refresh |
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

# Verify npm Trusted Publisher prerequisites
npm run publish:cli:check

# Create and push the release tag that triggers the GitHub Trusted Publisher workflow
npm run publish:cli
```

Examples:

```bash
# Check whether the local npm account can manage the Trusted Publisher binding
npm run publish:cli:check

# Show release helper usage
npm run publish:cli:help

# Tag a specific committed CLI version and push it to origin
npm run publish:cli -- -Version 1.8.0
```

The actual `npm publish` step now runs in GitHub Actions through npm Trusted Publisher. Configure the npm package trust once, enable npm account 2FA before managing that trust, then publish from the `main` branch by pushing a `cli-v<version>` tag that matches `packages/cli/package.json`.

## Data Storage

Each saved account is stored as `auth_{name}.json` inside the configured account directory. By default this is the Codex config directory, typically `~/.codex`. Before any account or provider switch overwrites `~/.codex/auth.json`, the tool first syncs the latest current account auth back to its matching saved `auth_{name}.json`. Switching accounts then restores the selected file into `~/.codex/auth.json` and clears the active `model_provider` in `~/.codex/config.toml`.

When `refresh` rotates tokens for a saved account, the updated auth payload is written back to the saved account file. If that account is currently active, `~/.codex/auth.json` is updated too so future switches do not restore an older refresh token snapshot.

Quota refresh is read-only. The CLI `quota` command and the VS Code background/manual quota refresh paths do not refresh tokens, do not rewrite saved auth payloads, and only cache quota results locally on the current machine.

In the VS Code extension, background maintenance separately checks one saved account per timer step. If the access token is expired, within `120` hours of expiry, or a decodable refresh token is within `120` hours of expiry, the extension refreshes that account token before continuing with the independent quota step. Automatic cloud token refresh still respects the selected synced auto-refresh device.

Some tools and extensions that depend on `~/.codex/auth.json` may cache authentication state on startup. For those cases, replacing `auth.json` alone may not take effect immediately, and a VS Code window reload is required.

Provider modes are stored separately as `provider_{name}.json`. A provider profile contains the raw auth payload to write into `auth.json` plus the provider block that should be synchronized into `config.toml`. Export files still only include saved accounts.


