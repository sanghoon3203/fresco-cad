[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "Assertion failed: $Message" }
}

function Assert-Throws {
    param([scriptblock]$Action, [string]$Message)
    $threw = $false
    try { & $Action | Out-Null }
    catch { $threw = $true }
    Assert-True $threw $Message
}

function Assert-ThrowsLike {
    param([scriptblock]$Action, [string]$Pattern, [string]$Message)
    $matched = $false
    try { & $Action | Out-Null }
    catch { $matched = $_.Exception.Message -like $Pattern }
    Assert-True $matched $Message
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$bridge = Join-Path $repoRoot 'addons\jw-assistant\bridge'
$script = Join-Path $bridge 'New-JwCaptureSession.ps1'
$testId = [Guid]::NewGuid().ToString('N')
$testRoot = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) "fresco-session-test-$testId"))

try {
    $sessionRoot = Join-Path $testRoot '日本語 spaces\sessions'
    [System.IO.Directory]::CreateDirectory($sessionRoot) | Out-Null
    $sentinel = Join-Path $sessionRoot 'existing-user-file.txt'
    [System.IO.File]::WriteAllText($sentinel, 'keep')

    $first = & $script -SessionRoot $sessionRoot
    $second = & $script -SessionRoot $sessionRoot
    Assert-True ($first.SessionDirectory -cne $second.SessionDirectory) 'Two sessions need distinct directories.'
    foreach ($session in @($first, $second)) {
        Assert-True ($session.SessionDirectory.StartsWith($sessionRoot + [System.IO.Path]::DirectorySeparatorChar,
            [System.StringComparison]::OrdinalIgnoreCase)) 'Session must be below test root.'
        Assert-True (Test-Path -LiteralPath $session.WrapperPath -PathType Leaf) 'SJIS wrapper must be staged.'
        Assert-True (-not (Test-Path -LiteralPath $session.TempFilePath)) 'Jw_cad must create the temp file later.'
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $session.SessionDirectory 'FRESCO_CAPTURE_UTF8.bat'))) 'UTF8 wrapper must not be staged.'
        $manifest = Get-Content -LiteralPath $session.ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        Assert-True ($manifest.files.Count -eq 2) 'Exactly two package files must be staged.'
        Assert-True ($manifest.safety.nativeSessionBinding -eq $false) 'Manifest must not claim native binding.'
        Assert-True ($manifest.safety.hostLaunchPerformed -eq $false) 'Manifest must not claim launch.'
        foreach ($file in $manifest.files) {
            $sourceHash = (Get-FileHash -LiteralPath (Join-Path $bridge $file.name) -Algorithm SHA256).Hash.ToLowerInvariant()
            $stagedHash = (Get-FileHash -LiteralPath (Join-Path $session.SessionDirectory $file.name) -Algorithm SHA256).Hash.ToLowerInvariant()
            Assert-True ($file.sourceSha256 -ceq $sourceHash) 'Source manifest hash must match.'
            Assert-True ($file.stagedSha256 -ceq $sourceHash) 'Staged package hash must match.'
            Assert-True ($stagedHash -ceq $sourceHash) 'Staged file bytes must match source.'
        }
    }
    Assert-True (([System.IO.File]::ReadAllText($sentinel)) -ceq 'keep') 'Existing user file must remain intact.'

    Assert-Throws { & $script -SessionRoot 'relative\sessions' } 'Relative root must be rejected.'
    Assert-ThrowsLike { & $script -SessionRoot 'C:relative\sessions' } 'Path must be absolute:*' 'Drive-relative root must be rejected as nonabsolute.'
    Assert-ThrowsLike { & $script -SessionRoot '\current-drive\sessions' } 'Path must be absolute:*' 'Current-drive-rooted path must be rejected as nonabsolute.'
    Assert-ThrowsLike { & $script -SessionRoot '\\?\C:\jww\fresco-session' } 'Path must be absolute:*' 'Device path must not bypass installation-root rejection.'
    Assert-Throws { & $script -SessionRoot 'C:\jww\fresco-session' } 'Installation root must be rejected.'
    Assert-Throws { & $script -SessionRoot $sentinel } 'File root must be rejected.'

    $junctionTarget = Join-Path $testRoot 'junction-target'
    $junctionPath = Join-Path $testRoot 'junction-alias'
    [System.IO.Directory]::CreateDirectory($junctionTarget) | Out-Null
    $null = New-Item -ItemType Junction -Path $junctionPath -Target $junctionTarget
    try {
        Assert-Throws { & $script -SessionRoot (Join-Path $junctionPath 'nested') } 'Reparse-point ancestor must be rejected.'
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $junctionTarget 'nested'))) 'Reparse rejection must not write through alias.'
    }
    finally {
        Remove-Item -LiteralPath $junctionPath -Force
    }

    $incompleteBridge = Join-Path $testRoot 'incomplete-bridge'
    [System.IO.Directory]::CreateDirectory($incompleteBridge) | Out-Null
    Copy-Item -LiteralPath $script -Destination (Join-Path $incompleteBridge 'New-JwCaptureSession.ps1')
    $missingRoot = Join-Path $testRoot 'missing-package-output'
    Assert-Throws { & (Join-Path $incompleteBridge 'New-JwCaptureSession.ps1') -SessionRoot $missingRoot } 'Missing package must be rejected.'
    Assert-True (-not (Test-Path -LiteralPath $missingRoot)) 'Missing package must fail before creating a root.'

    Write-Host 'bridge_session.test.ps1: PASS'
}
finally {
    $fullRoot = [System.IO.Path]::GetFullPath($testRoot)
    $expectedParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    $safeName = [System.IO.Path]::GetFileName($fullRoot) -ceq "fresco-session-test-$testId"
    if (-not $safeName -or -not $fullRoot.StartsWith($expectedParent, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing unsafe test cleanup: $fullRoot"
    }
    if (Test-Path -LiteralPath $fullRoot) {
        Remove-Item -LiteralPath $fullRoot -Recurse -Force
    }
}
