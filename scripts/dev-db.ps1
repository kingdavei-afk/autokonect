<#
.SYNOPSIS
    Pilote l'instance PostgreSQL portable du developpement local.

.DESCRIPTION
    Le poste de developpement n'utilise pas de service PostgreSQL installe
    : les binaires sont deployes dans .tools/ (hors depot git). Ce script
    encapsule demarrage, arret et diagnostic afin que la commande a
    executer soit toujours la meme.

.PARAMETER Action
    start | stop | restart | status | psql | test

.EXAMPLE
    .\scripts\dev-db.ps1 start
    .\scripts\dev-db.ps1 psql -c "select 1"
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'restart', 'status', 'psql', 'test')]
  [string] $Action = 'status',

  [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
  [string[]] $Rest
)

$ErrorActionPreference = 'Stop'

$PgRoot   = Join-Path $PSScriptRoot '..\.tools\pgsql\pgsql'
$PgBin    = Join-Path $PgRoot 'bin'
$PgData   = Join-Path $PSScriptRoot '..\.tools\pgdata'
$PgLog    = Join-Path $PgData 'server.log'
$Port     = 5432
$DbUser   = 'postgres'
$Password = 'adkcars_dev'

function Test-Listening {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  return ($null -ne $conn)
}

function Start-Database {
  if (Test-Listening) {
    Write-Host "PostgreSQL est deja demarre sur le port $Port." -ForegroundColor DarkGray
    return
  }

  # Un fichier postmaster.pid laisse par un arret brutal bloque le demarrage.
  if (Test-Path (Join-Path $PgData 'postmaster.pid')) {
    Remove-Item -Force (Join-Path $PgData 'postmaster.pid')
  }

  Write-Host 'Demarrage de PostgreSQL...' -ForegroundColor Cyan
  # Demarrage detache SANS redirection de flux.
  #
  # `Start-Process -RedirectStandardOutput` garde un handle ouvert sur le
  # processus enfant : la commande appelante ne rend alors jamais la main
  # et l'appelant reste bloque jusqu'a l'arret du serveur. La journalisation
  # est assuree par `logging_collector` dans postgresql.conf.
  Start-Process -FilePath (Join-Path $PgBin 'postgres.exe') `
    -ArgumentList '-D', $PgData, '-p', $Port `
    -WindowStyle Hidden

  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Listening) {
      Write-Host "PostgreSQL demarre (port $Port) en $([math]::Round(($i + 1) * 0.5, 1)) s." -ForegroundColor Green
      return
    }
  }

  throw "PostgreSQL n'a pas demarre. Journal : $PgLog"
}

function Stop-Database {
  if (-not (Test-Listening)) {
    Write-Host 'PostgreSQL est deja arrete.' -ForegroundColor DarkGray
    return
  }
  Write-Host 'Arret de PostgreSQL...' -ForegroundColor Cyan
  & (Join-Path $PgBin 'pg_ctl.exe') -D $PgData -m fast -w stop
  Write-Host 'Arret effectue.' -ForegroundColor Green
}

function Show-Status {
  $listening = Test-Listening
  $marker = if ($listening) { 'ACTIF' } else { 'ARRET' }
  $color  = if ($listening) { 'Green' } else { 'Yellow' }

  Write-Host ''
  Write-Host '=== PostgreSQL local (portable) ===' -ForegroundColor Cyan
  Write-Host "  etat        : $marker" -ForegroundColor $color
  Write-Host "  port        : $Port"
  Write-Host "  binaires    : $PgRoot"
  Write-Host "  donnees     : $PgData"
  Write-Host "  journal     : $PgLog"

  if (-not $listening) {
    Write-Host ''
    Write-Host '  Pour demarrer : .\scripts\dev-db.ps1 start' -ForegroundColor DarkGray
    return
  }

  $env:PGPASSWORD = $Password
  Write-Host ''
  Write-Host '=== bases ==='
  & (Join-Path $PgBin 'psql.exe') -U $DbUser -h 127.0.0.1 -p $Port -d postgres -q -c `
    "SELECT datname, pg_size_pretty(pg_database_size(datname)) AS taille
     FROM pg_database WHERE datname LIKE 'adkcars%' ORDER BY datname"
}

switch ($Action) {
  'start'   { Start-Database }
  'stop'    { Stop-Database }
  'restart' { Stop-Database; Start-Database; Show-Status }
  'status'  { Show-Status }
  'psql'    { Start-Database; $env:PGPASSWORD = $Password; & (Join-Path $PgBin 'psql.exe') -U $DbUser -h 127.0.0.1 -p $Port @Rest }
  'test'    { Start-Database; & (Join-Path $PSScriptRoot '..\node_modules\.bin\pnpm.cmd') db:test }
  default   { Show-Status }
}