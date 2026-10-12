param([ValidateSet('Build','Serve','Plugins','Status')][string]$Action = 'Build')
$ErrorActionPreference = 'Stop'
$env:PATH = "$env:SystemRoot\System32;$env:SystemRoot\System32\Wbem;$env:SystemRoot\System32\WindowsPowerShell\v1.0;$env:PATH"
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$source = Join-Path $root 'data/agh-source'
$runtime = Join-Path $root 'data/agh-runtime'
$revision = 'ec7ebbdb36e7658d2a121c3ba5113e850b16cb63'
$env:AGH_HOME = Join-Path $env:USERPROFILE '.agh-print-detail-v2'
$env:PHOTO_CAD_AGH_HOME = $env:AGH_HOME
$env:AGNES_PROFILE = 'local-dev'

function Assert-Exit([string]$step) {
    if ($LASTEXITCODE -ne 0) { throw "$step failed (exit $LASTEXITCODE)" }
}

function Ensure-SourceNative {
    $builtNative = Join-Path $runtime 'node_modules/@agnes/system-node/dist/native/agnes-system.node'
    $sourceNative = Join-Path $source 'packages/system-node/dist/native/agnes-system.node'
    if (!(Test-Path -LiteralPath $builtNative -PathType Leaf)) { throw 'Build the complete AGH runtime before installing plugins' }
    if ((Test-Path -LiteralPath $sourceNative) -and (Get-FileHash -LiteralPath $sourceNative).Hash -ne (Get-FileHash -LiteralPath $builtNative).Hash) {
        throw 'Source-side native binary differs from this runtime; use a fresh source directory'
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $sourceNative) | Out-Null
    Copy-Item -LiteralPath $builtNative -Destination $sourceNative -Force
}

if ($Action -eq 'Build') {
    if (!(Test-Path -LiteralPath $source)) {
        New-Item -ItemType Directory -Path $source | Out-Null
        & git -C $source init
        Assert-Exit 'init'
        & git -C $source remote add origin https://github.com/AgnesAI-Labs/agnes-harness.git
        Assert-Exit 'remote'
        & git -C $source fetch --depth=1 origin $revision
        Assert-Exit 'fetch fixed revision'
        & git -C $source checkout --detach FETCH_HEAD
        Assert-Exit 'checkout'
    }
    $head = (& git -C $source rev-parse HEAD).Trim()
    Assert-Exit 'source identity'
    if ($head -ne $revision) { throw 'AGH checkout differs from the pinned revision; use a fresh project directory' }
    $patch = Join-Path $root 'agh-adaptation/agh-local-adaptations.patch'
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & git -C $source apply --reverse --check $patch 2>$null
    $alreadyApplied = $LASTEXITCODE -eq 0
    $ErrorActionPreference = $previousPreference
    if (!$alreadyApplied) {
        & git -C $source apply --check $patch
        Assert-Exit 'patch check'
        & git -C $source apply $patch
        Assert-Exit 'patch apply'
    }
    $additions = (Resolve-Path (Join-Path $root 'agh-adaptation/files')).Path
    Get-ChildItem -LiteralPath $additions -File -Recurse | ForEach-Object {
        $relativeAddition = $_.FullName.Substring($additions.Length).TrimStart([char[]]'\/')
        $target = Join-Path $source $relativeAddition
        if ((Test-Path -LiteralPath $target) -and (Get-FileHash -LiteralPath $target).Hash -ne (Get-FileHash -LiteralPath $_.FullName).Hash) {
            throw "Different existing source: $target"
        }
        New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
        Copy-Item -LiteralPath $_.FullName -Destination $target -Force
    }
    if (Test-Path -LiteralPath $runtime) { throw 'Runtime directory already exists; keep it and build in a fresh source directory' }
    Push-Location $source
    try {
        & npm.cmd exec --yes --package=pnpm@10.34.5 -- pnpm install --frozen-lockfile
        Assert-Exit 'pnpm install'
        & (Join-Path $source '.github/scripts/prepare-windows-native.ps1') -CacheRoot (Join-Path $env:LOCALAPPDATA 'node-gyp/Cache')
        Assert-Exit 'Node native headers'
        & npm.cmd exec --yes --package=pnpm@10.34.5 -- pnpm --filter '@agnes/cli' build:local --output-dir $runtime
        Assert-Exit 'AGH build'
    } finally { Pop-Location }
    Ensure-SourceNative
    & node (Join-Path $runtime 'agnes.mjs') --help
    Assert-Exit 'CLI smoke'
} elseif ($Action -eq 'Serve') {
    & node (Join-Path $runtime 'agnes.mjs') serve --profile local-dev
    Assert-Exit 'AGH serve'
} elseif ($Action -eq 'Plugins') {
    Ensure-SourceNative
    & node (Join-Path $root 'tools/setup/plugins.mjs')
    Assert-Exit 'plugin install'
} else {
    & node (Join-Path $runtime 'agnes.mjs') daemon status --profile local-dev
    Assert-Exit 'AGH status'
}
