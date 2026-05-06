# ============================================================
#  Signacore — Deploy to Live Site
#  Double-click this file to push the latest dashboard to
#  GitHub. Render will automatically redeploy within ~60 sec.
# ============================================================

$TOKEN  = "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"
$OWNER  = "ockertsmit64-hash"
$REPO   = "signacore-platform"
$BRANCH = "main"
$FILE   = "index.html"

Write-Host ""
Write-Host "  ╔══════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "  ║   Signacore — Deploy to Live Site    ║" -ForegroundColor Cyan
Write-Host "  ╚══════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ── Find the dashboard file ──────────────────────────────────
$localFile = Join-Path $PSScriptRoot "signacore-dashboard.html"

if (-not (Test-Path $localFile)) {
    Write-Host "  ❌ ERROR: signacore-dashboard.html not found." -ForegroundColor Red
    Write-Host "     Make sure this script is in the same folder as the dashboard file." -ForegroundColor Red
    Write-Host ""
    Read-Host "  Press Enter to close"
    exit 1
}

# ── Read and encode the file ─────────────────────────────────
Write-Host "  📄 Reading signacore-dashboard.html..." -ForegroundColor White
$content = Get-Content $localFile -Raw -Encoding UTF8
$bytes   = [System.Text.Encoding]::UTF8.GetBytes($content)
$encoded = [Convert]::ToBase64String($bytes)
$kb      = [Math]::Round($bytes.Length / 1KB, 1)
Write-Host "     File size: $kb KB" -ForegroundColor DarkGray

# ── GitHub API setup ─────────────────────────────────────────
$apiUrl  = "https://api.github.com/repos/$OWNER/$REPO/contents/$FILE"
$headers = @{
    Authorization = "token $TOKEN"
    "User-Agent"  = "Signacore-Deploy/1.0"
    Accept        = "application/vnd.github.v3+json"
}

# ── Check if file already exists (need SHA to update) ────────
$sha = $null
try {
    Write-Host "  🔍 Checking GitHub for existing file..." -ForegroundColor White
    $existing = Invoke-RestMethod -Uri $apiUrl -Headers $headers -Method Get -ErrorAction Stop
    $sha = $existing.sha
    Write-Host "     File found — will update." -ForegroundColor DarkGray
} catch {
    Write-Host "     No existing file — will create fresh." -ForegroundColor DarkGray
}

# ── Build commit payload ──────────────────────────────────────
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm"
$body = @{
    message = "Deploy update — $timestamp"
    content = $encoded
    branch  = $BRANCH
}
if ($sha) { $body["sha"] = $sha }
$bodyJson = $body | ConvertTo-Json -Depth 5

# ── Push to GitHub ────────────────────────────────────────────
Write-Host ""
Write-Host "  🚀 Pushing to GitHub..." -ForegroundColor Yellow
try {
    $result = Invoke-RestMethod -Uri $apiUrl -Headers $headers -Method Put -Body $bodyJson -ContentType "application/json" -ErrorAction Stop

    Write-Host ""
    Write-Host "  ✅ Successfully deployed!" -ForegroundColor Green
    Write-Host ""
    Write-Host "  GitHub :  https://github.com/$OWNER/$REPO" -ForegroundColor Cyan
    Write-Host "  Live   :  https://signacor-frontend.onrender.com/" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Render will go live in approximately 60 seconds." -ForegroundColor DarkGray

} catch {
    $errMsg = $_.Exception.Message
    $errDetail = $_.ErrorDetails.Message
    Write-Host ""
    Write-Host "  ❌ Push failed." -ForegroundColor Red
    Write-Host "     $errMsg" -ForegroundColor Red
    if ($errDetail) {
        Write-Host "     $errDetail" -ForegroundColor Red
    }
}

Write-Host ""
Read-Host "  Press Enter to close"
