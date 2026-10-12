param([ValidateSet('Setup', 'Build', 'Check', 'Run', 'Release')][string]$Task = 'Build')
$ErrorActionPreference = 'Stop'
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
    $NpmCommand = (Get-Command -Name @('npm.cmd', 'npm.exe') -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if (-not $NpmCommand) { throw 'Install the pinned Node distribution with npm.cmd or npm.exe on PATH.' }
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
        'Run' { Invoke-Checked $NpmCommand @('start') }
        'Release' { Invoke-Checked $NpmCommand @('run', 'release') }
    }
} finally { Pop-Location }
