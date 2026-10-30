# Probe files themselves: a process keeps its old junction spelling after that junction moves.
function Test-BuildOutputAvailable([string]$Directory) {
    foreach ($name in @('repakxtra.exe', 'REPAK-X.exe', 'UAssetTool.dll', 'uassettool-cli.exe')) {
        $path = Join-Path $Directory $name
        if (-not (Test-Path -LiteralPath $path)) { continue }
        $probe = $null
        try {
            $probe = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
        } catch { return $false }
        finally { if ($probe) { $probe.Dispose() } }
    }
    return $true
}

function Get-FreeBuildOutput([string]$First, [string]$Second) {
    foreach ($directory in @($First, $Second)) {
        if (Test-BuildOutputAvailable $directory) { return $directory }
    }
    throw 'Close a repakxtra copy first: both output folders are in use or not writable.'
}
