# ═══════════════════════════════════════════════════════════
# AuthorClaw - Copy Files to VM Shared Folder
# Run this on your Windows host before deploying in the VM
# ═══════════════════════════════════════════════════════════

$ErrorActionPreference = "Stop"

# ── Configuration (adjust these paths to match your setup) ──
$AuthorClawSource = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ParentDir        = Split-Path $AuthorClawSource
# Author OS lives at Automations/Author OS (two levels up from repo root)
$AutomationsDir   = Split-Path $ParentDir
$AuthorOSSource   = Join-Path $AutomationsDir "Author OS"
$SharedFolder     = Join-Path $ParentDir "vm-transfer"

# Validate paths
if (-not (Test-Path $AuthorClawSource)) {
    Write-Error "AuthorClaw source not found at: $AuthorClawSource"
    exit 1
}
if (-not (Test-Path $SharedFolder)) {
    Write-Error "VM shared folder not found at: $SharedFolder"
    Write-Host "Make sure the VirtualBox shared folder is configured."
    exit 1
}

Write-Host ""
Write-Host "  AuthorClaw - Copy to VM" -ForegroundColor Cyan
Write-Host "  ======================================="
Write-Host ""

# ── Step 1: Copy AuthorClaw ──
Write-Host "  [1/3] Copying AuthorClaw..."
$acDest = Join-Path $SharedFolder "authorclaw"
if (Test-Path $acDest) { Remove-Item -Recurse -Force $acDest }

# Copy excluding node_modules, .git, and zip files
# Note: don't exclude 'dist' globally — dashboard/dist has the HTML
robocopy $AuthorClawSource $acDest /E /NFL /NDL /NJH /NJS /NC /NS `
    /XD node_modules .git `
    /XF *.zip 2>$null
Write-Host "  OK: AuthorClaw copied to shared folder" -ForegroundColor Green

# ── Step 2: Copy Author OS tools (only the parts AuthorClaw integrates with) ──
Write-Host "  [2/3] Copying Author OS tools..."
$aosDest = Join-Path $SharedFolder "author-os"
if (Test-Path $aosDest) { Remove-Item -Recurse -Force $aosDest }
New-Item -ItemType Directory -Path $aosDest -Force | Out-Null

# Author Workflow Engine (JSON templates)
$awePath = Join-Path $AuthorOSSource "Author Workflow Engine"
if (Test-Path $awePath) {
    robocopy $awePath (Join-Path $aosDest "workflow-engine") /E /NFL /NDL /NJH /NJS /NC /NS 2>$null
    Write-Host "    OK: Author Workflow Engine" -ForegroundColor Green
} else {
    Write-Host "    SKIP: Author Workflow Engine not found" -ForegroundColor Yellow
}

# Book Bible Engine
$bbePath = Join-Path $AuthorOSSource "Book Bible Engine"
if (Test-Path $bbePath) {
    robocopy $bbePath (Join-Path $aosDest "book-bible") /E /NFL /NDL /NJH /NJS /NC /NS 2>$null
    Write-Host "    OK: Book Bible Engine" -ForegroundColor Green
} else {
    Write-Host "    SKIP: Book Bible Engine not found" -ForegroundColor Yellow
}

# Manuscript Autopsy
$maPath = Join-Path $AuthorOSSource "Manuscript Autopsy"
if (Test-Path $maPath) {
    robocopy $maPath (Join-Path $aosDest "manuscript-autopsy") /E /NFL /NDL /NJH /NJS /NC /NS 2>$null
    Write-Host "    OK: Manuscript Autopsy" -ForegroundColor Green
} else {
    Write-Host "    SKIP: Manuscript Autopsy not found" -ForegroundColor Yellow
}

# AI Author Library (prompts, blueprints)
$aalPath = Join-Path $AuthorOSSource "AI Author Library"
if (Test-Path $aalPath) {
    robocopy $aalPath (Join-Path $aosDest "ai-author-library") /E /NFL /NDL /NJH /NJS /NC /NS 2>$null
    Write-Host "    OK: AI Author Library" -ForegroundColor Green
} else {
    Write-Host "    SKIP: AI Author Library not found" -ForegroundColor Yellow
}

# Creator Asset Suite (for export/format testing)
$casPath = Join-Path $AuthorOSSource "Creator Asset Suite"
if (Test-Path $casPath) {
    # Only copy Format Factory Pro (for book export testing)
    $ffpPath = Join-Path $casPath "Format Factory Pro"
    if (Test-Path $ffpPath) {
        robocopy $ffpPath (Join-Path $aosDest "format-factory") /E /NFL /NDL /NJH /NJS /NC /NS `
            /XD __pycache__ .venv venv 2>$null
        Write-Host "    OK: Format Factory Pro" -ForegroundColor Green
    }
} else {
    Write-Host "    SKIP: Creator Asset Suite not found" -ForegroundColor Yellow
}

# ── Step 3: Copy premium skill packs if they exist ──
Write-Host "  [3/3] Copying premium skill packs..."
$premiumSource = Join-Path (Split-Path $AuthorClawSource) "authorclaw-premium-bundle"
if (Test-Path $premiumSource) {
    $premDest = Join-Path $SharedFolder "authorclaw-premium"
    if (Test-Path $premDest) { Remove-Item -Recurse -Force $premDest }
    robocopy $premiumSource $premDest /E /NFL /NDL /NJH /NJS /NC /NS 2>$null
    Write-Host "    OK: Premium bundle copied" -ForegroundColor Green
} else {
    Write-Host "    SKIP: Premium bundle not found" -ForegroundColor Yellow
}

# ── Summary ──
Write-Host ""
Write-Host "  =======================================" -ForegroundColor Cyan
Write-Host "  Files copied to: $SharedFolder" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Contents:" -ForegroundColor White
Get-ChildItem $SharedFolder -Directory | ForEach-Object {
    $size = (Get-ChildItem $_.FullName -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB
    Write-Host ("    {0,-25} {1,8:N1} MB" -f $_.Name, $size)
}
Write-Host ""
Write-Host "  Next steps:" -ForegroundColor White
Write-Host ""
Write-Host "  OPTION A: SSH from PowerShell (recommended - copy/paste works!):" -ForegroundColor Yellow
Write-Host "    ssh your-vm-user@localhost -p 2222"
Write-Host ""
Write-Host "  OPTION B: Use VM terminal directly (no copy/paste):" -ForegroundColor Yellow
Write-Host "    Open Terminal in the VM"
Write-Host ""
Write-Host "  Then run these commands:" -ForegroundColor White
Write-Host "    # First time setup:"
Write-Host "    cp -r /media/sf_authorclaw-transfer/authorclaw ~/authorclaw"
Write-Host "    cp -r /media/sf_authorclaw-transfer/author-os ~/author-os"
Write-Host "    cd ~/authorclaw && npm install"
Write-Host ""
Write-Host "    # Start AuthorClaw:"
Write-Host "    cd ~/authorclaw && npx tsx gateway/src/index.ts &"
Write-Host ""
Write-Host "    # Open dashboard in VM Firefox: http://localhost:3847"
Write-Host ""
Write-Host "    # Store API key (use key.txt in shared folder to avoid typing):"
Write-Host "    curl -s -X POST http://localhost:3847/api/vault \"
Write-Host "      -H 'Content-Type: application/json' \"
Write-Host "      -d '{""key"":""gemini_api_key"",""value"":""'`$(cat /media/sf_authorclaw-transfer/key.txt)'""}'"
Write-Host ""
Write-Host "  =======================================" -ForegroundColor Cyan
Write-Host ""
