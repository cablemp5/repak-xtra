# repakxtra: signs release zips so the in-app updater only applies a zip this key signed (xtra_update.rs verifies).
# RSA 3072 with SHA-256 (PKCS#1 v1.5) through .NET, which every Windows has: no extra tools.
#
#   -NewKey            make the signing key once: the private key goes to -KeyPath (never into the repo), the public key
#                      to -PublicOut (repak-x\src\release-key.xml, committed: the app trusts that key)
#   -Sign -Zip <path> -Version <x.y.z>
#                      writes <zip>.sig.json next to the zip: a manifest (product, platform, version, file name, size,
#                      SHA-256) and its signature. build.ps1 -Release runs this.
param(
    [switch]$NewKey,
    [switch]$Sign,
    [string]$Zip,
    [string]$Version,
    [string]$KeyPath = (Join-Path $env:USERPROFILE '.repakxtra\release-signing-key.xml'),
    [string]$PublicOut = (Join-Path $PSScriptRoot '..\src\release-key.xml')
)
$ErrorActionPreference = 'Stop'

if ($NewKey) {
    if (Test-Path -LiteralPath $KeyPath) { throw "$KeyPath already exists: a new key would make every installed copy refuse your next update." }
    $rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider(3072)
    try {
        [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($KeyPath))
        [System.IO.File]::WriteAllText($KeyPath, $rsa.ToXmlString($true))
        [System.IO.File]::WriteAllText([System.IO.Path]::GetFullPath($PublicOut), $rsa.ToXmlString($false))
    } finally { $rsa.Dispose() }
    Write-Host "Private key: $KeyPath (keep it out of the repo and back it up)"
    Write-Host "Public key: $PublicOut (commit it)"
    exit 0
}

if ($Sign) {
    if (-not (Test-Path -LiteralPath $KeyPath)) { throw "No signing key at $KeyPath (make one with -NewKey)." }
    if ($Version -notmatch '^\d+\.\d+\.\d+') { throw "-Version must look like 1.2.3" }
    $file = Get-Item -LiteralPath $Zip
    $manifest = [ordered]@{
        format   = 1
        product  = 'repakxtra'
        platform = 'windows-x64'
        version  = $Version
        artifact = $file.Name
        size     = $file.Length
        sha256   = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLower()
    }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes(($manifest | ConvertTo-Json -Compress))
    $rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider
    try {
        $rsa.FromXmlString([System.IO.File]::ReadAllText($KeyPath))
        if ($rsa.PublicOnly) { throw "$KeyPath holds only a public key." }
        $sig = $rsa.SignData($bytes, [System.Security.Cryptography.CryptoConfig]::MapNameToOID('SHA256'))
    } finally { $rsa.Dispose() }
    $out = [ordered]@{ manifest = [Convert]::ToBase64String($bytes); signature = [Convert]::ToBase64String($sig) }
    [System.IO.File]::WriteAllText("$($file.FullName).sig.json", ($out | ConvertTo-Json -Compress))
    Write-Host "Signed: $($file.FullName).sig.json"
    exit 0
}

throw 'Use -NewKey or -Sign.'
