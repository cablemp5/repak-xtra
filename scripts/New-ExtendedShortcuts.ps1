# Updates shortcuts/icons only; never builds or modifies a stable installation.
# Reuses the app's existing icon, with the same hue shifts as xtra_buildmark.rs.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
if (-not $desktop) { throw 'Windows did not return a desktop folder.' }
$iconDir = Join-Path $root 'dist\icons'
$builds = @(
    @{ Name = 'repakxtratest'; Exe = 'dist\repakxtra-Test\repakxtra.exe'; PreviousExe = 'dist\Repak-X-Test\repakxtra.exe'; Icon = 'repakxtra-test-green.ico'; Degrees = -80 },
    @{ Name = 'repakxploit'; OldName = 'repakxtra Extended Stable'; Exe = 'dist\repakxtra-Extended\repakxtra.exe'; Icon = 'repakxploit-stable-red.ico'; Degrees = 140 },
    @{ Name = 'repakxploit test'; OldName = 'repakxtra Extended Test'; Exe = 'dist\repakxtra-Test-Extended\repakxtra.exe'; PreviousExe = 'dist\Repak-X-Test-Extended\repakxtra.exe'; Icon = 'repakxploit-test-purple.ico'; Degrees = 60 }
)
foreach ($build in $builds) {
    if (-not (Test-Path -LiteralPath (Join-Path $root $build.Exe))) { throw "Build $($build.Name) first." }
}
New-Item -ItemType Directory -Force -Path $iconDir | Out-Null
Add-Type -AssemblyName System.Drawing

function Write-TintedIcon([string]$path, [double]$degrees) {
    $source = [Drawing.Bitmap]::new((Join-Path $root 'repak-x\icons\RepakIcon.png'))
    try { $bitmap = [Drawing.Bitmap]::new($source, 256, 256) } finally { $source.Dispose() }
    try {
        for ($y = 0; $y -lt $bitmap.Height; $y++) {
            for ($x = 0; $x -lt $bitmap.Width; $x++) {
                $pixel = $bitmap.GetPixel($x, $y)
                $channels = @(($pixel.R / 255.0), ($pixel.G / 255.0), ($pixel.B / 255.0))
                $maximum = [Math]::Max($channels[0], [Math]::Max($channels[1], $channels[2]))
                $minimum = [Math]::Min($channels[0], [Math]::Min($channels[1], $channels[2]))
                $chroma = $maximum - $minimum
                if ($chroma -eq 0) { continue }
                $hue = ((($pixel.GetHue() + $degrees) % 360 + 360) % 360) / 60
                $second = $chroma * (1 - [Math]::Abs(($hue % 2) - 1))
                $rgb = switch ([int][Math]::Floor($hue)) {
                    0 { @($chroma, $second, 0) }
                    1 { @($second, $chroma, 0) }
                    2 { @(0, $chroma, $second) }
                    3 { @(0, $second, $chroma) }
                    4 { @($second, 0, $chroma) }
                    5 { @($chroma, 0, $second) }
                }
                $rgb = @($rgb | ForEach-Object { [int][Math]::Round(($_ + $minimum) * 255) })
                $bitmap.SetPixel($x, $y, [Drawing.Color]::FromArgb($pixel.A, $rgb[0], $rgb[1], $rgb[2]))
            }
        }
        # PNG-backed ICO entries preserve alpha and stay sharp at normal desktop sizes.
        $frames = @(foreach ($size in @(16, 24, 32, 48, 64, 128, 256)) {
            $scaled = [Drawing.Bitmap]::new($bitmap, $size, $size)
            $stream = [IO.MemoryStream]::new()
            try {
                $scaled.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
                @{ Size = $size; Bytes = $stream.ToArray() }
            } finally { $scaled.Dispose(); $stream.Dispose() }
        })
        $stream = [IO.File]::Create($path)
        $writer = [IO.BinaryWriter]::new($stream)
        try {
            $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$frames.Count)
            $offset = 6 + 16 * $frames.Count
            foreach ($frame in $frames) {
                $dimension = if ($frame.Size -eq 256) { 0 } else { $frame.Size }
                $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
                $writer.Write([byte]0); $writer.Write([byte]0)
                $writer.Write([uint16]1); $writer.Write([uint16]32)
                $writer.Write([uint32]$frame.Bytes.Length); $writer.Write([uint32]$offset)
                $offset += $frame.Bytes.Length
            }
            foreach ($frame in $frames) { $writer.Write([byte[]]$frame.Bytes) }
        } finally { $writer.Dispose(); $stream.Dispose() }
    } finally { $bitmap.Dispose() }
}

$shell = New-Object -ComObject WScript.Shell
foreach ($build in $builds) {
    $exe = Join-Path $root $build.Exe
    $icon = Join-Path $iconDir $build.Icon
    $link = Join-Path $desktop ($build.Name + '.lnk')
    $allowedTargets = @($exe)
    if ($build.PreviousExe) { $allowedTargets += Join-Path $root $build.PreviousExe }
    if ($build.OldName -and -not (Test-Path -LiteralPath $link)) {
        $oldLink = Join-Path $desktop ($build.OldName + '.lnk')
        if (Test-Path -LiteralPath $oldLink) {
            if ($shell.CreateShortcut($oldLink).TargetPath -notin $allowedTargets) { throw "An unrelated shortcut uses $oldLink; it was not renamed." }
            if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($oldLink)) -ne $desktop -or [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($link)) -ne $desktop) { throw 'Shortcut rename escaped the desktop.' }
            [IO.File]::Move($oldLink, $link)
        }
    }
    if ((Test-Path -LiteralPath $link) -and $shell.CreateShortcut($link).TargetPath -notin $allowedTargets) {
        throw "An unrelated shortcut already uses $link; it was not replaced."
    }
    Write-TintedIcon $icon $build.Degrees
    $shortcut = $shell.CreateShortcut($link)
    $shortcut.TargetPath = $exe
    $shortcut.WorkingDirectory = Split-Path -Parent $exe
    $shortcut.IconLocation = "$icon,0"
    $shortcut.Description = $build.Name
    $shortcut.Save()
    $saved = $shell.CreateShortcut($link)
    if ($saved.TargetPath -ne $exe -or $saved.IconLocation -ne "$icon,0") { throw "Shortcut verification failed: $link" }
    Write-Host "Created: $link" -ForegroundColor Green
}
