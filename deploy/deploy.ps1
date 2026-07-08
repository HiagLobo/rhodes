# deploy.ps1 — build + publicação do sistema Rhodes em C:\rhodes\app
# Idempotente: pode rodar quantas vezes quiser. Janela de indisponibilidade ~30s.
# Uso:   powershell -ExecutionPolicy Bypass -File deploy\deploy.ps1
#        (adicione -PularBuild para publicar o build já existente)

#Requires -Version 5.1
param(
  [string]$Destino = 'C:\rhodes\app',
  [string]$CaddyDir = 'C:\rhodes\caddy',
  [string]$WinswDir = 'C:\rhodes\winsw',
  [switch]$PularBuild
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$servicos = @('rhodes-app', 'rhodes-caddy')

function Invoke-Robocopy([string]$origem, [string]$dest) {
  robocopy $origem $dest /MIR /NFL /NDL /NJH /NJS | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy falhou ($origem -> $dest): codigo $LASTEXITCODE" }
}

Write-Host '== Rhodes: deploy ==' -ForegroundColor Cyan

# 1. Pré-requisitos
$nodeVersion = (& node --version) 2>$null
if (-not $nodeVersion -or -not $nodeVersion.StartsWith('v24')) {
  throw "Node 24 LTS obrigatorio (encontrado: '$nodeVersion'). Ver README-DEPLOY.md."
}
if ($Destino -match 'OneDrive') { throw 'Destino de producao nao pode ficar em pasta OneDrive.' }

# 2. Build (web/dist + server/dist)
if (-not $PularBuild) {
  Write-Host '-- build --'
  Push-Location $repo
  try { npm run build; if ($LASTEXITCODE -ne 0) { throw 'npm run build falhou' } }
  finally { Pop-Location }
}
if (-not (Test-Path "$repo\server\dist\index.js")) { throw 'server\dist\index.js ausente - rode sem -PularBuild' }
if (-not (Test-Path "$repo\web\dist\index.html")) { throw 'web\dist\index.html ausente - rode sem -PularBuild' }

# 3. Parar serviços (se instalados)
foreach ($svc in $servicos) {
  $s = Get-Service $svc -ErrorAction SilentlyContinue
  if ($s -and $s.Status -eq 'Running') { Write-Host "-- parando $svc --"; Stop-Service $svc -Force }
}

# 4. Publicar arquivos (estrutura de monorepo preservada — os caminhos relativos dependem dela)
Write-Host "-- publicando em $Destino --"
New-Item -ItemType Directory -Force "$Destino\server", "$Destino\web", "$Destino\shared" | Out-Null
Invoke-Robocopy "$repo\server\dist"    "$Destino\server\dist"
Invoke-Robocopy "$repo\server\drizzle" "$Destino\server\drizzle"
Invoke-Robocopy "$repo\server\assets"  "$Destino\server\assets"
Invoke-Robocopy "$repo\web\dist"       "$Destino\web\dist"
Invoke-Robocopy "$repo\shared\dist"    "$Destino\shared\dist"
Copy-Item "$repo\package.json", "$repo\package-lock.json" $Destino -Force
Copy-Item "$repo\server\package.json" "$Destino\server\" -Force
Copy-Item "$repo\web\package.json" "$Destino\web\" -Force
Copy-Item "$repo\shared\package.json" "$Destino\shared\" -Force

# 5. Dependências de produção no destino (better-sqlite3 compila/baixa prebuild na máquina alvo)
Write-Host '-- npm ci --omit=dev no destino --'
Push-Location $Destino
try { npm ci --omit=dev --no-fund --no-audit; if ($LASTEXITCODE -ne 0) { throw 'npm ci falhou no destino' } }
finally { Pop-Location }

# 6. Caddyfile + staging do WinSW (xmls ao lado do executavel, prontos para "install")
New-Item -ItemType Directory -Force $CaddyDir, $WinswDir | Out-Null
Copy-Item "$repo\deploy\Caddyfile" "$CaddyDir\Caddyfile" -Force
Copy-Item "$repo\deploy\rhodes-app.winsw.xml" "$WinswDir\rhodes-app.xml" -Force
Copy-Item "$repo\deploy\rhodes-caddy.winsw.xml" "$WinswDir\rhodes-caddy.xml" -Force
if (Test-Path "$WinswDir\WinSW-x64.exe") {
  Copy-Item "$WinswDir\WinSW-x64.exe" "$WinswDir\rhodes-app.exe" -Force
  Copy-Item "$WinswDir\WinSW-x64.exe" "$WinswDir\rhodes-caddy.exe" -Force
} else {
  Write-Warning "WinSW-x64.exe nao encontrado em $WinswDir - baixe conforme README-DEPLOY.md"
}

# 7. Subir serviços (se instalados) e conferir a saúde
$algumServico = $false
foreach ($svc in $servicos) {
  if (Get-Service $svc -ErrorAction SilentlyContinue) {
    Write-Host "-- iniciando $svc --"; Start-Service $svc; $algumServico = $true
  } else {
    Write-Warning "$svc nao instalado (uma vez, como admin: $WinswDir\$svc.exe install) - ver README-DEPLOY.md"
  }
}

if ($algumServico) {
  $ok = $false
  foreach ($i in 1..60) {
    Start-Sleep -Milliseconds 500
    try { $h = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/health' -TimeoutSec 2; $ok = $true; break } catch {}
  }
  if ($ok) { Write-Host "== deploy OK: health $($h | ConvertTo-Json -Compress) ==" -ForegroundColor Green }
  else { throw 'deploy publicado, mas /api/health nao respondeu em 30s - verifique os logs do servico rhodes-app' }
} else {
  Write-Host '== arquivos publicados. Instale os servicos (README-DEPLOY.md) e rode de novo. ==' -ForegroundColor Yellow
}
