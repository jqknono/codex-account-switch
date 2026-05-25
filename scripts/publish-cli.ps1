[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Command = "help",

    [string]$Version,
    
    [string]$NpmTag,

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
  pwsh -File ./scripts/publish-cli.ps1 dry-run [-Version <semver>] [-NpmTag <tag>] [-AllowDirty] [-AllowNonMain]
  pwsh -File ./scripts/publish-cli.ps1 publish [-Version <semver>] [-NpmTag <tag>] [-AllowDirty] [-AllowNonMain]

Commands:
  help     Show this help text.
  check    Validate local npm publish prerequisites for codex-account-switch.
  dry-run  Run the local CLI release checks and finish with npm publish --dry-run.
  publish  Run the local CLI release checks and publish packages/cli to npm.

Notes:
  - Commands default to the version in packages/cli/package.json.
  - Stable versions publish to the npm latest tag unless -NpmTag overrides it.
  - Pre-release versions publish to the npm next tag unless -NpmTag overrides it.
  - Run publish from the main branch after committing the target version.
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

function Get-PackageManifest {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepositoryRoot
    )

    $manifestPath = Join-Path $RepositoryRoot "packages/cli/package.json"
    $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
    if (-not $manifest.name) {
        throw "packages/cli/package.json does not define a package name."
    }

    if (-not $manifest.version) {
        throw "packages/cli/package.json does not define a version."
    }

    return $manifest
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

function Get-DefaultNpmTag {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Version
    )

    if ($Version.Contains("-")) {
        return "next"
    }
    return "latest"
}

function Assert-NpmPublishReady {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepositoryRoot
    )

    $manifest = Get-PackageManifest -RepositoryRoot $RepositoryRoot
    $packageName = [string]$manifest.name
    $whoami = Test-NpmCommand -Arguments @("whoami")
    if ($whoami.ExitCode -ne 0) {
        throw @"
Unable to verify the npm account for '$packageName'.
Run 'npm login' or configure an npm token locally before publishing.
Command output:
$($whoami.Output.Trim())
"@
    }

    $ping = Test-NpmCommand -Arguments @("ping")
    if ($ping.ExitCode -ne 0) {
        throw @"
Unable to reach the npm registry with the current credentials.
Command output:
$($ping.Output.Trim())
"@
    }

    try {
        $profile = Get-NpmCliJson -Arguments @("profile", "get", "--json") -FailureMessage "Unable to read npm profile."
        $tfaState = if ($profile.tfa) { "enabled" } else { "disabled" }
        Write-Host "npm account: $($whoami.Output.Trim())"
        Write-Host "npm profile 2FA: $tfaState"
    }
    catch {
        Write-Warning $_.Exception.Message
    }

    Write-Host "npm registry access looks valid for $packageName."
}

function Invoke-CheckRelease {
    $repositoryRoot = Get-RepositoryRoot
    Push-Location $repositoryRoot
    try {
        $packageVersion = Get-CliPackageVersion -RepositoryRoot $repositoryRoot
        $defaultTag = Get-DefaultNpmTag -Version $packageVersion

        Assert-NpmPublishReady -RepositoryRoot $repositoryRoot

        Write-Host "package version: $packageVersion"
        Write-Host "default npm tag: $defaultTag"
    }
    finally {
        Pop-Location
    }
}

function Invoke-PublishRelease {
    param(
        [Parameter(Mandatory = $true)]
        [bool]$DryRun
    )

    $repositoryRoot = Get-RepositoryRoot
    Push-Location $repositoryRoot
    try {
        if (-not $AllowDirty.IsPresent) {
            Assert-CleanWorktree
        }

        $branch = Get-CurrentBranch
        if (-not $AllowNonMain.IsPresent -and $branch -ne "main") {
            throw "Current branch is '$branch'. CLI publishing must run from 'main', or rerun with -AllowNonMain."
        }

        $packageVersion = Get-CliPackageVersion -RepositoryRoot $repositoryRoot
        $targetVersion = if ($Version) { $Version } else { $packageVersion }

        if ($targetVersion -ne $packageVersion) {
            throw "Requested version '$targetVersion' does not match packages/cli/package.json version '$packageVersion'."
        }

        $publishTag = if ($NpmTag) { $NpmTag } else { Get-DefaultNpmTag -Version $packageVersion }

        Assert-NpmPublishReady -RepositoryRoot $repositoryRoot

        npm ci
        if ($LASTEXITCODE -ne 0) {
            throw "npm ci failed."
        }

        npm run test -w packages/cli
        if ($LASTEXITCODE -ne 0) {
            throw "CLI release tests failed."
        }

        Push-Location (Join-Path $repositoryRoot "packages/cli")
        try {
            $publishArguments = @("publish", "--tag", $publishTag)
            if ($DryRun) {
                $publishArguments += "--dry-run"
            }

            npm @publishArguments
            if ($LASTEXITCODE -ne 0) {
                throw "npm publish failed."
            }
        }
        finally {
            Pop-Location
        }

        $mode = if ($DryRun) { "Dry-run publish completed" } else { "CLI package published" }
        Write-Host "$mode for codex-account-switch@$targetVersion with npm tag '$publishTag'."
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
    "dry-run" {
        Invoke-PublishRelease -DryRun $true
        break
    }
    "publish" {
        Invoke-PublishRelease -DryRun $false
        break
    }
    default {
        throw "Unknown command '$Command'. Run 'pwsh -File ./scripts/publish-cli.ps1 help' for usage."
    }
}
