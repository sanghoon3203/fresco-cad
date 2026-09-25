[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SourcePath,

    [Parameter(Mandatory = $true)]
    [string]$CaptureRoot,

    [string]$JwExePath,

    [string]$WrapperPath,

    [ValidateRange(1, 512)]
    [int]$MaximumMegabytes = 64
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-AbsolutePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $isDriveAbsolute = $Path -match '^[A-Za-z]:[\\/]'
    $isUncAbsolute = ($Path -match '^[\\/]{2}[^\\/]+[\\/][^\\/]+([\\/]|$)') -and
        ($Path -notmatch '^[\\/]{2}[?.][\\/]')
    if ([string]::IsNullOrWhiteSpace($Path) -or -not ($isDriveAbsolute -or $isUncAbsolute)) {
        throw "Path must be absolute: $Path"
    }

    return [System.IO.Path]::GetFullPath($Path)
}

function Get-ExistingFilePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    $absolutePath = Get-AbsolutePath -Path $Path
    if (-not [System.IO.File]::Exists($absolutePath)) {
        throw "$Label does not exist or is not a file: $absolutePath"
    }

    return $absolutePath
}

function Test-PathWithinDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$Directory
    )

    $separator = [System.IO.Path]::DirectorySeparatorChar
    $pathWithSeparator = $Path.TrimEnd('\', '/') + $separator
    $directoryWithSeparator = $Directory.TrimEnd('\', '/') + $separator
    return $pathWithSeparator.StartsWith($directoryWithSeparator, [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-StableFileBytes {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [long]$MaximumBytes
    )

    $before = Get-Item -LiteralPath $Path -Force
    $stream = $null
    try {
        # FileShare.Read prevents a writer from changing the source during capture.
        # A concurrently held incompatible lock fails closed before any capture is written.
        $stream = [System.IO.FileStream]::new(
            $Path,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::Read,
            65536,
            [System.IO.FileOptions]::SequentialScan
        )

        if ($stream.Length -gt $MaximumBytes) {
            throw "Source exceeds the configured limit of $MaximumBytes bytes."
        }

        $bytes = [byte[]]::new([int]$stream.Length)
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
            if ($read -eq 0) {
                throw "Unexpected end of file while reading: $Path"
            }
            $offset += $read
        }
    }
    finally {
        if ($null -ne $stream) {
            $stream.Dispose()
        }
    }

    $after = Get-Item -LiteralPath $Path -Force
    if (($before.Length -ne $after.Length) -or
        ($before.LastWriteTimeUtc -ne $after.LastWriteTimeUtc)) {
        throw "Source changed during capture: $Path"
    }

    return [pscustomobject]@{
        Bytes = $bytes
        Length = [long]$after.Length
        LastWriteTimeUtc = $after.LastWriteTimeUtc
    }
}

function Get-Sha256Hex {
    param(
        [Parameter(Mandatory = $true)]
        [byte[]]$Bytes
    )

    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        return (($sha256.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) -join '')
    }
    finally {
        $sha256.Dispose()
    }
}

function Get-TextCodec {
    param(
        [Parameter(Mandatory = $true)]
        [byte[]]$Bytes
    )

    if ($Bytes.Length -ge 3 -and
        $Bytes[0] -eq 0xEF -and
        $Bytes[1] -eq 0xBB -and
        $Bytes[2] -eq 0xBF) {
        $utf8Bom = [System.Text.UTF8Encoding]::new($true, $true)
        try {
            $null = $utf8Bom.GetString($Bytes)
            return 'utf-8-bom'
        }
        catch {
            return 'unknown'
        }
    }

    $hasNonAscii = $false
    foreach ($value in $Bytes) {
        if ($value -gt 0x7F) {
            $hasNonAscii = $true
            break
        }
    }
    if (-not $hasNonAscii) {
        return 'ascii-compatible'
    }

    $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
    try {
        $null = $utf8.GetString($Bytes)
        return 'utf-8'
    }
    catch {
        # Try the legacy encoding used by the installed official sample next.
    }

    try {
        $shiftJis = [System.Text.Encoding]::GetEncoding(
            932,
            [System.Text.EncoderExceptionFallback]::new(),
            [System.Text.DecoderExceptionFallback]::new()
        )
        $null = $shiftJis.GetString($Bytes)
        return 'shift-jis'
    }
    catch {
        return 'unknown'
    }
}

function Test-HqFirstLine {
    param(
        [Parameter(Mandatory = $true)]
        [byte[]]$Bytes,

        [Parameter(Mandatory = $true)]
        [string]$Codec
    )

    try {
        switch ($Codec) {
            'utf-8-bom' { $encoding = [System.Text.UTF8Encoding]::new($true, $true) }
            'utf-8' { $encoding = [System.Text.UTF8Encoding]::new($false, $true) }
            'ascii-compatible' { $encoding = [System.Text.Encoding]::ASCII }
            'shift-jis' {
                $encoding = [System.Text.Encoding]::GetEncoding(
                    932,
                    [System.Text.EncoderExceptionFallback]::new(),
                    [System.Text.DecoderExceptionFallback]::new()
                )
            }
            default { return $false }
        }

        $text = $encoding.GetString($Bytes).TrimStart([char]0xFEFF)
        $firstLine = ($text -split "`r?`n", 2)[0].Trim()
        return $firstLine -ceq 'hq'
    }
    catch {
        return $false
    }
}

$sourceFullPath = Get-ExistingFilePath -Path $SourcePath -Label 'Source'
$captureRootFullPath = Get-AbsolutePath -Path $CaptureRoot

# Reject existing destination aliases before applying installation-directory guards.
$ancestor = $captureRootFullPath
while (-not [string]::IsNullOrEmpty($ancestor)) {
    $item = Get-Item -LiteralPath $ancestor -Force -ErrorAction SilentlyContinue
    if ($null -ne $item -and ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Capture destination has a reparse-point ancestor: $ancestor"
    }
    $parent = [System.IO.Path]::GetDirectoryName($ancestor.TrimEnd('\', '/'))
    if ($parent -eq $ancestor) { break }
    $ancestor = $parent
}

if ([System.IO.File]::Exists($captureRootFullPath)) {
    throw "Capture root is a file: $captureRootFullPath"
}

if ([System.IO.Path]::DirectorySeparatorChar -eq '\' -and
    (Test-PathWithinDirectory -Path $captureRootFullPath -Directory 'C:\jww')) {
    throw 'Capture root must not be inside C:\jww.'
}

$wrapperFullPath = $null
$wrapperSnapshot = $null
if (-not [string]::IsNullOrWhiteSpace($WrapperPath)) {
    $wrapperFullPath = Get-ExistingFilePath -Path $WrapperPath -Label 'Wrapper'
    $wrapperSnapshot = Get-StableFileBytes -Path $wrapperFullPath -MaximumBytes (4MB)
}

$jwFullPath = $null
$jwMetadata = $null
if (-not [string]::IsNullOrWhiteSpace($JwExePath)) {
    $jwFullPath = Get-ExistingFilePath -Path $JwExePath -Label 'Jw_cad executable'
    $jwDirectory = [System.IO.Path]::GetDirectoryName($jwFullPath)
    if (Test-PathWithinDirectory -Path $captureRootFullPath -Directory $jwDirectory) {
        throw 'Capture root must not be inside the Jw_cad installation directory.'
    }

    $jwFile = Get-Item -LiteralPath $jwFullPath -Force
    $jwVersion = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($jwFullPath)
    $jwMetadata = [ordered]@{
        path = $jwFullPath
        length = [long]$jwFile.Length
        fileVersion = $jwVersion.FileVersion
        productVersion = $jwVersion.ProductVersion
        sha256 = (Get-FileHash -LiteralPath $jwFullPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}

$maximumBytes = [long]$MaximumMegabytes * 1MB
$sourceSnapshot = Get-StableFileBytes -Path $sourceFullPath -MaximumBytes $maximumBytes
$sourceHash = Get-Sha256Hex -Bytes $sourceSnapshot.Bytes
$sourceCodec = Get-TextCodec -Bytes $sourceSnapshot.Bytes
$hqFirstLine = Test-HqFirstLine -Bytes $sourceSnapshot.Bytes -Codec $sourceCodec
if (-not $hqFirstLine) {
    throw 'Diagnostic capture requires hq as the first record.'
}

[System.IO.Directory]::CreateDirectory($captureRootFullPath) | Out-Null
$captureId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmss.fffffffZ') + '_' + [Guid]::NewGuid().ToString('N')
$bundlePath = Join-Path $captureRootFullPath $captureId
[System.IO.Directory]::CreateDirectory($bundlePath) | Out-Null

$capturePath = Join-Path $bundlePath 'JWC_TEMP.TXT'
$metadataPath = Join-Path $bundlePath 'metadata.json'
$pendingMetadataPath = Join-Path $bundlePath 'metadata.pending.json'
[System.IO.File]::WriteAllBytes($capturePath, $sourceSnapshot.Bytes)

$capturedBytes = [System.IO.File]::ReadAllBytes($capturePath)
$capturedHash = Get-Sha256Hex -Bytes $capturedBytes
if ($capturedHash -cne $sourceHash) {
    throw "Captured bytes failed SHA-256 verification: $capturePath"
}

$wrapperMetadata = $null
if ($null -ne $wrapperSnapshot) {
    $wrapperMetadata = [ordered]@{
        path = $wrapperFullPath
        length = $wrapperSnapshot.Length
        codec = (Get-TextCodec -Bytes $wrapperSnapshot.Bytes)
        sha256 = (Get-Sha256Hex -Bytes $wrapperSnapshot.Bytes)
    }
}

$metadata = [ordered]@{
    schemaVersion = 1
    captureKind = 'jwc-temp-diagnostic'
    publication = [ordered]@{ status = 'complete' }
    capturedAtUtc = [DateTime]::UtcNow.ToString('o')
    source = [ordered]@{
        path = $sourceFullPath
        length = $sourceSnapshot.Length
        lastWriteTimeUtc = $sourceSnapshot.LastWriteTimeUtc.ToString('o')
        codec = $sourceCodec
        codecDetection = 'heuristic'
        sha256 = $sourceHash
        hqFirstLinePreserved = $hqFirstLine
    }
    capture = [ordered]@{
        path = $capturePath
        length = [long]$capturedBytes.Length
        sha256 = $capturedHash
        byteIdentical = $true
    }
    wrapper = $wrapperMetadata
    jwCad = $jwMetadata
    safety = [ordered]@{
        sourceOpenedReadOnly = $true
        sourceWasNotRewritten = $true
        jwcTempCommandsAdded = @()
        hostUndoVerified = $false
    }
}

$metadataJson = $metadata | ConvertTo-Json -Depth 8
$utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)
# Publish the completion marker only after the copy and its digest are verified.
# A same-directory rename makes readers see either no final metadata or a full file.
[System.IO.File]::WriteAllText($pendingMetadataPath, $metadataJson + [Environment]::NewLine, $utf8WithoutBom)
[System.IO.File]::Move($pendingMetadataPath, $metadataPath)

[pscustomobject]@{
    CaptureDirectory = $bundlePath
    CapturedFile = $capturePath
    MetadataFile = $metadataPath
    Sha256 = $sourceHash
    SourceCodec = $sourceCodec
    HqFirstLinePreserved = $hqFirstLine
}
