param([int]$RootProcessId, [long]$MaxPrivateBytes, [long]$MinAvailableBytes)
$ErrorActionPreference = 'Stop'
$originalCreation = $null
$ownedProfile = $null
$pressureAt = $null

while ($true) {
    $all = @(Get-CimInstance Win32_Process)
    $root = $all | Where-Object ProcessId -EQ $RootProcessId
    if (-not $root) { [Console]::Out.WriteLine('{"event":"closed"}'); exit 0 }
    $profile = [regex]::Match($root.CommandLine, '--user-data-dir=(?:"([^"]+)"|(\S+))')
    $profilePath = if ($profile.Groups[1].Success) { $profile.Groups[1].Value } else { $profile.Groups[2].Value }
    if ($root.Name -ne 'chrome.exe' -or -not $profile.Success -or [IO.Path]::GetFileName($profilePath) -notlike 'playwright_chromiumdev_profile-*') {
        throw 'Refusing unverified browser identity'
    }
    if ($null -eq $originalCreation) { $originalCreation = $root.CreationDate; $ownedProfile = $profilePath }
    if ($root.CreationDate -ne $originalCreation -or $profilePath -ne $ownedProfile) { throw 'Owned browser identity changed' }
    $ids = [Collections.Generic.HashSet[int]]::new()
    [void]$ids.Add($RootProcessId)
    do {
        $changed = $false
        foreach ($process in $all) {
            if ($process.CreationDate -ge $originalCreation -and $ids.Contains([int]$process.ParentProcessId) -and $ids.Add([int]$process.ProcessId)) { $changed = $true }
        }
    } while ($changed)
    $processes = @($all | Where-Object { $ids.Contains([int]$_.ProcessId) } | ForEach-Object {
        [pscustomobject]@{ pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; name=$_.Name; commandLine=$_.CommandLine; privateBytes=[long]$_.PrivatePageCount; workingSetBytes=[long]$_.WorkingSetSize }
    })
    $system = Get-CimInstance Win32_OperatingSystem
    $privateBytes = [long](($processes | Measure-Object privateBytes -Sum).Sum)
    $availableBytes = [long]$system.FreePhysicalMemory * 1024
    $reason = if ($privateBytes -ge $MaxPrivateBytes) { 'owned-private-limit' } elseif ($availableBytes -le $MinAvailableBytes) { 'system-available-floor' } elseif ($privateBytes -ge ($MaxPrivateBytes * 0.9)) { 'owned-private-soft-limit' } elseif ($availableBytes -le ($MinAvailableBytes + 2147483648)) { 'system-available-soft-floor' } else { $null }
    if ($reason -and $null -eq $pressureAt) { $pressureAt = [DateTime]::UtcNow }
    $sample = @{ event='sample'; observedAt=[DateTime]::UtcNow.ToString('o'); rootPid=$RootProcessId; rootCreation=$originalCreation.ToString('o'); profile=$ownedProfile; privateBytes=$privateBytes; workingSetBytes=[long](($processes | Measure-Object workingSetBytes -Sum).Sum); systemAvailableBytes=$availableBytes; systemTotalBytes=[long]$system.TotalVisibleMemorySize * 1024; reason=$reason; processCount=$processes.Count; processes=@($processes | Select-Object -First 128) }
    [Console]::Out.WriteLine(($sample | ConvertTo-Json -Depth 5 -Compress))
    if ($privateBytes -ge $MaxPrivateBytes -or $availableBytes -le $MinAvailableBytes -or ($null -ne $pressureAt -and ([DateTime]::UtcNow - $pressureAt).TotalSeconds -ge 5)) {
        # Hold the process handle and recheck identity at the destructive boundary.
        $rootHandle = Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue
        if (-not $rootHandle) { [Console]::Out.WriteLine('{"event":"closed"}'); exit 0 }
        $null = $rootHandle.Handle
        try {
            $fresh = Get-CimInstance Win32_Process -Filter "ProcessId = $RootProcessId"
            if (-not $fresh) { [Console]::Out.WriteLine('{"event":"closed"}'); exit 0 }
            if ($fresh.CreationDate -ne $originalCreation -or $fresh.CommandLine -ne $root.CommandLine -or $fresh.Name -ne 'chrome.exe') { throw 'Refusing changed identity at termination' }
            $killOutput = & taskkill.exe /PID $RootProcessId /T /F 2>&1
            $killStatus = $LASTEXITCODE
            Start-Sleep -Milliseconds 200
            $remaining = @(Get-CimInstance Win32_Process | Where-Object { $ids.Contains([int]$_.ProcessId) -and $_.CreationDate -ge $originalCreation })
            if ($remaining.Count -ne 0) { throw "Owned browser termination incomplete ($killStatus): $($remaining.ProcessId -join ',')" }
            [Console]::Out.WriteLine((@{ event='hard-close'; reason=$reason; rootPid=$RootProcessId; profile=$ownedProfile; actionExitCode=$killStatus; remainingOwnedProcesses=0; actionOutput=($killOutput -join "`n") } | ConvertTo-Json -Compress))
        } finally { $rootHandle.Dispose() }
        exit 0
    }
    Start-Sleep -Seconds 5
}
