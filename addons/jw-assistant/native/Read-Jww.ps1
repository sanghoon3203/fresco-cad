param([Parameter(Mandatory=$true)][string]$InputPath, [Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  [void][Reflection.Assembly]::LoadFrom((Join-Path $PSScriptRoot 'vendor/JwwHelper_x64.dll'))
  $reader = New-Object JwwHelper.JwwReader
  $reader.Read($InputPath, $null)
  $entities = New-Object System.Collections.Generic.List[object]
  $index = 0
  foreach ($entity in $reader.DataList) {
    $props = [ordered]@{}
    foreach ($property in $entity.GetType().GetProperties()) {
      if ($property.Name -like 'm_*') {
        # CDataTen::Serialize stores symbol fields only for pen style 100.
        # Other points leave these native members uninitialized.
        if ($entity.GetType().Name -eq 'JwwTen' -and $entity.m_nPenStyle -ne 100 -and
            $property.Name -in @('m_nCode', 'm_radKaitenKaku', 'm_dBairitsu')) { continue }
        $value = $property.GetValue($entity, $null)
        if ($value -is [string] -or $value -is [ValueType]) { $props[$property.Name] = $value }
      }
    }
    $record = $null
    if ($entity.GetType().Name -eq 'JwwSen' -and $reader.Header.m_jwwDataVersion -ge 351) {
      $stream = New-Object IO.MemoryStream
      $writer = New-Object IO.BinaryWriter($stream)
      $writer.Write([int]$entity.m_lGroup); $writer.Write([byte]$entity.m_nPenStyle)
      foreach ($prop in @('m_nPenColor','m_nPenWidth','m_nLayer','m_nGLayer','m_sFlg')) { $writer.Write([int16]$entity.$prop) }
      foreach ($prop in @('m_start_x','m_start_y','m_end_x','m_end_y')) { $writer.Write([double]$entity.$prop) }
      $record = [Convert]::ToBase64String($stream.ToArray()); $writer.Dispose(); $stream.Dispose()
    }
    $entities.Add([ordered]@{ id = "e$index"; type = $entity.GetType().Name; props = $props; record = $record })
    $index++
    if ($index -gt 100000) { throw 'E_JWW_ENTITY_LIMIT' }
  }
  $layers = New-Object System.Collections.Generic.List[object]
  for ($g=0; $g -lt 16; $g++) {
    for ($l=0; $l -lt 16; $l++) {
      $layers.Add([ordered]@{ id = ('{0:X}:{1:X}' -f $g,$l); groupName = $reader.Header.m_aStrGLayName[$g]; name = $reader.Header.m_aStrLayName[$g][$l]; scale = $reader.Header.m_adScale[$g]; state = $reader.Header.m_aanLay[$g][$l] })
    }
  }
  $result = [ordered]@{ version = $reader.Header.m_jwwDataVersion; layers = $layers; entities = $entities; blockDefinitions = $reader.GetBlockSize(); images = $reader.Images.Length }
  $json = ConvertTo-Json -InputObject $result -Depth 12 -Compress
  [IO.File]::WriteAllText($OutputPath, $json, (New-Object System.Text.UTF8Encoding($false)))
  $reader.Dispose()
} catch {
  [Console]::Error.WriteLine('E_JWW_NATIVE_READ')
  exit 1
}
