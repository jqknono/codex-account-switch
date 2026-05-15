[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Command = "help",

    [string]$Version,

    [string]$Remote = "origin",

    [switch]$AllowDirty,

    [switch]$AllowNonMain
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Show-Help {
    @"
publish-cli.ps1

Usage:
  pwsh -File ./scripts/publish-cli.ps1 help
  pwsh -File ./scripts/publish-cli.ps1 tag [-Version <semver>] [-Remote <name>] [-AllowDirty] [-AllowNonMain]

Commands:
  help  Show this help text.
  tag   Validate the CLI package version, create tag cli-v<version>, and push it to the selected remote.

Notes:
  - The publish workflow runs in GitHub Actions via npm Trusted Publisher.
  - Run the tag command from the main branch after committing the target version.
  - The tag must match packages/cli/package.json exactly.
"@
}

function Get-RepositoryRoot {
    $root = git rev-parse --show-toplevel 2>$null
    if (-not $root) {
        throw "Current directory is not inside a Git repository."
    }
    return $root.Trim()
}

function Get-CurrentBranch {
    return (git branch --show-current).Trim()
}

function Get-CliPackageVersion {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepositoryRoot
    )

    $manifestPath = Join-Path $RepositoryRoot "packages/cli/package.json"
    $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
    if (-not $manifest.version) {
        throw "packages/cli/package.json does not define a version."
    }
    return [string]$manifest.version
}

function Assert-CleanWorktree {
    $status = git status --short
    if ($status) {
        throw "Working tree is not clean. Commit or stash changes before publishing, or rerun with -AllowDirty."
    }
}

function Assert-TagDoesNotExist {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TagName,
        [Parameter(Mandatory = $true)]
        [string]$Remote
    )

    $localTag = git tag --list $TagName
    if ($localTag) {
        throw "Tag '$TagName' already exists locally."
    }

    $remoteTag = git ls-remote --tags $Remote "refs/tags/$TagName"
    if ($remoteTag) {
        throw "Tag '$TagName' already exists on remote '$Remote'."
    }
}

function Invoke-TagRelease {
    $repositoryRoot = Get-RepositoryRoot
    Push-Location $repositoryRoot
    try {
        if (-not $AllowDirty.IsPresent) {
            Assert-CleanWorktree
        }

        $branch = Get-CurrentBranch
        if (-not $AllowNonMain.IsPresent -and $branch -ne "main") {
            throw "Current branch is '$branch'. Publish tags must be created from 'main', or rerun with -AllowNonMain."
        }

        $packageVersion = Get-CliPackageVersion -RepositoryRoot $repositoryRoot
        $targetVersion = if ($Version) { $Version } else { $packageVersion }

        if ($targetVersion -ne $packageVersion) {
            throw "Requested version '$targetVersion' does not match packages/cli/package.json version '$packageVersion'."
        }

        $tagName = "cli-v$targetVersion"
        Assert-TagDoesNotExist -TagName $tagName -Remote $Remote

        git tag -a $tagName -m "Release CLI $targetVersion"
        git push $Remote "refs/tags/$tagName"

        Write-Host "Created and pushed tag $tagName to $Remote."
        Write-Host "GitHub Actions workflow .github/workflows/publish-cli.yml should now publish codex-account-switch@$targetVersion."
    }
    finally {
        Pop-Location
    }
}

switch ($Command.ToLowerInvariant()) {
    "help" {
        Show-Help
        break
    }
    "tag" {
        Invoke-TagRelease
        break
    }
    default {
        throw "Unknown command '$Command'. Run 'pwsh -File ./scripts/publish-cli.ps1 help' for usage."
    }
}
