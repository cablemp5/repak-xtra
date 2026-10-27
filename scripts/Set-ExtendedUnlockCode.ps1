param([string]$SecretFile)
$ErrorActionPreference = 'Stop'
$code = $null
$secure = $null
$pointer = [IntPtr]::Zero
try {
    if ($SecretFile) { $code = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $SecretFile).Path).Trim() }
    else {
        $secure = Read-Host 'Shared extended unlock code' -AsSecureString
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        $code = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer).Trim()
    }
    if (-not $code -or [Text.Encoding]::UTF8.GetByteCount($code) -gt 1024) { throw 'Use a nonempty code of at most 1024 UTF-8 bytes.' }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($code)))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    $directory = Join-Path $PSScriptRoot '..\repak-x\resources\extended'
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    [IO.File]::WriteAllText((Join-Path $directory 'activation.sha256'), $hash)
    Write-Output 'Shared extended code configured. Only its hash was saved in the Git-ignored build resources.'
} finally {
    $code = $null
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    if ($secure) { $secure.Dispose() }
}
