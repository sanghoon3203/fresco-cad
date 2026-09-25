[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) {
        throw "Assertion failed: $Message"
    }
}

function Get-Sha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$bridgeRoot = Join-Path $repoRoot 'addons\jw-assistant\bridge'
$captureScript = Join-Path $bridgeRoot 'Capture-JwTemp.ps1'
$utf8Wrapper = Join-Path $bridgeRoot 'FRESCO_CAPTURE_UTF8.bat'
$sjisWrapper = Join-Path $bridgeRoot 'FRESCO_CAPTURE_SJIS.bat'
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('fresco-bridge-' + [Guid]::NewGuid().ToString('N'))
$sourcePath = $null

try {
    $sourceDirectory = Join-Path $temporaryRoot '入力 日本語 path'
    $captureRoot = Join-Path $temporaryRoot 'captures 出力'
    [System.IO.Directory]::CreateDirectory($sourceDirectory) | Out-Null

    $sourcePath = Join-Path $sourceDirectory 'JWC_TEMP.TXT'
    $sourceText = "hq`r`nhk 0`r`nhs 50 50 50 50 50 50 50 50 50 50 50 50 50 50 50 50`r`n# 日本語`r`n0 0 1000 0`r`n"
    $shiftJis = [System.Text.Encoding]::GetEncoding(932)
    [System.IO.File]::WriteAllBytes($sourcePath, $shiftJis.GetBytes($sourceText))
    (Get-Item -LiteralPath $sourcePath).IsReadOnly = $true

    $sourceHashBefore = Get-Sha256 -Path $sourcePath
    $sourceLengthBefore = (Get-Item -LiteralPath $sourcePath).Length
    $hostExecutable = (Get-Process -Id $PID).Path

    $result = & $captureScript `
        -SourcePath $sourcePath `
        -CaptureRoot $captureRoot `
        -JwExePath $hostExecutable `
        -WrapperPath $utf8Wrapper

    Assert-True ($result.HqFirstLinePreserved -eq $true) 'hq must remain the first source line.'
    Assert-True ($result.SourceCodec -ceq 'shift-jis') 'The fixture codec must be detected as Shift-JIS.'
    Assert-True ((Get-Sha256 -Path $sourcePath) -ceq $sourceHashBefore) 'The source hash must not change.'
    Assert-True ((Get-Item -LiteralPath $sourcePath).Length -eq $sourceLengthBefore) 'The source length must not change.'
    Assert-True ((Get-Sha256 -Path $result.CapturedFile) -ceq $sourceHashBefore) 'The captured bytes must match the source.'

    $metadata = Get-Content -LiteralPath $result.MetadataFile -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-True ($metadata.capture.byteIdentical -eq $true) 'Metadata must record a byte-identical capture.'
    Assert-True ($metadata.publication.status -ceq 'complete') 'Final metadata must mark a completed copy.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $result.CaptureDirectory 'metadata.pending.json'))) 'Pending metadata must be renamed before completion.'
    Assert-True ($metadata.source.codecDetection -ceq 'heuristic') 'Codec guess must not be represented as host evidence.'
    Assert-True ($metadata.source.codec -ceq 'shift-jis') 'Metadata must record the source codec.'
    Assert-True ($metadata.source.sha256 -ceq $sourceHashBefore) 'Metadata must record the source hash.'
    Assert-True ($metadata.capture.sha256 -ceq $sourceHashBefore) 'Metadata must record the capture hash.'
    Assert-True (-not [string]::IsNullOrWhiteSpace($metadata.jwCad.fileVersion)) 'Metadata must record an executable version.'
    Assert-True ($metadata.safety.hostUndoVerified -eq $false) 'Host Undo must remain explicitly unverified.'

    $utf8Bytes = [System.IO.File]::ReadAllBytes($utf8Wrapper)
    $strictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)
    $utf8Text = $strictUtf8.GetString($utf8Bytes).TrimStart([char]0xFEFF)
    Assert-True ($utf8Text.Contains('診断用')) 'The UTF-8 wrapper must contain non-ASCII text.'
    Assert-True ($metadata.wrapper.codec -in @('utf-8', 'utf-8-bom')) 'The UTF-8 wrapper codec must be recorded.'

    $sjisBytes = [System.IO.File]::ReadAllBytes($sjisWrapper)
    $strictSjis = [System.Text.Encoding]::GetEncoding(
        932,
        [System.Text.EncoderExceptionFallback]::new(),
        [System.Text.DecoderExceptionFallback]::new()
    )
    $sjisText = $strictSjis.GetString($sjisBytes)
    Assert-True ($sjisText.Contains('診断用')) 'The Shift-JIS wrapper must contain non-ASCII text.'
    $sjisIsUtf8 = $true
    try {
        $null = $strictUtf8.GetString($sjisBytes)
    }
    catch {
        $sjisIsUtf8 = $false
    }
    Assert-True (-not $sjisIsUtf8) 'The Shift-JIS wrapper must not decode as strict UTF-8.'

    $installationRootRejected = $false
    try {
        $null = & $captureScript -SourcePath $sourcePath -CaptureRoot 'C:\jww\fresco-captures'
    }
    catch {
        $installationRootRejected = $_.Exception.Message -like '*Capture root must not be inside C:\jww*'
    }
    Assert-True $installationRootRejected 'C:\jww must be rejected even without JwExePath.'
    Assert-True ((Get-Sha256 -Path $sourcePath) -ceq $sourceHashBefore) 'Rejected destination must leave the source untouched.'

    foreach ($wrapperText in @($utf8Text, $sjisText)) {
        foreach ($directive in @('#jww', '#cd', '#hf', '#h1', '#hc', '#g1', '#e')) {
            Assert-True ($wrapperText.Contains($directive)) "Wrapper is missing directive $directive."
        }
        Assert-True (-not ($wrapperText -match '(?im)^\s*REM\s+#?hd\s*$')) 'Wrapper must not contain the hd deletion command.'
        Assert-True (-not ($wrapperText -match '(?im)^\s*(copy|move|del|erase)\s+.*JWC_TEMP')) 'Wrapper must not mutate JWC_TEMP.'
        Assert-True (-not ($wrapperText -match '(?im)JWC_TEMP[^\r\n]*>')) 'Wrapper must not redirect output into JWC_TEMP.'
    }

    $lockedSource = Join-Path $sourceDirectory 'locked.txt'
    [System.IO.File]::WriteAllText($lockedSource, "hq`r`n", [System.Text.Encoding]::ASCII)
    $lockedCaptureRoot = Join-Path $temporaryRoot 'locked-captures'
    $lock = [System.IO.FileStream]::new(
        $lockedSource,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
    try {
        $lockFailedClosed = $false
        try {
            $null = & $captureScript -SourcePath $lockedSource -CaptureRoot $lockedCaptureRoot
        }
        catch {
            $lockFailedClosed = $true
        }
        Assert-True $lockFailedClosed 'An exclusively locked source must fail closed.'
        Assert-True (-not (Test-Path -LiteralPath $lockedCaptureRoot)) 'Lock failure must not create a capture root.'
    }
    finally {
        $lock.Dispose()
    }

    $badSource = Join-Path $sourceDirectory 'no-hq.txt'
    [System.IO.File]::WriteAllText($badSource, "0 0 100 0`r`n", [System.Text.Encoding]::ASCII)
    $badRoot = Join-Path $temporaryRoot 'rejected-header'
    $badHeaderRejected = $false
    try { $null = & $captureScript -SourcePath $badSource -CaptureRoot $badRoot }
    catch { $badHeaderRejected = $_.Exception.Message -like '*requires hq*' }
    Assert-True $badHeaderRejected 'A missing hq must fail before publishing.'
    Assert-True (-not (Test-Path -LiteralPath $badRoot)) 'Rejected header must not create a capture directory.'

    foreach ($badPath in @('C:relative', '\current-drive', '\\?\C:\jww\captures')) {
        $badPathRejected = $false
        try { $null = & $captureScript -SourcePath $sourcePath -CaptureRoot $badPath }
        catch { $badPathRejected = $_.Exception.Message -like 'Path must be absolute:*' }
        Assert-True $badPathRejected 'Drive-relative, current-drive and device paths must be rejected.'
    }
    $junctionTarget = Join-Path $temporaryRoot 'junction-target'
    $junctionPath = Join-Path $temporaryRoot 'junction-alias'
    [System.IO.Directory]::CreateDirectory($junctionTarget) | Out-Null
    $null = New-Item -ItemType Junction -Path $junctionPath -Target $junctionTarget
    try {
        $junctionRejected = $false
        try { $null = & $captureScript -SourcePath $sourcePath -CaptureRoot (Join-Path $junctionPath 'nested') }
        catch { $junctionRejected = $_.Exception.Message -like '*reparse-point ancestor*' }
        Assert-True $junctionRejected 'Destination aliases must fail closed.'
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $junctionTarget 'nested'))) 'Alias rejection must not create captures.'
    }
    finally { Remove-Item -LiteralPath $junctionPath -Force }

    Write-Host 'bridge_capture.test.ps1: PASS'
}
finally {
    $fullTemporaryRoot = [System.IO.Path]::GetFullPath($temporaryRoot)
    $expectedParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    if (-not $fullTemporaryRoot.StartsWith($expectedParent, [System.StringComparison]::OrdinalIgnoreCase) -or
        [System.IO.Path]::GetFileName($fullTemporaryRoot) -notmatch '^fresco-bridge-[0-9a-f]{32}$') {
        throw "Refusing unsafe test cleanup: $fullTemporaryRoot"
    }
    if ($null -ne $sourcePath -and (Test-Path -LiteralPath $sourcePath -ErrorAction SilentlyContinue)) {
        (Get-Item -LiteralPath $sourcePath).IsReadOnly = $false
    }
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}
