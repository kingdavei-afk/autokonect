# Test du flux temps reel de bout en bout (A-17, SSE).
#
# Ce test verifie deux choses distinctes :
#   1. que le transport est bien SSE et non Socket.IO ;
#   2. qu'un flux ouvert recoit REELLEMENT un evenement produit apres
#      l'ouverture, et non seulement les evenements deja stockes.
#
# Le second point est le plus important. Un flux qui rejoue l'historique
# et qui ne recoit rien de neuf « fonctionne » en apparence ; seule la
# lecture apres production d'un evenement distingue un vrai flux d'une
# simple lecture de table.

$ErrorActionPreference = 'Continue'

# Port de l'API, resolu dans cet ordre :
#
#   $env:ADKCARS_PORT   une CI peut imposer un port sans toucher au depot
#   $env:PORT           deja exporte par la CI
#   PORT dans .env      la MEME source que scripts/dev-api.ps1
#   3000                valeur du produit, dans .env.example
#
# `.env` passe avant le defaut parce que c'est la configuration locale
# reelle : si le fichier dit 3001, le service est sur 3001, et le deviner
# autrement serait faux par construction. Une configuration a UNE source.
$FichierEnv = Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') '..'
$FichierEnv = Join-Path $FichierEnv '.env'
$PortDepuisEnv = if (Test-Path $FichierEnv) {
    $ligne = Get-Content $FichierEnv |
             Where-Object { $_ -match '^\s*PORT=' } |
             Select-Object -First 1
    if ($ligne -match '=(\d+)') { $Matches[1] }
}

$PortApi = if ($env:ADKCARS_PORT) { $env:ADKCARS_PORT }
           elseif ($env:PORT)     { $env:PORT }
           elseif ($PortDepuisEnv) { $PortDepuisEnv }
           else                   { '3000' }
$Base = "http://127.0.0.1:$PortApi"

$suffix = '{0:D8}' -f ([DateTime]::UtcNow.Ticks % 100000000)
$Phone = "+2250710$suffix"
$Email = "realtime.$suffix@adkcars.ci"
$Password = 'MotDePasseSolide2026'

$script:pass = 0
$script:fail = 0

function Check($Label, $Condition, $Detail = '') {
  if ($Condition) {
    $script:pass++
    Write-Host "  OK   $Label" -ForegroundColor Green
  } else {
    $script:fail++
    Write-Host "  ECHEC $Label $Detail" -ForegroundColor Red
  }
}

function Call($Method, $Path, $Body, $Headers = @{}) {
  $params = @{
    Uri = "$Base$Path"; Method = $Method; Headers = $Headers
    UseBasicParsing = $true; TimeoutSec = 20
  }
  if ($null -ne $Body) {
    $params['Body'] = ($Body | ConvertTo-Json -Depth 6 -Compress)
    $params['ContentType'] = 'application/json'
  }
  try {
    $r = Invoke-WebRequest @params
    return @{ Status = [int]$r.StatusCode; Body = $r.Content }
  } catch {
    $resp = $_.Exception.Response
    if ($null -eq $resp) { throw }
    return @{ Status = [int]$resp.StatusCode; Body = $_.ErrorDetails.Message }
  }
}

Write-Host ''
Write-Host '=== 1. OBTENTION D UN JETON ===' -ForegroundColor Cyan

$r = Call 'POST' '/auth/register' @{ email = $Email; phone = $Phone; password = $Password; role = 'client'; acceptTerms = $true }
if ($r.Status -ne 201) { Write-Host "  inscription impossible : $($r.Body)" -ForegroundColor Red; exit 1 }

# L'inscription declenche l'envoi d'un OTP, dont le code est ecrit dans
# le journal du fournisseur SMS simule. Il n'y a pas d'autre moyen de le
# recuperer : le flux de test ne peut donc pas court-circuiter la
# verification, et ne le doit pas.
Start-Sleep -Seconds 1
$logLine = Get-Content 'E:\ADKauto\apps\api\api.err.log' -ErrorAction SilentlyContinue |
  Select-String -Pattern 'SMS simule' | Select-Object -Last 1
$code = $null
if ($logLine -and $logLine.Line -match 'est (\d{6})') { $code = $Matches[1] }

$r = Call 'POST' '/auth/verify-phone' @{ phone = $Phone; code = if ($code) { $code } else { '000000' } }
Check 'inscription et verification OTP' ($r.Status -eq 200) "($($r.Status))"

# Le champ est `identifier`, pas `phone` : la connexion accepte un
# telephone OU un courriel.
$r = Call 'POST' '/auth/login' @{ identifier = $Phone; password = $Password }
$token = (ConvertFrom-Json $r.Body).accessToken
Check 'connexion' ($r.Status -eq 200 -and $null -ne $token) "($($r.Status) $($r.Body))"

$auth = @{ Authorization = "Bearer $token" }

Write-Host ''
Write-Host '=== 2. LE TRANSPORT EST BIEN SSE (A-17) ===' -ForegroundColor Cyan

$r = Call 'GET' '/realtime/status' $null $auth
Check 'route accessible avec jeton' ($r.Status -eq 200) "($($r.Status))"

if ($r.Status -eq 200) {
  $s = ConvertFrom-Json $r.Body
  Check 'transport = sse' ($s.transport -eq 'sse') "(obtenu : $($s.transport))"
  Check 'Socket.IO signale abandonne' ($s.socketIoAbandonne -eq $true)
  Check 'intervalle de lecture declare' ($s.pollIntervalMs -gt 0) "($($s.pollIntervalMs) ms)"
}

Write-Host ''
Write-Host '=== 3. LE FLUX REFUSE UNE CONNEXION SANS JETON ===' -ForegroundColor Cyan

$r = Call 'GET' '/realtime/events' $null @{}
# Un flux non authentifie doit etre refuse AVANT tout envoi d'evenements :
# une connexion anonyme qui diffuserait le flux d'un utilisateur serait
# une fuite de donnees, pas une erreur d'authentification.
Check 'refus sans jeton' ($r.Status -eq 401) "(recu : $($r.Status))"

Write-Host ''
Write-Host '=== 4. LE FLUX STREAM ET TRANSMET UN EVENEMENT NEUF ===' -ForegroundColor Cyan

# Ouverture d'un flux SSE sur une connexion TCP brute, pour lire les
# octets tels qu'ils arrivent. Invoke-WebRequest bufferait la reponse et
# ne montrait jamais le flux.
#
# La lecture se fait sur un tampon d'octets bruts, et non ligne a ligne
# avec `StreamReader` : ce dernier.decode au vol et consomme des octets
# au-dela du separateur d'en-tetes, ce qui perdait le premier evenement
# et(&(ne montrait aucun en-tete).
$client = New-Object System.Net.Sockets.TcpClient
$client.Connect('127.0.0.1', [int]$PortApi)
$stream = $client.GetStream()
$stream.ReadTimeout = 2000

# L'en-tete `Host` porte le port : un SSE mal route derriere un proxy
# s'y distingue. Il suit donc la meme variable que la connexion.
$request = "GET /realtime/events HTTP/1.1`r`n" +
           "Host: 127.0.0.1:$PortApi`r`n" +
           "Authorization: Bearer $token`r`n" +
           "Accept: text/event-stream`r`n" +
           "Connection: keep-alive`r`n`r`n"

$bytes = [System.Text.Encoding]::ASCII.GetBytes($request)
$stream.Write($bytes, 0, $bytes.Length)
$stream.Flush()

$buffer = New-Object byte[] 8192
$raw = New-Object System.Text.StringBuilder
$sw = [System.Diagnostics.Stopwatch]::StartNew()

# Phase 1 : les en-tetes, jusqu'au separateur de ligne vide.
while ($sw.Elapsed.TotalSeconds -lt 12) {
  if ($stream.DataAvailable) {
    $read = $stream.Read($buffer, 0, $buffer.Length)
    if ($read -gt 0) { [void]$raw.Append([System.Text.Encoding]::UTF8.GetString($buffer, 0, $read)) }
    if ($raw.ToString() -match "`r`n`r`n") { break }
  } else {
    Start-Sleep -Milliseconds 60
  }
}
$sw.Stop()

$head = $raw.ToString()
$sep = $head.IndexOf("`r`n`r`n")
$statusLine = if ($sep -gt 0) { $head.Substring(0, $head.IndexOf("`r`n")) } else { '(aucune)' }
$headerBlock = if ($sep -gt 0) { $head.Substring(0, $sep) } else { $head }

Check 'reponse recue' ($sep -gt 0) "(recu : '$statusLine')"
Check 'statut 200 sur le flux' ($statusLine -match '200 OK') "($statusLine)"
Check 'en-tete text/event-stream' ($headerBlock -match '(?i)content-type:\s*text/event-stream') `
  "(content-type absent)"

# `no-cache` n'est pas necessariamente le premier jeton : la valeur
# complete commence par `private, no-cache, ...`. Une assertion trop
# stricte echouait sur un flux parfaitement correct.
Check 'Cache-Control interdit la mise en cache' `
  ($headerBlock -match '(?i)cache-control:[^\r\n]*no-cache') `
  "(cache-control absent ou incorrect)"

# `no-transform` est ce qui empeche un proxy de recompresser ou
# d'agréger la reponse, ce qui retarderait chaque evenement jusqu'a la
# fermeture du flux. Son absence ne se voit pas : le flux fonctionne,
# mais il arrive en retard.
Check 'Cache-Control interdit la transformation' `
  ($headerBlock -match '(?i)cache-control:[^\r\n]*no-transform') `
  "(no-transform absent : un proxy pourrait mettre le flux en tampon)"

# `X-Accel-Buffering: no` est le equivalent cote nginx. Meme raison :
# son absence se manifeste par des evenements arrives en retard, pas par
# une panne visible.
Check 'X-Accel-Buffering desactive la mise en tampon' `
  ($headerBlock -match "(?i)x-accel-buffering:\s*no") `
  "(en-tete absent)"

# Injection d'un evenement APRES l'ouverture du flux : c'est ce qui
# distingue un flux vivant d'une simple lecture de l'historique.
$payload = @{ event = 'booking.updated'; payload = @{ bookingId = 'test-realtime-001' } } |
  ConvertTo-Json -Depth 5 -Compress

$psql = 'E:\ADKauto\.tools\pgsql\pgsql\bin\psql.exe'
$env:PGPASSWORD = 'adkcars_dev'

# Le nom de la table `user` est un mot reserve de PostgreSQL : il
# necessitates des guillemets doubles. Interpolation obligatoire —
# PowerShell ravage un `\"` ecrit dans une chaine simple.
$lookup = 'SELECT id FROM "user" WHERE phone = ''' + $Phone + ''';'

$userId = ($lookup | & $psql -U adkcars -h 127.0.0.1 -d adkcars_dev -q -t -A 2>&1 | Out-String).Trim()
Check 'utilisateur retrouve en base' ([bool]$userId) "(recu : '$userId')"

if ($userId) {
  # `channel` est limite a email|sms|push|whatsapp par une contrainte,
  # et `push` est le canal des evenements in-app. Une premiere version
  # utilisait un canal 'inapp' inexistant : l'insertion echouait, et le
  # test declarait pourtant un succes parce que la sortie d'erreur de
  # psql etait envoyee dans Out-Null.
  $sql = "INSERT INTO notification (user_id, event, channel, body, status) " +
         "VALUES ('$userId', 'booking.updated', 'push', " +
         "'Votre reservation a ete mise a jour.', 'queued');"

  $insertOut = ($sql | & $psql -U adkcars -h 127.0.0.1 -d adkcars_dev -q -t -A 2>&1 | Out-String).Trim()
  Check 'evenement injecte en base' ($LASTEXITCODE -eq 0 -and -not $insertOut) `
    "($(if ($insertOut) { $insertOut.Substring(0, [Math]::Min(120, $insertOut.Length)) } else { 'aucune erreur' }))"

  # Verification par relecture : un code de sortie peut mentir, une
  # ligne relue non. C'est la seule preuve que l'evenement est
  # reellement lisible par le flux.
  $verify = 'SELECT count(*) FROM notification WHERE user_id = ''' + $userId + ''';'
  $count = ($verify | & $psql -U adkcars -h 127.0.0.1 -d adkcars_dev -q -t -A 2>&1 | Out-String).Trim()
  Check 'evenement relisible en base' ($count -eq '1') "(reponses trouvees : '$count')"
} else {
  Check 'evenement injecte en base' $false "(utilisateur introuvable)"
}

# Lecture du flux pendant une fenetre plus large que l'intervalle de
# sondage (5 s) : un evenement produit maintenant doit apparaitre.
$body = New-Object System.Text.StringBuilder
$sw = [System.Diagnostics.Stopwatch]::StartNew()

while ($sw.Elapsed.TotalSeconds -lt 16) {
  if ($stream.DataAvailable) {
    $read = $stream.Read($buffer, 0, $buffer.Length)
    if ($read -gt 0) { [void]$body.Append([System.Text.Encoding]::UTF8.GetString($buffer, 0, $read)) }
    if ($body.ToString() -match 'booking\.updated') { break }
  } else {
    Start-Sleep -Milliseconds 120
  }
}
$sw.Stop()

# Un corps vide ne doit pas etre traite comme un succes : sans ce
# garde-fou, l'absence d'evenement passerait pour une reception.
$flat = ($body.ToString() -replace '\s+', ' ').Trim()
Check 'evenement recu sur le flux OUVERT' ($flat -match 'booking\.updated') `
  "(recu : '$flat')"

$client.Close()

Write-Host ''
if ($script:fail -eq 0) {
  Write-Host "=== TOUS LES TESTS TEMPS REEL SONT PASSES ($($script:pass)) ===" -ForegroundColor Green
  exit 0
} else {
  Write-Host "=== $($script:fail) ECHEC(S) SUR $($script:pass + $script:fail) ===" -ForegroundColor Red
  exit 1
}
