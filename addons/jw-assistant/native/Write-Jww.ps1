# Low-level JWW rewrite with the bundled JwwHelper DLL. Ops are already in file coordinates (Node converts).
#   -Mode Write : read InputPath, apply ops {op:delete|set|add}, InitHeader(InputPath), write OutputPath; stdout = one JSON summary line.
#   -Mode Header: read InputPath, dump every header property to OutputPath as JSON (used to compare headers across a rewrite).
# Numbers in ops arrive as strings (exact double round trip). All failures: stderr `E_JWW_NATIVE_WRITE: ...`, exit 1. ASCII only.
param([Parameter(Mandatory=$true)][string]$InputPath, [string]$OpsPath, [Parameter(Mandatory=$true)][string]$OutputPath, [ValidateSet('Write','Header')][string]$Mode = 'Write')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$invariant = [Globalization.CultureInfo]::InvariantCulture
$utf8 = New-Object System.Text.UTF8Encoding($false)
$addable = @('JwwSen', 'JwwMoji', 'JwwEnko', 'JwwTen')

function ConvertTo-Native($value, [Type]$type, [string]$name) {
  if ($type -eq [string]) { if ($value -isnot [string]) { throw "bad string for $name" }; return $value }
  $text = [Convert]::ToString($value, $invariant)
  if ($type -eq [double]) { $d = [double]::Parse($text, [Globalization.NumberStyles]::Float, $invariant); if ([double]::IsNaN($d) -or [double]::IsInfinity($d)) { throw "non-finite $name" }; return $d }
  if ($type -eq [int16]) { return [int16]::Parse($text, $invariant) }
  if ($type -eq [int]) { return [int]::Parse($text, $invariant) }
  if ($type -eq [byte]) { return [byte]::Parse($text, $invariant) }
  throw "unsupported property type $($type.Name) for $name"
}
function Set-Props($entity, $props) {
  foreach ($name in $props.Keys) {
    $info = $entity.GetType().GetProperty([string]$name)
    if (-not $info -or -not $info.CanWrite -or $name -notlike 'm_*') { throw "E_JWW_UNKNOWN_PROPERTY $($entity.GetType().Name).$name" }
    $info.SetValue($entity, (ConvertTo-Native $props[$name] $info.PropertyType $name), $null)
  }
}
function Dump-Value($value, [int]$depth = 0) {
  if ($depth -gt 4) { throw 'header nesting' }
  if ($null -eq $value) { return $null }
  if ($value -is [string]) { return $value }
  if ($value -is [double]) { if ([double]::IsNaN($value) -or [double]::IsInfinity($value)) { return $null }; return $value }
  if ($value -is [ValueType]) { return $value }
  $kind = $value.GetType().Name
  if ($kind -like 'WrapArray*' -or $kind -eq 'CStringArray') { return @(for ($i = 0; $i -lt $value.Length; $i++) { Dump-Value $value[$i] ($depth + 1) }) }
  if ($value -is [Array]) { return @($value | ForEach-Object { Dump-Value $_ ($depth + 1) }) }
  return $null
}

try {
  [void][Reflection.Assembly]::LoadFrom((Join-Path $PSScriptRoot 'vendor/JwwHelper_x64.dll'))
  $acp = [Text.Encoding]::GetEncoding(0).CodePage
  $reader = New-Object JwwHelper.JwwReader
  $reader.Read($InputPath, $null)
  $header = [ordered]@{ acp = $acp }
  foreach ($property in $reader.Header.GetType().GetProperties()) { $header[$property.Name] = Dump-Value ($property.GetValue($reader.Header, $null)) }
  if ($Mode -eq 'Header') {
    [IO.File]::WriteAllText($OutputPath, (ConvertTo-Json -InputObject $header -Depth 8 -Compress), $utf8)
    $reader.Dispose()
    exit 0
  }
  if ($acp -ne 932) { throw "E_JWW_ACP system ANSI code page is $acp, not 932 (Shift_JIS); native strings would be corrupted" }
  if (-not $OpsPath) { throw 'OpsPath required' }
  Add-Type -AssemblyName System.Web.Extensions
  $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
  $serializer.MaxJsonLength = [int]::MaxValue
  $plan = $serializer.DeserializeObject([IO.File]::ReadAllText($OpsPath, $utf8))
  $items = New-Object System.Collections.Generic.List[object]
  foreach ($entity in $reader.DataList) { $items.Add($entity) }
  $original = $items.Count
  $added = New-Object System.Collections.Generic.List[object]
  $deleted = 0
  foreach ($op in $plan['ops']) {
    switch ($op['op']) {
      'delete' {
        $i = [int]$op['index']
        if ($i -lt 0 -or $i -ge $original -or $null -eq $items[$i]) { throw "E_JWW_BAD_INDEX delete $i" }
        $items[$i] = $null; $deleted++
      }
      'set' {
        $i = [int]$op['index']
        if ($i -lt 0 -or $i -ge $original -or $null -eq $items[$i]) { throw "E_JWW_BAD_INDEX set $i" }
        if ($items[$i].GetType().Name -ne $op['type']) { throw "E_JWW_TYPE_MISMATCH index $i is $($items[$i].GetType().Name), expected $($op['type'])" }
        Set-Props $items[$i] $op['props']
      }
      'add' {
        if ($op['type'] -notin $addable) { throw "E_JWW_UNSUPPORTED_ADD $($op['type'])" }
        $entity = New-Object ('JwwHelper.' + $op['type'])
        Set-Props $entity $op['props']
        $added.Add($entity)
      }
      default { throw "E_JWW_BAD_OP $($op['op'])" }
    }
  }
  $writer = New-Object JwwHelper.JwwWriter
  $writer.InitHeader($InputPath)
  $written = 0
  foreach ($entity in $items) { if ($null -ne $entity) { $writer.AddData($entity); $written++ } }
  foreach ($entity in $added) { $writer.AddData($entity); $written++ }
  $blocks = 0
  foreach ($block in $reader.DataListList) { $writer.AddDataList($block); $blocks++ }
  $imageCount = 0
  foreach ($image in $reader.Images) { $writer.AddImage($image); $imageCount++ }
  $writer.Write($OutputPath)
  if (-not (Test-Path -LiteralPath $OutputPath)) { throw 'writer produced no file' }
  $writer.Dispose(); $reader.Dispose()
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject ([ordered]@{ acp = $acp; original = $original; deleted = $deleted; added = $added.Count; written = $written; blocks = $blocks; images = $imageCount; header = $header }) -Depth 8 -Compress))
} catch {
  [Console]::Error.WriteLine(('E_JWW_NATIVE_WRITE: ' + $_.Exception.Message))
  exit 1
}
