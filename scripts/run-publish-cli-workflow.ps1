[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Command = "help",

    [ValidateSet("push", "workflow_dispatch")]
    [string]$Event = "workflow_dispatch",

    [string]$Version,

    [string]$NpmTag,

    [string]$NodeVersion = "24.15.0"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Show-Help {
    @"
run-publish-cli-workflow.ps1

Usage:
  pwsh -File ./scripts/run-publish-cli-workflow.ps1 help
  pwsh -File ./scripts/run-publish-cli-workflow.ps1 run [-Event push|workflow_dispatch] [-Version <semver>] [-NpmTag <tag>] [-NodeVersion <version>]

Notes:
  - Runs the publish workflow locally inside WSL Ubuntu.
  - Downloads a temporary Linux Node.js toolchain into the WSL user cache if needed.
  - Mirrors the GitHub Actions workflow but uses npm publish --dry-run instead of a real publish.
"@
}

function Convert-ToWslPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$WindowsPath
    )

    $resolved = (Resolve-Path -LiteralPath $WindowsPath).Path
    $normalized = $resolved -replace "\\", "/"
    if ($normalized -notmatch "^([A-Za-z]):/(.+)$") {
        throw "Unsupported Windows path: $resolved"
    }

    $drive = $matches[1].ToLowerInvariant()
    $rest = $matches[2]
    return "/mnt/$drive/$rest"
}

switch ($Command.ToLowerInvariant()) {
    "help" {
        Show-Help
        break
    }
    "run" {
        $repoRoot = (git rev-parse --show-toplevel).Trim()
        if (-not $repoRoot) {
            throw "Current directory is not inside a Git repository."
        }

        $repoRootWsl = Convert-ToWslPath -WindowsPath $repoRoot
        $arguments = [System.Collections.Generic.List[string]]::new()
        $arguments.Add("cd '$repoRootWsl' && sh ./scripts/run-publish-cli-workflow.sh run")
        $arguments.Add("--event '$Event'")
        if ($Version) {
            $arguments.Add("--version '$Version'")
        }
        if ($NpmTag) {
            $arguments.Add("--npm-tag '$NpmTag'")
        }
        if ($NodeVersion) {
            $arguments.Add("--node-version '$NodeVersion'")
        }

        $bashCommand = $arguments -join " "
        wsl -e bash -lc $bashCommand
        break
    }
    default {
        throw "Unknown command '$Command'. Run 'pwsh -File ./scripts/run-publish-cli-workflow.ps1 help' for usage."
    }
}
