param([Parameter(Mandatory=$true)][string]$ScenePath, [Parameter(Mandatory=$true)][string]$OutputPath)
# Rasterize a flattened scene (paper mm, Y-up) with Jw_cad print-like pens: black lines whose width follows the
# office pen table (pen color -> print width), dashed styles approximated, solids filled with their RGB.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Web.Extensions
$serializer = New-Object Web.Script.Serialization.JavaScriptSerializer
$serializer.MaxJsonLength = [int]::MaxValue
$scene = $serializer.DeserializeObject([IO.File]::ReadAllText($ScenePath))
$bbox = $scene['bbox']; $margin = 5.0
$wMm = [double]$bbox[2] - [double]$bbox[0] + 2 * $margin; $hMm = [double]$bbox[3] - [double]$bbox[1] + 2 * $margin
$scale = [double]$scene['pxPerMm']
if ($scale -le 0) { $scale = [Math]::Min([double]$scene['maxPx'] / $wMm, [double]$scene['maxPx'] / $hMm) }
$W = [int][Math]::Ceiling($wMm * $scale); $H = [int][Math]::Ceiling($hMm * $scale)
$bmp = New-Object Drawing.Bitmap $W, $H
$g = [Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'; $g.Clear([Drawing.Color]::White)
function X([double]$x) { [float](($x - [double]$bbox[0] + $margin) * $scale) }
function Y([double]$y) { [float](($([double]$bbox[3]) - $y + $margin) * $scale) }
# Office pen table from the practice JWF (PCOLLOR W column, 1/100 mm): 1:0.08 2:0.12 3:0.06 4:0.07 5:0.10 6:0.15 7:0.07 8:0.08
$widthMm = @{ 1 = 0.18; 2 = 0.35; 3 = 0.13; 4 = 0.15; 5 = 0.25; 6 = 0.5; 7 = 0.15; 8 = 0.18; 9 = 0.13 }
$gray = @{ 3 = 190; 7 = 100; 9 = 160 }
$dash = @{ 2 = @(3, 3); 3 = @(6, 3); 4 = @(8, 2, 1, 2); 5 = @(12, 2, 1, 2); 6 = @(16, 2, 2, 2); 7 = @(10, 2, 1, 2, 1, 2); 8 = @(16, 2, 1, 2, 1, 2); 9 = @(1, 2) }
$pens = @{}
function Get-Pen($color, $style) {
  $key = "$color/$style"
  if (-not $pens.ContainsKey($key)) {
    $c = [int]$color; if ($c -gt 9) { $c = 2 }
    $v = if ($gray.ContainsKey($c)) { $gray[$c] } else { 0 }
    $w = [float]([Math]::Max(1.0, $widthMm[$c] * $scale))
    $pen = New-Object Drawing.Pen ([Drawing.Color]::FromArgb(255, $v, $v, $v)), $w
    $s = [int]$style
    if ($dash.ContainsKey($s)) { $pen.DashPattern = [float[]]($dash[$s] | ForEach-Object { [float]([Math]::Max(1, $_ * $scale * 0.5) / $w) }) }
    $pens[$key] = $pen
  }
  $pens[$key]
}
$solidBrushes = @{}
foreach ($p in $scene['primitives']) {
  $pts = $p['pts']
  switch ($p['t']) {
    'solid' {
      $rgb = $p['rgb']
      $col = if ($rgb -ne $null) { [Drawing.Color]::FromArgb(255, $rgb -band 0xFF, ($rgb -shr 8) -band 0xFF, ($rgb -shr 16) -band 0xFF) } else { [Drawing.Color]::FromArgb(255, 200, 200, 200) }
      $brush = New-Object Drawing.SolidBrush $col
      $g.FillPolygon($brush, [Drawing.PointF[]]@($pts | ForEach-Object { New-Object Drawing.PointF (X $_[0]), (Y $_[1]) })); $brush.Dispose()
    }
    'text' {
      $size = [float]([Math]::Max(1.0, [double]$p['height'] * $scale))
      $font = New-Object Drawing.Font 'MS Gothic', $size, ([Drawing.GraphicsUnit]::Pixel)
      $state = $g.Save(); $g.TranslateTransform((X $pts[0][0]), (Y $pts[0][1])); $g.RotateTransform(-[float]$p['angle'])
      $g.DrawString([string]$p['text'], $font, [Drawing.Brushes]::Black, [float]0, -$size); $g.Restore($state); $font.Dispose()
    }
    'point' { $g.FillEllipse([Drawing.Brushes]::Black, (X $pts[0][0]) - 1, (Y $pts[0][1]) - 1, 2, 2) }
    default {
      $pen = Get-Pen $p['color'] $p['style']
      $arr = [Drawing.PointF[]]@($pts | ForEach-Object { New-Object Drawing.PointF (X $_[0]), (Y $_[1]) })
      if ($arr.Length -ge 2) { $g.DrawLines($pen, $arr) }
    }
  }
}
$g.Dispose(); $bmp.Save($OutputPath, [Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
