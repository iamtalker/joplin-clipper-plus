Add-Type -AssemblyName System.Drawing

$root = "C:\Users\misti\Documents\크롬 확장프로그램\joplin-clipper"
$brand = [System.Drawing.Color]::FromArgb(255, 27, 138, 74)
$brandDark = [System.Drawing.Color]::FromArgb(255, 15, 87, 46)
$white = [System.Drawing.Color]::White
$lightGreen = [System.Drawing.Color]::FromArgb(255, 214, 240, 222)

function New-BookmarkPoints {
  param([double]$cx, [double]$cy, [double]$w, [double]$h)
  # cx,cy = center; w,h = bounding box of the bookmark glyph
  $left   = $cx - $w/2
  $right  = $cx + $w/2
  $top    = $cy - $h/2
  $bottom = $top + $h * 0.82
  $notchY = $top + $h * 0.61
  $arr = [System.Drawing.PointF[]]::new(5)
  $arr[0] = [System.Drawing.PointF]::new($left, $top)
  $arr[1] = [System.Drawing.PointF]::new($right, $top)
  $arr[2] = [System.Drawing.PointF]::new($right, $bottom)
  $arr[3] = [System.Drawing.PointF]::new($cx, $notchY)
  $arr[4] = [System.Drawing.PointF]::new($left, $bottom)
  return ,$arr
}

function New-PromoTile {
  param(
    [int]$w, [int]$h, [string]$outPath,
    [double]$iconCx, [double]$iconCy, [double]$iconSize,
    [string]$title, [float]$titleSize, [double]$titleY,
    [string]$tagline, [float]$taglineSize, [double]$taglineY,
    [System.Drawing.StringAlignment]$align, [double]$textX, [double]$textWidth
  )
  $bmp = [System.Drawing.Bitmap]::new($w, $h, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

  $bgBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    [System.Drawing.Point]::new(0,0),
    [System.Drawing.Point]::new($w,$h),
    $brand, $brandDark
  )
  $g.FillRectangle($bgBrush, 0, 0, $w, $h)

  $pts = New-BookmarkPoints $iconCx $iconCy $iconSize $iconSize
  $whiteBrush = [System.Drawing.SolidBrush]::new($white)
  $g.FillPolygon($whiteBrush, $pts)

  $titleFont = [System.Drawing.Font]::new("Segoe UI", $titleSize, [System.Drawing.FontStyle]::Bold)
  $taglineFont = [System.Drawing.Font]::new("Segoe UI", $taglineSize, [System.Drawing.FontStyle]::Regular)
  $taglineBrush = [System.Drawing.SolidBrush]::new($lightGreen)

  $fmt = [System.Drawing.StringFormat]::new()
  $fmt.Alignment = $align

  $titleRect = [System.Drawing.RectangleF]::new($textX, $titleY, $textWidth, $titleSize * 2.2)
  $g.DrawString($title, $titleFont, $whiteBrush, $titleRect, $fmt)

  $tagRect = [System.Drawing.RectangleF]::new($textX, $taglineY, $textWidth, $taglineSize * 3.4)
  $g.DrawString($tagline, $taglineFont, $taglineBrush, $tagRect, $fmt)

  $g.Flush()
  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose(); $bgBrush.Dispose(); $whiteBrush.Dispose(); $taglineBrush.Dispose()
  $titleFont.Dispose(); $taglineFont.Dispose(); $fmt.Dispose()
}

New-Item -ItemType Directory -Force -Path (Join-Path $root "store-assets") | Out-Null

# Small promo tile: 440x280 - stacked layout (icon centered top, text centered below)
New-PromoTile -w 440 -h 280 -outPath (Join-Path $root "store-assets\small_promo_tile_440x280.png") `
  -iconCx 220 -iconCy 90 -iconSize 100 `
  -title "Joplin Clipper Plus" -titleSize 22 -titleY 158 `
  -tagline "필요한 내용만, 깔끔하게 클리핑" -taglineSize 13 -taglineY 200 `
  -align ([System.Drawing.StringAlignment]::Center) -textX 20 -textWidth 400

# Marquee promo tile: 1400x560 - icon left, text right
New-PromoTile -w 1400 -h 560 -outPath (Join-Path $root "store-assets\marquee_promo_tile_1400x560.png") `
  -iconCx 320 -iconCy 280 -iconSize 260 `
  -title "Joplin Clipper Plus" -titleSize 46 -titleY 215 `
  -tagline "조플린 전용 웹 클리퍼`n광고·사이드바 없이, 본문만 깔끔하게" -taglineSize 26 -taglineY 315 `
  -align ([System.Drawing.StringAlignment]::Near) -textX 640 -textWidth 720

Write-Output "Promo tiles written."



