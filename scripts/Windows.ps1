param(
    [ValidateSet('Setup', 'Build', 'Check', 'Run', 'Release', 'ProvisionContent')][string]$Task = 'Build',
    [string]$Source,
    [string]$Output = 'content',
    [string]$ModsSource,
    [string]$SourceBuild,
    [string]$ContentRoot,
    [switch]$IndexOnly,
    [switch]$StartupOnly,
    [switch]$Hash
)
$ErrorActionPreference = 'Stop'
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
    $NpmCommand = (Get-Command -Name @('npm.cmd', 'npm.exe') -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if (-not $NpmCommand -and $Task -ne 'ProvisionContent') { throw 'Install the pinned Node distribution with npm.cmd or npm.exe on PATH.' }
    function Invoke-Checked([string]$Program, [string[]]$Arguments) {
        & $Program @Arguments
        if ($LASTEXITCODE -ne 0) { throw "$Program failed with exit code $LASTEXITCODE" }
    }
    switch ($Task) {
        'Setup' {
            if ((& node --version) -ne 'v26.10.0') { throw 'Install Node 26.10.0 from https://nodejs.org/download/release/v26.10.0/ first.' }
            if ((& $NpmCommand --version) -ne '11.19.1') { throw 'Use npm 11.19.1 supplied with the pinned Node toolchain.' }
            Invoke-Checked 'rustup' @('toolchain', 'install', '1.96.0', '--profile', 'minimal', '--component', 'rustfmt', '--component', 'clippy', '--target', 'wasm32-unknown-unknown')
            Invoke-Checked $NpmCommand @('ci', '--ignore-scripts')
        }
        'Build' { Invoke-Checked $NpmCommand @('run', 'build') }
        'Check' { Invoke-Checked $NpmCommand @('run', 'build'); Invoke-Checked $NpmCommand @('run', 'check') }
        'Run' {
            if ($ContentRoot) { $env:CONTENT_ROOT = $ContentRoot }
            Invoke-Checked $NpmCommand @('start')
        }
        'Release' { Invoke-Checked $NpmCommand @('run', 'release') }
        'ProvisionContent' {
            $Arguments = @('scripts/provision-content.mjs', '--output', $Output)
            if ($Source) { $Arguments += @('--source', $Source) }
            if ($ModsSource) { $Arguments += @('--mods-source', $ModsSource) }
            if ($SourceBuild) { $Arguments += @('--source-build', $SourceBuild) }
            if ($IndexOnly) { $Arguments += '--index-only' }
            if ($StartupOnly) { $Arguments += '--startup-only' }
            if ($Hash) { $Arguments += '--hash' }
            Invoke-Checked 'node' $Arguments
        }
    }
} finally { Pop-Location }
