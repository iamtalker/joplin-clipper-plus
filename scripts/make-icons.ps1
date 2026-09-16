Add-Type -AssemblyName System.Drawing

$root = "C:\Users\misti\Documents\크롬 확장프로그램\joplin-clipper"
$brand = [System.Drawing.Color]::FromArgb(255, 27, 138, 74)   # forest green
$brandDark = [System.Drawing.Color]::FromArgb(255, 18, 104, 56)
$white = [System.Drawing.Color]::White

function New-RoundedRectPath {
  param($x, $y, $w, $h, $r)
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $path.AddArc($x, $y, $r*2, $r*2, 180, 90)
  $path.AddArc($x + $w - $r*2, $y, $r*2, $r*2, 270, 90)
  $path.AddArc($x + $w - $r*2, $y + $h - $r*2, $r*2, $r*2, 0, 90)
  $path.AddArc($x, $y + $h - $r*2, $r*2, $r*2, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-BookmarkPoints {
  param([double]$s)
  $left   = 0.30 * $s
  $right  = 0.70 * $s
  $top    = 0.19 * $s
  $bottom = 0.83 * $s
  $notchY = 0.66 * $s
  $cx     = 0.50 * $s
  $arr = [System.Drawing.PointF[]]::new(5)
  $arr[0] = [System.Drawing.PointF]::new($left, $top)
  $arr[1] = [System.Drawing.PointF]::new($right, $top)
  $arr[2] = [System.Drawing.PointF]::new($right, $bottom)
  $arr[3] = [System.Drawing.PointF]::new($cx, $notchY)
  $arr[4] = [System.Drawing.PointF]::new($left, $bottom)
  return ,$arr
}

function New-Icon {
  param([int]$size, [string]$outPath)
  $bmp = [System.Drawing.Bitmap]::new($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  $radius = $size * 0.22
  $bgPath = New-RoundedRectPath 0 0 $size $size $radius
  $bgBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    [System.Drawing.Point]::new(0,0),
    [System.Drawing.Point]::new($size,$size),
    $brand, $brandDark
  )
  $g.FillPath($bgBrush, $bgPath)

  $pts = New-BookmarkPoints $size
  $whiteBrush = [System.Drawing.SolidBrush]::new($white)
  $g.FillPolygon($whiteBrush, $pts)

  $g.Flush()
  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose(); $bgBrush.Dispose(); $whiteBrush.Dispose(); $bgPath.Dispose()
}

New-Icon 16  (Join-Path $root "icons\icon16.png")
New-Icon 48  (Join-Path $root "icons\icon48.png")
New-Icon 128 (Join-Path $root "icons\icon128.png")

Write-Output "Icons written."

