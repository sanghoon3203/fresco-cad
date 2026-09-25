[CmdletBinding()]
param(
    [string]$SessionRoot,
    [string]$JwExePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-AbsolutePath {
    param([string]$Path)
    # IsPathRooted also accepts C:relative and \current-drive on Windows.
    # Require a drive-rooted or server/share UNC path before normalization.
    $isDriveAbsolute = $Path -match '^[A-Za-z]:[\\/]'
    $isUncAbsolute = ($Path -match '^[\\/]{2}[^\\/]+[\\/][^\\/]+([\\/]|$)') -and
        ($Path -notmatch '^[\\/]{2}[?.][\\/]')
    if ([string]::IsNullOrWhiteSpace($Path) -or
        -not ($isDriveAbsolute -or $isUncAbsolute)) {
        throw "Path must be absolute: $Path"
    }
    return [System.IO.Path]::GetFullPath($Path)
}

function Test-WithinDirectory {
    param([string]$Path, [string]$Directory)
    $separator = [System.IO.Path]::DirectorySeparatorChar
    $child = $Path.TrimEnd('\', '/') + $separator
    $parent = $Directory.TrimEnd('\', '/') + $separator
    return $child.StartsWith($parent, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-NoReparseAncestor {
    param([string]$Path)
    $current = $Path
    while (-not [string]::IsNullOrEmpty($current)) {
        $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
        if ($null -ne $item) {
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Session destination has a reparse-point ancestor: $current"
            }
        }
        $parent = [System.IO.Path]::GetDirectoryName($current.TrimEnd('\', '/'))
        if ($parent -eq $current) { break }
        $current = $parent
    }
}

$bridgeDirectory = $PSScriptRoot
$packageFiles = @(
    'Capture-JwTemp.ps1',
    'FRESCO_CAPTURE_SJIS.bat'
)
$sourceHashes = [ordered]@{}
foreach ($name in $packageFiles) {
    $source = Join-Path $bridgeDirectory $name
    $item = Get-Item -LiteralPath $source -Force -ErrorAction SilentlyContinue
    if ($null -eq $item -or $item.PSIsContainer) {
        throw "Required bridge package file is missing or invalid: $source"
    }
    $sourceHashes[$name] = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
}

if ([string]::IsNullOrWhiteSpace($SessionRoot)) {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        throw 'LOCALAPPDATA is required when SessionRoot is omitted.'
    }
    $SessionRoot = Join-Path $env:LOCALAPPDATA 'FrescoCAD\jw-sessions'
}
$root = Get-AbsolutePath $SessionRoot
if (Test-WithinDirectory $root 'C:\jww') {
    throw 'Session root must not be inside C:\jww.'
}
if (-not [string]::IsNullOrWhiteSpace($JwExePath)) {
    $jwExe = Get-AbsolutePath $JwExePath
    if (-not [System.IO.File]::Exists($jwExe)) {
        throw "Jw_cad executable does not exist: $jwExe"
    }
    if (Test-WithinDirectory $root ([System.IO.Path]::GetDirectoryName($jwExe))) {
        throw 'Session root must not be inside the Jw_cad installation directory.'
    }
}
if ([System.IO.File]::Exists($root)) {
    throw "Session root is a file: $root"
}
Assert-NoReparseAncestor $root

# The root is caller-owned. Never delete or overwrite it or an existing child.
[System.IO.Directory]::CreateDirectory($root) | Out-Null
Assert-NoReparseAncestor $root
$sessionId = [Guid]::NewGuid().ToString('N')
$sessionDirectory = Join-Path $root $sessionId
if (Test-Path -LiteralPath $sessionDirectory) {
    throw "Session directory already exists: $sessionDirectory"
}
[System.IO.Directory]::CreateDirectory($sessionDirectory) | Out-Null

$stagedHashes = [ordered]@{}
foreach ($name in $packageFiles) {
    $source = Join-Path $bridgeDirectory $name
    $destination = Join-Path $sessionDirectory $name
    $inputStream = [System.IO.FileStream]::new($source, [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    try {
        $outputStream = [System.IO.FileStream]::new($destination, [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try { $inputStream.CopyTo($outputStream) }
        finally { $outputStream.Dispose() }
    }
    finally { $inputStream.Dispose() }
    $stagedHashes[$name] = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($stagedHashes[$name] -cne $sourceHashes[$name]) {
        throw "Staged package hash mismatch: $name"
    }
}

$manifestPath = Join-Path $sessionDirectory 'session.json'
$manifest = [ordered]@{
    schemaVersion = 1
    kind = 'jwc-temp-diagnostic-session'
    sessionId = $sessionId
    createdAtUtc = [DateTime]::UtcNow.ToString('o')
    sourceDirectory = $bridgeDirectory
    sessionDirectory = $sessionDirectory
    files = @(
        foreach ($name in $packageFiles) {
            [ordered]@{
                name = $name
                sourceSha256 = $sourceHashes[$name]
                stagedSha256 = $stagedHashes[$name]
            }
        }
    )
    safety = [ordered]@{
        diagnosticOnly = $true
        nativeSessionBinding = $false
        nativeUndoVerified = $false
        hostLaunchPerformed = $false
    }
}
$json = $manifest | ConvertTo-Json -Depth 6
$utf8 = [System.Text.UTF8Encoding]::new($false)
$manifestStream = [System.IO.FileStream]::new($manifestPath, [System.IO.FileMode]::CreateNew,
    [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
try {
    $bytes = $utf8.GetBytes($json + [Environment]::NewLine)
    $manifestStream.Write($bytes, 0, $bytes.Length)
}
finally { $manifestStream.Dispose() }

[pscustomobject]@{
    SessionDirectory = $sessionDirectory
    WrapperPath = (Join-Path $sessionDirectory 'FRESCO_CAPTURE_SJIS.bat')
    TempFilePath = (Join-Path $sessionDirectory 'JWC_TEMP.TXT')
    ManifestPath = $manifestPath
}
