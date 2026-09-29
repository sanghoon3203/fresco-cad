param([Parameter(Mandatory=$true)][string]$InputPath, [Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  [void][Reflection.Assembly]::LoadFrom((Join-Path $PSScriptRoot 'vendor/JwwHelper_x64.dll'))
  $reader = New-Object JwwHelper.JwwReader
  $reader.Read($InputPath, $null)
  $script:entityCount = 0
  $script:diagnostics = New-Object System.Collections.Generic.List[object]
  function Convert-Entity($entity, [string]$id, [int]$depth = 0) {
    if ($depth -gt 32 -or ++$script:entityCount -gt 100000) { throw 'E_JWW_ENTITY_LIMIT' }
    $props = [ordered]@{}
    foreach ($property in $entity.GetType().GetProperties()) {
      if ($property.Name -like 'm_*') {
        # CDataTen::Serialize stores symbol fields only for pen style 100.
        # Other points leave these native members uninitialized.
        if ($entity.GetType().Name -eq 'JwwTen' -and $entity.m_nPenStyle -ne 100 -and
            $property.Name -in @('m_nCode', 'm_radKaitenKaku', 'm_dBairitsu')) { continue }
        if ($entity.GetType().Name -eq 'JwwSolid' -and $entity.m_nPenColor -ne 10 -and $property.Name -eq 'm_Color') { continue }
        $value = $property.GetValue($entity, $null)
        if ($value -is [double] -and ([double]::IsNaN($value) -or [double]::IsInfinity($value))) {
          $script:diagnostics.Add([ordered]@{ code = 'NONFINITE_FIELD'; entityId = $id; field = $property.Name })
          $props[$property.Name] = $null
        } elseif ($value -is [string] -or ($value -is [ValueType] -and $value -isnot [DateTime])) { $props[$property.Name] = $value }
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
    $result = [ordered]@{ id = $id; type = $entity.GetType().Name; props = $props; record = $record }
    if ($entity.GetType().Name -eq 'JwwSunpou') {
      # The bundled upstream wrapper misbinds auxiliary lines; expose only reliable core components.
      $result.components = @((Convert-Entity $entity.m_Sen "$id/line" ($depth + 1)), (Convert-Entity $entity.m_Moji "$id/text" ($depth + 1)))
      $script:diagnostics.Add([ordered]@{ code = 'DIMENSION_AUXILIARY_UNAVAILABLE'; entityId = $id })
    }
    return $result
  }
  $entities = New-Object System.Collections.Generic.List[object]
  $index = 0
  foreach ($entity in $reader.DataList) {
    $entities.Add((Convert-Entity $entity "e$index"))
    $index++
    if ($index -gt 100000) { throw 'E_JWW_ENTITY_LIMIT' }
  }
  $blocks = New-Object System.Collections.Generic.List[object]
  $blockIndex = 0
  foreach ($block in $reader.DataListList) {
    $children = New-Object System.Collections.Generic.List[object]
    $blockId = "b$blockIndex"
    $callback = [JwwHelper.JwwDataList+EnumerateShapeCallback]{ param($child)
      $children.Add((Convert-Entity $child "$blockId/e$($children.Count)"))
      return $true
    }
    [void]$block.EnumerateDataList($callback)
    $blocks.Add([ordered]@{ id = $blockId; number = [int]$block.m_nNumber; name = $block.m_strName; declaredCount = $block.GetSize(); entities = $children })
    if ($children.Count -ne $block.GetSize()) { $script:diagnostics.Add([ordered]@{ code = 'BLOCK_CHILDREN_SKIPPED'; blockId = $blockId }) }
    $blockIndex++
  }
  $imageMetadata = @($reader.Images | ForEach-Object { [ordered]@{ name = $_.ImageName; compressedBytes = $_.Size } })
  $layers = New-Object System.Collections.Generic.List[object]
  for ($g=0; $g -lt 16; $g++) {
    for ($l=0; $l -lt 16; $l++) {
      $layers.Add([ordered]@{ id = ('{0:X}:{1:X}' -f $g,$l); groupName = $reader.Header.m_aStrGLayName[$g]; name = $reader.Header.m_aStrLayName[$g][$l]; scale = $reader.Header.m_adScale[$g]; state = $reader.Header.m_aanLay[$g][$l] })
    }
  }
  $result = [ordered]@{ readerSchemaVersion = 2; version = $reader.Header.m_jwwDataVersion; layers = $layers; entities = $entities; blockDefinitions = $reader.GetBlockSize(); blocks = $blocks; images = $reader.Images.Length; imageMetadata = $imageMetadata; diagnostics = $script:diagnostics }
  $json = ConvertTo-Json -InputObject $result -Depth 32 -Compress
  [IO.File]::WriteAllText($OutputPath, $json, (New-Object System.Text.UTF8Encoding($false)))
  $reader.Dispose()
} catch {
  [Console]::Error.WriteLine(('E_JWW_NATIVE_READ: ' + $_.Exception.Message))
  exit 1
}
