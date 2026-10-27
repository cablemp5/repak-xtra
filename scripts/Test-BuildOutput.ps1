$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'build-output.ps1')
$targetRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\target'))
$fixture = Join-Path $targetRoot ('build-output-test-' + [Guid]::NewGuid().ToString('N'))
$first = Join-Path $fixture 'first'
$second = Join-Path $fixture 'next'
$link = Join-Path $fixture 'current'
$processes = @()
function Assert($condition, [string]$message) { if (-not $condition) { throw $message } }
try {
    New-Item -ItemType Directory -Force $first, $second | Out-Null
    foreach ($directory in @($first, $second)) {
        Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\ping.exe') -Destination (Join-Path $directory 'repakxtra.exe')
    }
    $before = (Get-FileHash -LiteralPath (Join-Path $first 'repakxtra.exe')).Hash
    Assert ((Get-FreeBuildOutput $first $second) -eq $first) 'An unused output must be available.'
    New-Item -ItemType Junction -Path $link -Target $first | Out-Null
    $processes += Start-Process -FilePath (Join-Path $link 'repakxtra.exe') -ArgumentList '-t', '127.0.0.1' -WindowStyle Hidden -PassThru
    Assert (-not $processes[0].HasExited) 'The fixture process did not stay open.'
    Assert ((Get-FreeBuildOutput $first $second) -eq $second) 'The first rebuild must avoid the running executable.'
    [IO.Directory]::Delete($link)
    New-Item -ItemType Junction -Path $link -Target $second | Out-Null
    Assert ((Get-FreeBuildOutput $first $second) -eq $second) 'A second rebuild must still avoid the original executable after repointing its junction.'
    $processes += Start-Process -FilePath (Join-Path $second 'repakxtra.exe') -ArgumentList '-t', '127.0.0.1' -WindowStyle Hidden -PassThru
    $blocked = $false
    try { Get-FreeBuildOutput $first $second | Out-Null } catch { $blocked = $true }
    Assert $blocked 'Both running outputs must be protected.'
    Assert ((Get-FileHash -LiteralPath (Join-Path $first 'repakxtra.exe')).Hash -eq $before) 'Probing must never modify file contents.'
    Write-Output 'Build output: unused, running, repointed junction, both locked, and unchanged contents passed.'
} finally {
    foreach ($process in $processes) {
        if (-not $process.HasExited) { Stop-Process -Id $process.Id; $null = $process.WaitForExit(5000) }
        $process.Dispose()
    }
    if (Test-Path -LiteralPath $link) { [IO.Directory]::Delete($link) }
    $absolute = [IO.Path]::GetFullPath($fixture)
    if (-not $absolute.StartsWith($targetRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture cleanup escaped target.' }
    if (Test-Path -LiteralPath $absolute) { Remove-Item -LiteralPath $absolute -Recurse -Force }
}
