param(
  [Parameter(Mandatory=$true)][ValidateSet('shot','diff')][string]$Mode,
  [string]$JwwPath, [string]$PngPath,
  [string]$BeforePng, [string]$AfterPng, [string]$DiffPng,
  [string]$JwWin = 'C:\JWW\Jw_win.exe', [int]$WaitMs = 4000, [int]$Width = 1600, [int]$Height = 1000, [switch]$Foreground, [int]$StableFrames = 3
)
# Quality gate 3 (visual): open a JWW in the real Jw_cad by command-line argument (no file dialog),
# capture the window with PrintWindow, close without saving. `diff` compares two captures pixel by pixel.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class JwWin {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool RedrawWindow(IntPtr h, IntPtr rect, IntPtr rgn, uint flags);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

function Read-Pixels([string]$path) {
  $bmp = [Drawing.Bitmap]::FromFile($path)
  $rect = New-Object Drawing.Rectangle 0, 0, $bmp.Width, $bmp.Height
  $data = $bmp.LockBits($rect, [Drawing.Imaging.ImageLockMode]::ReadOnly, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $bytes = New-Object byte[] ($data.Stride * $bmp.Height)
  [Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
  $bmp.UnlockBits($data)
  $result = @{ Width = $bmp.Width; Height = $bmp.Height; Stride = $data.Stride; Bytes = $bytes }
  $bmp.Dispose()
  return $result
}

if ($Mode -eq 'shot') {
  if (-not (Test-Path -LiteralPath $JwwPath)) { throw "E_VISUAL_INPUT: $JwwPath" }
  if (Test-Path -LiteralPath $PngPath) { throw "E_VISUAL_OUTPUT_EXISTS: $PngPath" }
  # Same file name for every capture so the title bar never differs between before/after.
  $stage = Join-Path ([IO.Path]::GetTempPath()) ('fresco-visual-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stage | Out-Null
  $staged = Join-Path $stage 'drawing.jww'; Copy-Item -LiteralPath $JwwPath -Destination $staged
  $process = Start-Process -FilePath $JwWin -ArgumentList ('"' + $staged + '"') -PassThru
  try {
    $deadline = (Get-Date).AddMilliseconds($WaitMs + 10000)
    do { Start-Sleep -Milliseconds 300; $process.Refresh() } while ($process.MainWindowHandle -eq [IntPtr]::Zero -and (Get-Date) -lt $deadline)
    if ($process.MainWindowHandle -eq [IntPtr]::Zero) { throw 'E_VISUAL_NO_WINDOW' }
    $handle = $process.MainWindowHandle
    # Jw_cad aborts a redraw on any mouse/input message, which silently drops layers from a capture.
    # Park the fixed-size window beyond the virtual desktop so the pointer can never reach it,
    # force a full redraw, and accept only a capture that stays identical across consecutive frames.
    $virtual = [Windows.Forms.SystemInformation]::VirtualScreen
    if ($Foreground) { [void][JwWin]::MoveWindow($handle, 0, 0, $Width, $Height, $true); [void][JwWin]::SetForegroundWindow($handle) }
    else { [void][JwWin]::MoveWindow($handle, $virtual.Left - $Width - 200, $virtual.Top, $Width, $Height, $true) }
    Start-Sleep -Milliseconds $WaitMs
    [void][JwWin]::RedrawWindow($handle, [IntPtr]::Zero, [IntPtr]::Zero, 0x0185)  # INVALIDATE|ERASE|UPDATENOW|ALLCHILDREN
    # On a slow PC Jw_cad draws lines first and text noticeably later, so a short quiet period is not "done".
    $previous = $null; $stable = 0; $frames = 0; $limit = (Get-Date).AddSeconds(90)
    while ($stable -lt $StableFrames -and (Get-Date) -lt $limit) {
      Start-Sleep -Milliseconds 2000
      $bitmap = New-Object Drawing.Bitmap $Width, $Height
      # Never CopyFromScreen: it can capture other applications on the user's desktop.
      $graphics = [Drawing.Graphics]::FromImage($bitmap); $dc = $graphics.GetHdc()
      [void][JwWin]::PrintWindow($handle, $dc, 2)
      $graphics.ReleaseHdc($dc); $graphics.Dispose()
      $stream = New-Object IO.MemoryStream; $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
      $frame = [Convert]::ToBase64String([Security.Cryptography.SHA256]::Create().ComputeHash($stream.ToArray())); $stream.Dispose()
      if ($frame -eq $previous) { $stable++ } else { $stable = 0 }
      $previous = $frame; $frames++
      if ($stable -ge $StableFrames) { $bitmap.Save($PngPath, [Drawing.Imaging.ImageFormat]::Png) }
      $bitmap.Dispose()
    }
    if ($stable -lt $StableFrames) { throw 'E_VISUAL_UNSTABLE' }
    $process.Refresh()
    [ordered]@{ title = $process.MainWindowTitle; png = $PngPath; frames = $frames } | ConvertTo-Json -Compress
  } finally { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 300; Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
} else {
  $a = Read-Pixels $BeforePng; $b = Read-Pixels $AfterPng
  if ($a.Width -ne $b.Width -or $a.Height -ne $b.Height) { throw 'E_VISUAL_SIZE_MISMATCH' }
  $out = New-Object byte[] $a.Bytes.Length
  $changed = 0; $minX = $a.Width; $minY = $a.Height; $maxX = -1; $maxY = -1
  for ($y = 0; $y -lt $a.Height; $y++) {
    $row = $y * $a.Stride
    for ($x = 0; $x -lt $a.Width; $x++) {
      $i = $row + $x * 4
      if ($a.Bytes[$i] -ne $b.Bytes[$i] -or $a.Bytes[$i+1] -ne $b.Bytes[$i+1] -or $a.Bytes[$i+2] -ne $b.Bytes[$i+2]) {
        $changed++; $out[$i+2] = 255; $out[$i+3] = 255
        if ($x -lt $minX) { $minX = $x }; if ($y -lt $minY) { $minY = $y }; if ($x -gt $maxX) { $maxX = $x }; if ($y -gt $maxY) { $maxY = $y }
      } else { $g = [byte](($a.Bytes[$i] + $a.Bytes[$i+1] + $a.Bytes[$i+2]) / 9 + 170); $out[$i] = $g; $out[$i+1] = $g; $out[$i+2] = $g; $out[$i+3] = 255 }
    }
  }
  if ($DiffPng) {
    $bmp = New-Object Drawing.Bitmap $a.Width, $a.Height, ([Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $data = $bmp.LockBits((New-Object Drawing.Rectangle 0, 0, $a.Width, $a.Height), [Drawing.Imaging.ImageLockMode]::WriteOnly, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
    [Runtime.InteropServices.Marshal]::Copy($out, 0, $data.Scan0, $out.Length); $bmp.UnlockBits($data)
    $bmp.Save($DiffPng, [Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  }
  $box = if ($maxX -ge 0) { @($minX, $minY, $maxX, $maxY) } else { $null }
  [ordered]@{ changedPixels = $changed; totalPixels = $a.Width * $a.Height; changedBox = $box } | ConvertTo-Json -Compress
}
