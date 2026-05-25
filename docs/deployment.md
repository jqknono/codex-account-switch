# Deployment

## Release Paths

| Target | Package | Trigger | Credentials | Notes |
| --- | --- | --- | --- | --- |
| npm | `packages/cli` | Local `npm run publish:cli` | Local npm login or token | `packages/cli/package.json` version must match the intended publish version. Stable versions default to `latest`; pre-release versions default to `next`. |
| Visual Studio Marketplace | `packages/vscode` | Local `npm run publish:vscode` | `VSCE_PAT` | Publishes the VS Code extension directly. |
| Open VSX | `packages/vscode` | Local `npm run publish:vscode:openvsx` | `OVSX_PAT` or `OPEN_VSX_TOKEN` | Publishes the prebuilt VSIX. |

## npm Local Publish Flow

```mermaid
flowchart LR
  A[Commit version change on main] --> B[Run npm run publish:cli:check]
  B --> C[Run npm run verify:publish:cli]
  C --> D[Run npm run publish:cli]
  D --> E[npm publish packages/cli]
  E --> F[codex-account-switch published to npm]
```

## npm Local Credentials

Publish from a local environment that already has npm credentials configured.

| Field | Value |
| --- | --- |
| Package | `codex-account-switch` |
| Registry | `https://registry.npmjs.org` |
| Authentication | `npm login` or a local npm token |
| Recommended branch | `main` |

Check the active npm account with:

```bash
npm whoami
```

Verify registry connectivity with:

```bash
npm ping
```

## CLI Release Procedure

| Step | Command | Verification |
| --- | --- | --- |
| Install dependencies | `npm ci` | command succeeds |
| Check local publish prerequisites | `npm run publish:cli:check` | script confirms `npm whoami` and `npm ping` succeed, then shows the detected default dist-tag |
| Rehearse the local publish flow | `npm run verify:publish:cli` | runs the CLI release tests and finishes with `npm publish --dry-run` |
| Run CLI release tests | `npm run test -w packages/cli` | the publishable CLI package passes its integration suite |
| Confirm target version | `node -p "require('./packages/cli/package.json').version"` | version is the one you intend to publish |
| Trigger release | `npm run publish:cli` | publishes `packages/cli` directly to npm |
| Verify published package | `npm view codex-account-switch version` | npm reports the new version |

## Rollback

| Situation | Action |
| --- | --- |
| `npm whoami` or `npm ping` fails | Refresh local npm credentials, then rerun `npm run publish:cli:check`. |
| Dry-run failed before publish | Fix the package/test/auth issue, then rerun `npm run verify:publish:cli`. |
| Incorrect package already published | Publish a corrective version; do not overwrite an existing npm version. |
