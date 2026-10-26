param([int]$RootProcessId, [long]$MaxPrivateBytes, [long]$MinAvailableBytes, [switch]$SelfCheck)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class StartupMemoryNative {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Entry {
  public uint size,usage,pid; public UIntPtr heap; public uint module,threads,parent; public int priority; public uint flags;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string exe;
 }
 [StructLayout(LayoutKind.Sequential)] public struct Memory { public uint size,load; public ulong total,available,pageTotal,pageAvailable,virtualTotal,virtualAvailable,extended; }
 [StructLayout(LayoutKind.Sequential)] struct Unicode { public ushort length,maximum; public IntPtr buffer; }
 public sealed class Row { public int ProcessId,ParentProcessId; public string Name; }
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32FirstW(IntPtr snapshot,ref Entry entry);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32NextW(IntPtr snapshot,ref Entry entry);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr handle,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GlobalMemoryStatusEx(ref Memory memory);
 [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process,int kind,IntPtr buffer,int length,out int needed);
 public static Row[] Processes() {
  IntPtr snapshot=CreateToolhelp32Snapshot(2,0); if(snapshot==new IntPtr(-1)) throw new System.ComponentModel.Win32Exception();
  try { Entry entry=new Entry();entry.size=(uint)Marshal.SizeOf(typeof(Entry));var rows=new List<Row>();
   if(!Process32FirstW(snapshot,ref entry)) throw new System.ComponentModel.Win32Exception();
   do {rows.Add(new Row{ProcessId=(int)entry.pid,ParentProcessId=(int)entry.parent,Name=entry.exe});} while(Process32NextW(snapshot,ref entry));
   int error=Marshal.GetLastWin32Error();if(error!=18) throw new System.ComponentModel.Win32Exception(error);return rows.ToArray();
  } finally {CloseHandle(snapshot);}
 }
 public static Memory SystemMemory() {Memory m=new Memory();m.size=(uint)Marshal.SizeOf(typeof(Memory));if(!GlobalMemoryStatusEx(ref m)) throw new System.ComponentModel.Win32Exception();return m;}
 public static void TerminateOwned(IntPtr handle) {if(!TerminateProcess(handle,1)) throw new System.ComponentModel.Win32Exception();}
 public static string CommandLine(IntPtr process) {
  int needed;NtQueryInformationProcess(process,60,IntPtr.Zero,0,out needed);if(needed<=0||needed>1048576) throw new InvalidOperationException("Invalid command-line extent");
  IntPtr buffer=Marshal.AllocHGlobal(needed);try {int status=NtQueryInformationProcess(process,60,buffer,needed,out needed);if(status<0) throw new InvalidOperationException("Command-line status "+status);
   Unicode value=(Unicode)Marshal.PtrToStructure(buffer,typeof(Unicode));return Marshal.PtrToStringUni(value.buffer,value.length/2);
  } finally {Marshal.FreeHGlobal(buffer);}
 }
}
'@
if ($SelfCheck) {
    $self = [Diagnostics.Process]::GetCurrentProcess()
    try {
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $rows = [StartupMemoryNative]::Processes()
        $memory = [StartupMemoryNative]::SystemMemory()
        $command = [StartupMemoryNative]::CommandLine($self.Handle)
        [pscustomobject]@{ event='native-self-check'; pid=$self.Id; found=@($rows | Where-Object ProcessId -EQ $self.Id).Count; privateBytes=$self.PrivateMemorySize64; workingSetBytes=$self.WorkingSet64; availableBytes=$memory.available; totalBytes=$memory.total; commandLinePresent=($command.Length -gt 0); milliseconds=$timer.ElapsedMilliseconds } | ConvertTo-Json -Compress
    } finally { $self.Dispose() }
    exit 0
}
$rootHandle = [Diagnostics.Process]::GetProcessById($RootProcessId)
$null = $rootHandle.Handle
$originalCreation = $rootHandle.StartTime.ToUniversalTime()
$originalCommandLine = [StartupMemoryNative]::CommandLine($rootHandle.Handle)
$profile = [regex]::Match($originalCommandLine, '--user-data-dir=(?:"([^"]+)"|(\S+))')
$ownedProfile = if ($profile.Groups[1].Success) { $profile.Groups[1].Value } else { $profile.Groups[2].Value }
if ($rootHandle.ProcessName -ne 'chrome' -or -not $profile.Success -or [IO.Path]::GetFileName($ownedProfile) -notlike 'playwright_chromiumdev_profile-*') { $rootHandle.Dispose(); throw 'Refusing unverified browser identity' }
$pressureAt = $null
$ownedIdentities = @{}
$ownedIdentities[$RootProcessId] = $originalCreation.Ticks
try {
while ($true) {
    $cycle = [Diagnostics.Stopwatch]::StartNew()
    [Console]::Out.WriteLine('{"event":"stage","stage":"native-snapshot-start"}')
    $rootHandle.Refresh()
    $rootExited = $rootHandle.HasExited
    if (-not $rootExited -and $rootHandle.StartTime.ToUniversalTime() -ne $originalCreation) { throw 'Owned browser identity changed' }
    $all = @([StartupMemoryNative]::Processes())
    $snapshotMilliseconds = $cycle.ElapsedMilliseconds
    [Console]::Out.WriteLine('{"event":"stage","stage":"owned-process-memory-start"}')
    $ids = [Collections.Generic.HashSet[int]]::new()
    [void]$ids.Add($RootProcessId)
    # Retain previously observed descendants after their immediate parent exits.
    # Compare creation identity before admitting a reused numeric PID.
    foreach ($knownId in @($ownedIdentities.Keys)) {
        $known = Get-Process -Id $knownId -ErrorAction SilentlyContinue
        try {
            if ($known -and $known.StartTime.ToUniversalTime().Ticks -eq $ownedIdentities[$knownId]) { [void]$ids.Add([int]$knownId) }
            else { $ownedIdentities.Remove($knownId) }
        } catch {
            if ($known -and -not $known.HasExited) { throw }
            $ownedIdentities.Remove($knownId)
        } finally { if ($known) { $known.Dispose() } }
    }
    do {
        $changed = $false
        foreach ($row in $all) {
            if ($ids.Contains($row.ParentProcessId) -and $ownedIdentities.ContainsKey($row.ParentProcessId) -and -not $ids.Contains($row.ProcessId)) {
                $candidate = Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue
                try {
                    if ($candidate) {
                        $candidateCreation = $candidate.StartTime.ToUniversalTime().Ticks
                        if ($candidateCreation -ge $originalCreation.Ticks -and $candidateCreation -ge $ownedIdentities[$row.ParentProcessId]) {
                            $ownedIdentities[$row.ProcessId] = $candidateCreation
                            if ($ids.Add($row.ProcessId)) { $changed = $true }
                        }
                    }
                } catch {
                    if ($candidate -and -not $candidate.HasExited) { throw }
                } finally { if ($candidate) { $candidate.Dispose() } }
            }
        }
    } while ($changed)
    $processes = @($all | Where-Object { $ids.Contains($_.ProcessId) } | ForEach-Object {
        $row = $_
        $ownedProcess = $null
        try {
            $ownedProcess = [Diagnostics.Process]::GetProcessById($row.ProcessId)
            if ($ownedProcess.StartTime.ToUniversalTime().Ticks -eq $ownedIdentities[$row.ProcessId]) {
                [pscustomobject]@{ pid=$row.ProcessId; parent=$row.ParentProcessId; name=$row.Name; commandLine=[StartupMemoryNative]::CommandLine($ownedProcess.Handle); privateBytes=$ownedProcess.PrivateMemorySize64; workingSetBytes=$ownedProcess.WorkingSet64; creation=$ownedProcess.StartTime.ToUniversalTime().ToString('o') }
            }
        } catch [ArgumentException] {
            if ($ownedProcess -and -not $ownedProcess.HasExited) { throw }
        } catch {
            # PowerShell can wrap a process-exit property race as MethodException.
            if (-not $ownedProcess -or -not $ownedProcess.HasExited) { throw }
        } finally { if ($ownedProcess) { $ownedProcess.Dispose() } }
    })
    [Console]::Out.WriteLine('{"event":"stage","stage":"system-memory-start"}')
    $system = [StartupMemoryNative]::SystemMemory()
    if ($rootExited -and $processes.Count -eq 0) { [Console]::Out.WriteLine('{"event":"closed"}'); exit 0 }
    $privateBytes = [long](($processes | Measure-Object privateBytes -Sum).Sum)
    $availableBytes = [long]$system.available
    $reason = if ($rootExited) { 'owned-root-exited-with-descendants' } elseif ($privateBytes -ge $MaxPrivateBytes) { 'owned-private-limit' } elseif ($availableBytes -le $MinAvailableBytes) { 'system-available-floor' } elseif ($privateBytes -ge ($MaxPrivateBytes * 0.9)) { 'owned-private-soft-limit' } elseif ($availableBytes -le ($MinAvailableBytes + 1073741824)) { 'system-available-soft-floor' } else { $null }
    if ($reason -and $null -eq $pressureAt) { $pressureAt = [DateTime]::UtcNow }
    $sample = @{ event='sample'; observedAt=[DateTime]::UtcNow.ToString('o'); stage='native-sample-complete'; sampleMilliseconds=$cycle.ElapsedMilliseconds; snapshotMilliseconds=$snapshotMilliseconds; rootPid=$RootProcessId; rootCreation=$originalCreation.ToString('o'); profile=$ownedProfile; privateBytes=$privateBytes; workingSetBytes=[long](($processes | Measure-Object workingSetBytes -Sum).Sum); systemAvailableBytes=$availableBytes; systemTotalBytes=[long]$system.total; reason=$reason; processCount=$processes.Count; processes=@($processes | Select-Object -First 128) }
    [Console]::Out.WriteLine(($sample | ConvertTo-Json -Depth 5 -Compress))
    if ($rootExited -or $privateBytes -ge $MaxPrivateBytes -or $availableBytes -le $MinAvailableBytes -or ($null -ne $pressureAt -and ([DateTime]::UtcNow - $pressureAt).TotalSeconds -ge 5)) {
        $rootHandle.Refresh()
        if (-not $rootHandle.HasExited -and ($rootHandle.StartTime.ToUniversalTime() -ne $originalCreation -or [StartupMemoryNative]::CommandLine($rootHandle.Handle) -ne $originalCommandLine -or $rootHandle.ProcessName -ne 'chrome')) { throw 'Refusing changed identity at termination' }
        # Pin every sampled identity, including tracked orphans, before any termination.
        $targets = [Collections.Generic.List[Diagnostics.Process]]::new()
        try {
            foreach ($sampled in $processes) {
                $target = Get-Process -Id $sampled.pid -ErrorAction SilentlyContinue
                $retained = $false
                try {
                    if ($target -and $target.StartTime.ToUniversalTime().ToString('o') -eq $sampled.creation) {
                        $null = $target.Handle
                        $targets.Add($target)
                        $retained = $true
                    }
                } catch { if ($target -and -not $target.HasExited) { throw } }
                finally { if ($target -and -not $retained) { $target.Dispose() } }
            }
            $rootHandle.Refresh()
            if (-not $rootHandle.HasExited -and ($rootHandle.StartTime.ToUniversalTime() -ne $originalCreation -or [StartupMemoryNative]::CommandLine($rootHandle.Handle) -ne $originalCommandLine)) { throw 'Refusing changed root identity at termination' }
            foreach ($target in $targets) {
                if (-not $target.HasExited) {
                    try { [StartupMemoryNative]::TerminateOwned($target.Handle) }
                    catch { if (-not $target.HasExited) { throw } }
                }
            }
            $remaining = @($targets | Where-Object { -not $_.WaitForExit(200) })
            if ($remaining.Count -ne 0) { throw "Owned browser termination incomplete: $($remaining.Id -join ',')" }
            [Console]::Out.WriteLine((@{ event='hard-close'; reason=$reason; rootPid=$RootProcessId; profile=$ownedProfile; action='terminate-verified-process-handles'; verifiedTargetCount=$targets.Count; actionExitCode=0; remainingOwnedProcesses=0 } | ConvertTo-Json -Compress))
        } finally { foreach ($target in $targets) { $target.Dispose() } }
        exit 0
    }
    Start-Sleep -Seconds 2
}
} finally { $rootHandle.Dispose() }
