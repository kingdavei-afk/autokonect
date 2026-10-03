<#
.SYNOPSIS
  Demarre l'API AdkCars CI en arriere-plan, avec des journaux exploitables.

.DESCRIPTION
  Les tests de bout en bout (auth-flow, vehicles-flow, admin-flow,
  realtime-flow) lisent le code OTP dans le journal du fournisseur SMS
  simule, ecrit sur la sortie d'erreur. Ce script garantit que ce
  journal existe au bon endroit.

  Ce dependance etait implicite : rien dans le depot ne demarrait
  l'API de cette facon. Les tests passaient donc ou non selon la
  maniere dont le developpeur avait lance le service, et un echec
  produisait « 401 code OTP invalide » sans aucune explication.

.PARAMETER Stop
  Arrete l'API lancee par ce script.

.PARAMETER Port
  Port d'ecoute. Doit correspondre a PORT dans .env.

.EXAMPLE
  .\scripts\dev-api.ps1
  .\scripts\dev-api.ps1 -Stop
#>
[CmdletBinding()]
param(
  [switch] $Stop,
  [int]    $Port = 0
)

$ErrorActionPreference = 'Continue'

$ApiDir   = Join-Path (Split-Path $PSScriptRoot -Parent) 'apps\api'
$OutLog   = Join-Path $ApiDir 'api.log'
$ErrLog   = Join-Path $ApiDir 'api.err.log'
$DistMain = Join-Path $ApiDir 'dist\main.js'

# Fichier ou sont ecrits les identifiants des processus lances par ce
# script, afin que -Stop ne tue pas un serveur unrelated lance a la main.
$PidFile  = Join-Path $ApiDir '.dev-api.pid'

function Get-RecordedPid {
  if (-not (Test-Path $PidFile)) { return 0 }
  $recorded = (Get-Content $PidFile -Raw -ErrorAction SilentlyContinue).Trim()
  if ([int]::TryParse($recorded, [ref]$null)) { return 0 }
  return [int]$recorded
}

function Stop-Recorded {
  $pid_ = Get-RecordedPid
  if ($pid_ -eq 0) {
    Write-Host "Aucun processus enregistre (fichier $PidFile absent)." -ForegroundColor Gray
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    return
  }

  $proc = Get-Process -Id $pid_ -ErrorAction SilentlyContinue
  if ($proc) {
    Stop-Process -Id $pid_ -Force
    Write-Host "API arretee (pid $pid_)." -ForegroundColor Green
  } else {
    Write-Host "Le processus $pid_ n existe plus." -ForegroundColor Gray
  }

  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

if ($Stop) {
  Stop-Recorded
  return
}

# ---------------------------------------------------------------------------
# Verification de la compilation
# ---------------------------------------------------------------------------
# Lancer un `dist` absent echouerait avec une erreur peu parlante
# (« Cannot find module »). Le dire ici economise le aller-retour.
# ---------------------------------------------------------------------------
if (-not (Test-Path $DistMain)) {
  Write-Host "Le code n'est pas compile : $DistMain est absent." -ForegroundColor Red
  Write-Host "Lancez d'abord :  pnpm build" -ForegroundColor Yellow
  exit 1
}

# ---------------------------------------------------------------------------
# Verification de la base
# ---------------------------------------------------------------------------
# Sans base demarrée, l'API meurt sur « permission denied » ou sur une
# connexion refusee. Le dire avant evite un demarrage qui echoue sans
# raison visible.
# ---------------------------------------------------------------------------
try {
  $dbEnv = Get-Content (Join-Path (Split-Path $PSScriptRoot -Parent) '.env') -ErrorAction Stop
  $line = $dbEnv | Where-Object { $_ -match '^\s*DATABASE_URL=' } | Select-Object -First 1
  if ($line -and $line -match '@([^:/]+):(\d+)') {
    $dbHost = $Matches[1]
    $dbPort = [int]$Matches[2]
    $probe = Test-NetConnection -ComputerName $dbHost -Port $dbPort -WarningAction SilentlyContinue -InformationLevel Quiet
    if (-not $probe) {
      Write-Host "La base ne repond pas sur ${dbHost}:${dbPort}." -ForegroundColor Red
      Write-Host "Lancez d'abord :  .\scripts\dev-db.ps1 start" -ForegroundColor Yellow
      exit 1
    }
  }
} catch {
  Write-Host "Lecture de .env impossible : $($_.Exception.Message)" -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# Demarrage
# ---------------------------------------------------------------------------
# Les tests de bout en bout lisent le code OTP du fournisseur SMS simule
# dans la sortie d'ERREUR du service. Il faut donc rediriger les deux
# flux vers des fichiers.
#
# `Start-Process -RedirectStandard*` NE CONVIENT PAS : PowerShell garde
# ensuite les descripteurs ouverts jusqu'a la fin du processus enfant, et
# le script ne rend jamais la main. Le service demarre bien, mais le
# lanceur reste bloque — ce qui donne l'impression d'un demarrage rate.
#
# `cmd /c start /b` detache reellement le processus : les flux sont
# rediriges par `cmd`, et le lanceur rend la main immediatement.
# ---------------------------------------------------------------------------
foreach ($f in @($OutLog, $ErrLog)) {
  if (Test-Path $f) { Clear-Content $f -ErrorAction SilentlyContinue }
}

$cmdLine = 'cmd /c start "" /b cmd /c "cd /d "{0}" && node dist\main.js 1> "{1}" 2> "{2}""' -f `
             $ApiDir, $OutLog, $ErrLog

try {
  Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdLine } | Out-Null
} catch {
  Write-Host "Demarrage impossible : $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

# ---------------------------------------------------------------------------
# Attente de la reponse du service
# ---------------------------------------------------------------------------
# Renvoyer immediately laisserait croire que le demarrage a reussi alors
# qu'il peut echouer dans la seconde suivante (configuration invalide,
# base injoignable). On attend une reponse HTTP reelle, puis on rend la
# main.
# ---------------------------------------------------------------------------
$port = if ($Port -gt 0) { $Port } else {
  $line = Get-Content (Join-Path (Split-Path $PSScriptRoot -Parent) '.env') -ErrorAction SilentlyContinue |
            Where-Object { $_ -match '^\s*PORT=' } | Select-Object -First 1
  if ($line -match '=(\d+)') { [int]$Matches[1] } else { 3000 }
}

$deadline = (Get-Date).AddSeconds(45)
$ready = $false
$pid_ = 0

while ((Get-Date) -lt $deadline) {
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/health/live" `
                                 -UseBasicParsing -TimeoutSec 3
    if ($response.StatusCode -eq 200) { $ready = $true; break }
  } catch {
    Start-Sleep -Milliseconds 400
  }
}

if (-not $ready) {
  Write-Host "L'API n'a pas repondu sur le port $port dans le delai imparti." -ForegroundColor Red
  Get-Content $ErrLog -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object { "  $_" }
  exit 1
}

# Le PID est resolu par le port plutot que par le lanceur : la
# redirection passant par `cmd`, l'identifiant du processus `node` n'est
# pas celui du processus cree. Chercher ce qui ecoute evite d'arreter le
# mauvais processus.
$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
              Select-Object -First 1

if ($listener) {
  $pid_ = $listener.OwningProcess
  Set-Content -Path $PidFile -Value $pid_ -NoNewline
}

Write-Host ''
Write-Host "=== API demarree (pid $pid_) ===" -ForegroundColor Green
Write-Host "  port        : $port"
Write-Host "  journaux    : $OutLog"
Write-Host "                $ErrLog"
Write-Host "  arret       : .\scripts\dev-api.ps1 -Stop"
Write-Host ''
Write-Host 'Tests de bout en bout (dans une autre fenetre) :'
Write-Host '  .\apps\api\test\auth-flow.ps1'
Write-Host '  .\apps\api\test\vehicles-flow.ps1'
Write-Host '  .\apps\api\test\admin-flow.ps1'
Write-Host '  .\apps\api\test\realtime-flow.ps1'
