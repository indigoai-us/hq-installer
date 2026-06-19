# build-icons.ps1
#
# Regenerate src-tauri/icons/icon.ico from src-tauri/icons/app-icon.svg as a
# multi-resolution Windows .ico containing 16x16, 32x32, 48x48, 64x64,
# 128x128, and 256x256 layers. Also refreshes the PNG layers Tauri uses
# for non-Windows targets.
#
# Prerequisites: ImageMagick (`magick.exe` on PATH).
#   - Install: `winget install --id ImageMagick.ImageMagick`
#   - Verify:  `magick --version`
#
# Usage:
#   PS> .\scripts\build-icons.ps1
#
# Optional flags:
#   -SourceSvg <path>   Override the source SVG (default: src-tauri/icons/app-icon.svg)
#   -DryRun             Print the magick invocations without running them
#
# The committed icon.ico was carried over from the macOS hq-installer fork
# and works as-is for V1 dogfood. Re-run this script after refreshing the
# Indigo brand mark, when the icon goes blurry at small sizes on the Windows
# 11 taskbar, or before any external-facing release.

[CmdletBinding()]
param(
    [string]$SourceSvg = (Join-Path (Split-Path -Parent $PSScriptRoot) "src-tauri\icons\app-icon.svg"),
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command magick -ErrorAction SilentlyContinue)) {
    Write-Error "ImageMagick `magick.exe` not on PATH. Install with: winget install --id ImageMagick.ImageMagick"
    exit 1
}

if (-not (Test-Path $SourceSvg)) {
    Write-Error "Source SVG not found at $SourceSvg"
    exit 1
}

$iconsDir = Join-Path (Split-Path -Parent $PSScriptRoot) "src-tauri\icons"
$icoOut = Join-Path $iconsDir "icon.ico"

# Sizes per the PRD US-003 spec for Windows .ico.
$sizes = 16, 32, 48, 64, 128, 256

# Stage the per-size PNGs in a temp dir so the final magick -merge call has
# one input per layer.
$staging = Join-Path $env:TEMP "hq-installer-icons-$([Guid]::NewGuid().ToString('N').Substring(0,8))"
New-Item -ItemType Directory -Path $staging -Force | Out-Null

try {
    $stagedFiles = @()
    foreach ($size in $sizes) {
        $out = Join-Path $staging "icon-$size.png"
        $cmd = @("magick", $SourceSvg, "-background", "none", "-resize", "${size}x${size}", $out)
        if ($DryRun) {
            Write-Host ($cmd -join " ")
        } else {
            & $cmd[0] $cmd[1..($cmd.Length - 1)]
            if ($LASTEXITCODE -ne 0) { throw "magick failed for size $size (exit $LASTEXITCODE)" }
            $stagedFiles += $out
        }
    }

    # Combine all PNG layers into the multi-resolution .ico.
    if ($DryRun) {
        Write-Host "magick $($stagedFiles -join ' ') $icoOut"
    } else {
        & magick @stagedFiles $icoOut
        if ($LASTEXITCODE -ne 0) { throw "magick .ico combine failed (exit $LASTEXITCODE)" }
        Write-Host "Wrote $icoOut ($($sizes -join 'x, ')x)" -ForegroundColor Green
    }

    # Refresh the PNG variants Tauri also lists in tauri.conf.json bundle.icon.
    foreach ($spec in @(@{Size=32; Name="32x32.png"}, @{Size=128; Name="128x128.png"}, @{Size=256; Name="128x128@2x.png"})) {
        $out = Join-Path $iconsDir $spec.Name
        $cmd = @("magick", $SourceSvg, "-background", "none", "-resize", "$($spec.Size)x$($spec.Size)", $out)
        if ($DryRun) {
            Write-Host ($cmd -join " ")
        } else {
            & $cmd[0] $cmd[1..($cmd.Length - 1)]
            if ($LASTEXITCODE -ne 0) { throw "magick failed for $($spec.Name) (exit $LASTEXITCODE)" }
            Write-Host "Wrote $out" -ForegroundColor Green
        }
    }
} finally {
    if (Test-Path $staging) {
        Remove-Item -Path $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ""
Write-Host "Done. Verify with: file src-tauri\icons\icon.ico" -ForegroundColor Cyan
