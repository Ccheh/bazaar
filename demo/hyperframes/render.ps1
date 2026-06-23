$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

$env:HYPERFRAMES_NO_TELEMETRY = "1"
$env:DO_NOT_TRACK = "1"
$env:HYPERFRAMES_NO_UPDATE_CHECK = "1"
$env:HYPERFRAMES_NO_AUTO_INSTALL = "1"
$env:HYPERFRAMES_BROWSER_PATH = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$env:HYPERFRAMES_FFMPEG_PATH = (Resolve-Path ".tools\ffmpeg.exe").Path
$env:HYPERFRAMES_FFPROBE_PATH = (Resolve-Path ".tools\ffprobe.exe").Path

$renderDir = Join-Path $here ".render"
New-Item -ItemType Directory -Force $renderDir | Out-Null
Copy-Item -LiteralPath "composition.html" -Destination (Join-Path $renderDir "index.html") -Force
Copy-Item -LiteralPath "vendor" -Destination (Join-Path $renderDir "vendor") -Recurse -Force
Copy-Item -LiteralPath "media" -Destination (Join-Path $renderDir "media") -Recurse -Force
Copy-Item -LiteralPath "vo" -Destination (Join-Path $renderDir "vo") -Recurse -Force

npx --no-install hyperframes render .render `
  --output ..\build\bazaar_demo_hf.mp4 `
  --workers 1 `
  --no-browser-gpu `
  --player-ready-timeout 90000 `
  --protocol-timeout 300000
