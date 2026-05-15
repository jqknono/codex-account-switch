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
  pwsh -File ./scripts/publish-cli.ps1 check
  pwsh -File ./scripts/publish-cli.ps1 tag [-Version <semver>] [-Remote <name>] [-AllowDirty] [-AllowNonMain]

Commands:
  help   Show this help text.
  check  Validate the npm Trusted Publisher prerequisites for codex-account-switch.
  tag    Validate the CLI package version, create tag cli-v<version>, and push it to the selected remote.

Notes:
  - The publish workflow runs in GitHub Actions via npm Trusted Publisher.
  - Run the check command after changing npm trust settings or workflow metadata.
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

function Get-NpmCliJson {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [Parameter(Mandatory = $true)]
        [string]$FailureMessage
    )

    $output = npm @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        $commandText = "npm $($Arguments -join ' ')"
        throw "$FailureMessage Command: $commandText`n$output"
    }

    return $output | Out-String | ConvertFrom-Json
}

function Test-NpmCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $output = npm @Arguments 2>&1
    return [pscustomobject]@{
        ExitCode = $LASTEXITCODE
        Output = $output | Out-String
    }
}

function Assert-NpmTrustedPublisherReady {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepositoryRoot
    )

    $manifestPath = Join-Path $RepositoryRoot "packages/cli/package.json"
    $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
    $packageName = [string]$manifest.name
    if (-not $packageName) {
        throw "packages/cli/package.json does not define a package name."
    }

    $whoami = Test-NpmCommand -Arguments @("whoami")
    if ($whoami.ExitCode -ne 0) {
        Write-Warning "Skipping npm account preflight because 'npm whoami' failed. Configure npm login locally if you want to validate Trusted Publisher prerequisites before tagging."
        return
    }

    $profile = Get-NpmCliJson -Arguments @("profile", "get", "--json") -FailureMessage "Unable to read npm profile."
    if (-not $profile.tfa) {
        throw @"
npm account '$($whoami.Output.Trim())' has 2FA disabled.
Enable 2FA before configuring or updating Trusted Publisher for '$packageName'.
After enabling 2FA, run:
  npm trust github $packageName --repo jqknono/codex-account-switch --file publish-cli.yml
"@
    }

    $trustProbe = Test-NpmCommand -Arguments @(
        "trust", "github", $packageName,
        "--repo", "jqknono/codex-account-switch",
        "--file", "publish-cli.yml",
        "--dry-run", "--json"
    )
    if ($trustProbe.ExitCode -ne 0) {
        throw @"
npm Trusted Publisher dry-run failed for '$packageName'.
Confirm that the npm package trust metadata matches:
  owner/repo: jqknono/codex-account-switch
  workflow: publish-cli.yml
  branch: main
  environment: (empty)
Command output:
$($trustProbe.Output.Trim())
"@
    }

    Write-Host "npm Trusted Publisher prerequisites look valid for $packageName."
}

function Invoke-CheckRelease {
    $repositoryRoot = Get-RepositoryRoot
    Push-Location $repositoryRoot
    try {
        Assert-NpmTrustedPublisherReady -RepositoryRoot $repositoryRoot
    }
    finally {
        Pop-Location
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

        Assert-NpmTrustedPublisherReady -RepositoryRoot $repositoryRoot

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
    "check" {
        Invoke-CheckRelease
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
