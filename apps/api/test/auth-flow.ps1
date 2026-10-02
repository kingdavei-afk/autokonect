# Test du parcours d'authentification de bout en bout.
# Utilise curl via PowerShell pour rester independant de tout outil externe.

$ErrorActionPreference = 'Stop'
$Base = 'http://127.0.0.1:3000'

# Numero unique par execution pour ne pas dependre d'un etat precedent
$suffix = (Get-Random -Minimum 10000 -Maximum 99999)
$Phone = "+2250709$suffix"
$Email = "test.$suffix@adkcars.ci"
$Password = 'MotDePasseSolide2026'

function Call($Method, $Path, $Body, $Headers = @{}) {
  $params = @{
    Uri = "$Base$Path"
    Method = $Method
    Headers = $Headers
    UseBasicParsing = $true
    TimeoutSec = 20
  }
  if ($null -ne $Body) {
    $params['Body'] = ($Body | ConvertTo-Json -Depth 6 -Compress)
    $params['ContentType'] = 'application/json'
  }

  $attempt = 0
  while ($true) {
    $attempt++
    try {
      $r = Invoke-WebRequest @params
      $result = @{ Status = [int]$r.StatusCode; Body = $r.Content }
    } catch {
      $resp = $_.Exception.Response
      if ($null -eq $resp) { throw }
      $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
      $result = @{ Status = [int]$resp.StatusCode; Body = $reader.ReadToEnd() }
    }

    # Le limiteur de debit est actif et compte par IP : toutes les
    # requetes de ce script viennent de 127.0.0.1. En cas de 429, on
    # attend la fin de la fenetre plutot que de contourner la regle.
    if ($result.Status -eq 429 -and $attempt -le 2) {
      Write-Host '  (limite de debit atteinte : attente de la fin de la fenetre)' -ForegroundColor DarkYellow
      Start-Sleep -Seconds 62
      continue
    }
    return $result
  }
}

function Show($Label, $Result, $Expected) {
  $ok = if ($Result.Status -eq $Expected) { 'OK ' } else { 'KO ' }
  $detail = ''
  try {
    $j = $Result.Body | ConvertFrom-Json
    if ($j.code) { $detail = "[$($j.code)] $($j.message)" }
    elseif ($j.nextStep) { $detail = "nextStep=$($j.nextStep)" }
    elseif ($j.status) { $detail = "status=$($j.status)" }
    elseif ($j.id) { $detail = "id=$($j.id.Substring(0,8))..." }
    elseif ($j.message) { $detail = $j.message }
  } catch { $detail = $Result.Body }
  Write-Host ("{0}{1,-46} attendu {2} -> {3}  {4}" -f $ok, $Label, $Expected, $Result.Status, $detail)
  return ($Result.Status -eq $Expected)
}

$results = @()
Write-Host ''
Write-Host '=== 1. INSCRIPTION ===' -ForegroundColor Cyan
$r = Call 'POST' '/auth/register' @{ email = $Email; phone = $Phone; password = $Password; role = 'client'; acceptTerms = $true }
$results += Show 'inscription' $r 201

Write-Host ''
Write-Host '=== 2. ANTI-ENUMERATION DES COMPTES ===' -ForegroundColor Cyan
$dup = Call 'POST' '/auth/register' @{ email = $Email; phone = "+2250708000000"; password = $Password; role = 'client'; acceptTerms = $true }
$results += Show 'email deja utilise' $dup 409

$dupPhone = Call 'POST' '/auth/register' @{ email = "dup.$suffix@adkcars.ci"; phone = $Phone; password = $Password; role = 'client'; acceptTerms = $true }
$results += Show 'telephone deja utilise' $dupPhone 409

Write-Host ''
Write-Host '=== 3. VALIDATION DES DONNEES ===' -ForegroundColor Cyan
$r = Call 'POST' '/auth/register' @{ email = 'pas-un-email'; phone = '002250700'; password = 'court'; acceptTerms = $true }
$results += Show 'format invalide rejete' $r 400

$r = Call 'POST' '/auth/register' @{ email = "y.$suffix@adkcars.ci"; phone = "+2250707000000"; password = $Password; acceptTerms = $false }
$results += Show 'conditions non acceptees rejete' $r 400

# Format de telephone invalide : la validation Zod doit s'executer AVANT
# la verification de doublon, sinon le client recoit un 409 trompeur.
$r = Call 'POST' '/auth/register' @{ email = "z.$suffix@adkcars.ci"; phone = '0022507080000'; password = $Password; acceptTerms = $true }
$results += Show 'format telephone invalide rejete' $r 400

$r = Call 'POST' '/auth/register' @{ email = "w.$suffix@adkcars.ci"; phone = $Phone; password = $Password; acceptTerms = $true }
$results += Show 'numero deja utilise' $r 409

Write-Host ''
Write-Host '=== 4. CONNEXION AVANT VERIFICATION ===' -ForegroundColor Cyan
$r = Call 'POST' '/auth/login' @{ identifier = $Email; password = $Password }
$results += Show 'connexion refusee (non verifie)' $r 401

$r = Call 'POST' '/auth/login' @{ identifier = $Email; password = 'MauvaisMotDePasse2026' }
$results += Show 'mot de passe errone rejete' $r 401

Write-Host ''
Write-Host '=== 5. VERIFICATION TELEPHONE ===' -ForegroundColor Cyan
$r = Call 'POST' '/auth/verify-phone' @{ phone = $Phone; code = '000000' }
$results += Show 'code OTP errone rejete' $r 401

# Recuperation du code depuis le journal du fournisseur SMS simule
Start-Sleep -Seconds 1
$logLine = Get-Content 'E:\ADKauto\apps\api\api.err.log' -ErrorAction SilentlyContinue |
  Select-String -Pattern 'SMS simule' | Select-Object -Last 1
$code = $null
if ($logLine -and $logLine.Line -match 'est (\d{6})') { $code = $Matches[1] }
Write-Host ("  code OTP lu dans le journal : " + $(if ($code) { $code } else { '(introuvable)' }))

if ($code) {
  $r = Call 'POST' '/auth/verify-phone' @{ phone = $Phone; code = $code }
  $results += Show 'code OTP valide' $r 200
  $tokens = ($r.Body | ConvertFrom-Json).tokens
} else {
  $tokens = $null
}

if ($tokens) {
  Write-Host ''
  Write-Host '=== 6. SESSION ===' -ForegroundColor Cyan
  $auth = @{ Authorization = "Bearer $($tokens.accessToken)" }

  $r = Call 'GET' '/auth/me' $null $auth
  $results += Show 'profil avec jeton valide' $r 200

  $r = Call 'GET' '/auth/me' $null @{ Authorization = 'Bearer invalide.faux.jeton' }
  $results += Show 'profil avec faux jeton refuse' $r 401

  $r = Call 'GET' '/auth/me' $null @{}
  $results += Show 'profil sans jeton refuse' $r 401

  $r = Call 'POST' '/auth/refresh' @{ refreshToken = $tokens.refreshToken }
  $results += Show 'rafraichissement' $r 200
  $rotated = ($r.Body | ConvertFrom-Json)

  # Detection de reutilisation : le jeton deja consomme doit etre refuse
  # et toute la serie revoquee.
  $r = Call 'POST' '/auth/refresh' @{ refreshToken = $tokens.refreshToken }
  $results += Show 'reutilisation de jeton detectee' $r 401

  $r = Call 'POST' '/auth/refresh' @{ refreshToken = $rotated.refreshToken }
  $results += Show 'serie complete revoquee apres vol' $r 401
}

Write-Host ''
Write-Host '=== 7. ROTATION : les sessions sont independantes ===' -ForegroundColor Cyan
$phone2 = "+2250710$suffix"
$email2 = "solo.$suffix@adkcars.ci"
$r = Call 'POST' '/auth/register' @{ email = $email2; phone = $phone2; password = $Password; role = 'client'; acceptTerms = $true }
Start-Sleep -Milliseconds 700
$line = Get-Content 'E:\ADKauto\apps\api\api.err.log' | Select-String -Pattern 'SMS simule' | Select-Object -Last 1
if ($line -and $line.Line -match 'est (\d{6})') {
  $r = Call 'POST' '/auth/verify-phone' @{ phone = $phone2; code = $Matches[1] }
  $results += Show 'deuxieme compte verifie' $r 200
  $t2 = ($r.Body | ConvertFrom-Json).tokens

  $r = Call 'POST' '/auth/refresh' @{ refreshToken = $t2.refreshToken }
  $results += Show 'session du 2e compte intacte' $r 200
}

Write-Host ''
Write-Host '=== 8. NON ENUMERATION (mot de passe oublie) ===' -ForegroundColor Cyan
$r = Call 'POST' '/auth/password/forgot' @{ identifier = $email2 }
$results += Show 'reinitialisation sur compte existant' $r 202
$r = Call 'POST' '/auth/password/forgot' @{ identifier = "inconnu.$suffix@adkcars.ci" }
$results += Show 'reinitialisation sur compte inexistant' $r 202

Write-Host ''
Write-Host '=== 9. JETON D ACCES COMME JETON DE RAFRAICHISSEMENT ===' -ForegroundColor Cyan
if ($tokens) {
  $r = Call 'POST' '/auth/refresh' @{ refreshToken = $tokens.accessToken }
  $results += Show 'accepte comme jeton de rafraichissement ? (0 attendu)' $r 401
}

Write-Host ''
$ok = ($results | Where-Object { $_ }).Count
$ko = ($results | Where-Object { -not $_ }).Count
Write-Host ("RESULTAT : {0} reussis, {1} echecs sur {2}" -f $ok, $ko, ($ok + $ko)) -ForegroundColor $(if ($ko -eq 0) { 'Green' } else { 'Red' })
exit $ko