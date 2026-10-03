# Test du catalogue vehicule de bout en bout.
param()

$ErrorActionPreference = 'Stop'
$Base = 'http://127.0.0.1:3000'

# Suffixe unique par execution : derive de l'horloge a la milliseconde.
#
# Un tirage aleatoire produisait des collisions entre runs successifs, et
# le test echouait sur un EMAIL_ALREADY_USED emis par le run precedent
# avant meme d'avoir verifie quoi que ce soit.
$suffix = '{0:D8}' -f ([DateTime]::UtcNow.Ticks % 100000000)
$Plate  = "T$suffix"
$Password = 'MotDePasseSolide2026'

function Call($Method, $Path, $Body, $Headers = @{}) {
  $params = @{
    Uri = "$Base$Path"; Method = $Method; Headers = $Headers
    UseBasicParsing = $true; TimeoutSec = 25
  }
  if ($null -ne $Body) {
    $params['Body'] = ($Body | ConvertTo-Json -Depth 8 -Compress)
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

      # SOURCE DU CORPS : `ErrorDetails.Message`.
      #
      # Sous Windows PowerShell 5.1, des que $ErrorActionPreference vaut
      # 'Stop', le moteur d'erreur consomme et ferme le flux de reponse
      # AVANT d'entrer dans le bloc catch : `GetResponseStream()` renvoie
      # alors un corps vide. Lire le flux directement produirait des
      # messages d'erreur de longueur 0, impossibles a diagnostiquer.
      $body = $_.ErrorDetails.Message
      if ([string]::IsNullOrWhiteSpace($body)) {
        try {
          $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
          $body = $reader.ReadToEnd()
        } catch {
          $body = ''
        }
      }

      $result = @{ Status = [int]$resp.StatusCode; Body = $body }
    }
    if ($result.Status -eq 429 -and $attempt -le 2) {
      Write-Host '  (limite de debit : attente)' -ForegroundColor DarkYellow
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
    if ($j.code) {
      $detail = "[$($j.code)]"
      if ($j.message) { $detail += " $($j.message)" }
    } elseif ($j.items) { $detail = "$($j.items.Count) resultat(s)" }
    elseif ($j.id) { $detail = "id=$($j.id.Substring(0,8)) status=$($j.status)" }
    elseif ($j.ready -ne $null) { $detail = "ready=$($j.ready) : $($j.reasons -join '; ')" }
  } catch { $detail = $Result.Body }
  Write-Host ("{0}{1,-44} attendu {2} -> {3}  {4}" -f $ok, $Label, $Expected, $Result.Status, $detail)
  return ($Result.Status -eq $Expected)
}

$results = @()

# -------------------------------------------------------------------
Write-Host ''
Write-Host '=== 0. Preparation : catalogue de base ===' -ForegroundColor Cyan
$env:PGPASSWORD = 'adkcars_dev'
$psql = 'E:\ADKauto\.tools\pgsql\pgsql\bin\psql.exe'
& $psql -U adkcars -h 127.0.0.1 -d adkcars_dev -q -c @"
INSERT INTO currency (code, name, symbol, minor_units)
VALUES ('XOF','Franc CFA','FCFA',0) ON CONFLICT (code) DO NOTHING;
INSERT INTO vehicle_category (slug, label, sort_order)
VALUES ('berline','Berline',1),('suv','SUV',2),('citadine','Citadine',3)
ON CONFLICT (slug) DO NOTHING;
"@ 2>&1 | Out-Null
$cat = (& $psql -U adkcars -h 127.0.0.1 -d adkcars_dev -t -A -c "SELECT id FROM vehicle_category WHERE slug='suv'") -replace '\s',''
Write-Host "  categorie suv : $cat"

# -------------------------------------------------------------------
Write-Host ''
Write-Host '=== 1. Acces non authentifie ===' -ForegroundColor Cyan
$results += Show 'recherche sans jeton' (Call 'GET' '/vehicles') 401
$results += Show 'creation sans jeton' (Call 'POST' '/vehicles' @{ brand='X' }) 401

# -------------------------------------------------------------------
Write-Host ''
Write-Host '=== 2. Inscription du proprietaire ===' -ForegroundColor Cyan
$email = "prop.$suffix@adkcars.ci"
$phone = "+2250720$suffix"
$r = Call 'POST' '/auth/register' @{ email=$email; phone=$phone; password=$Password; role='client'; acceptTerms=$true }
$results += Show 'inscription' $r 201
Start-Sleep -Milliseconds 700
$line = Get-Content 'E:\ADKauto\apps\api\api.err.log' | Select-String 'SMS simule' | Select-Object -Last 1
if ($line -and $line.Line -match 'est (\d{6})') {
  $r = Call 'POST' '/auth/verify-phone' @{ phone=$phone; code=$Matches[1] }
  $results += Show 'verification telephone' $r 200
  $auth = @{ Authorization = "Bearer $(($r.Body | ConvertFrom-Json).tokens.accessToken)" }
} else { $auth = @{} }

# -------------------------------------------------------------------
Write-Host ''
Write-Host '=== 3. Creation de vehicule ===' -ForegroundColor Cyan
$payload = @{
  categoryId=$cat; brand='Toyota'; model='Land Cruiser'; year=2023
  plateNumber=$Plate; transmission='automatic'; fuel='diesel'; seats=7
  dailyRate='4500000'; withDriver=$false; features=@('gps','climatisation')
}
$r = Call 'POST' '/vehicles' $payload $auth
$results += Show 'creation' $r 201
$vehicleId = ($r.Body | ConvertFrom-Json).id

$results += Show 'plaque deja utilisee' (Call 'POST' '/vehicles' $payload $auth) 409

$bad = $payload.Clone(); $bad['dailyRate'] = '45000.50'
$results += Show 'tarif decimal refuse' (Call 'POST' '/vehicles' $bad $auth) 400

$bad2 = $payload.Clone(); $bad2['plateNumber'] = 'AVEC-TIRETS'
$results += Show 'plaque avec tirets refusee' (Call 'POST' '/vehicles' $bad2 $auth) 400

$bad3 = $payload.Clone(); $bad3['withDriver'] = $false; $bad3['driverIncludedInRate'] = $true
$results += Show 'chauffeur inclus sans option refuse' (Call 'POST' '/vehicles' $bad3 $auth) 400

# -------------------------------------------------------------------
Write-Host ''
Write-Host '=== 4. Cycle de publication ===' -ForegroundColor Cyan
$r = Call 'GET' "/vehicles/$vehicleId" $null $auth
$results += Show 'lecture du brouillon' $r 200

$r = Call 'GET' "/vehicles/$vehicleId/publication-readiness" $null $auth
$results += Show 'documents manquants signales' $r 200

$r = Call 'POST' "/vehicles/$vehicleId/submit" @{} $auth
$results += Show 'soumission refusee sans documents' $r 422

Call 'POST' "/vehicles/$vehicleId/documents" @{ kind='registration'; fileUrl='https://files.adkcars.ci/cg.pdf'; expiresAt='2030-01-01' } $auth | Out-Null
$r = Call 'POST' "/vehicles/$vehicleId/submit" @{} $auth
$results += Show 'soumission refusee (assurance manquante)' $r 422

Call 'POST' "/vehicles/$vehicleId/documents" @{ kind='insurance'; fileUrl='https://files.adkcars.ci/ass.pdf'; expiresAt='2030-01-01' } $auth | Out-Null
$r = Call 'POST' "/vehicles/$vehicleId/submit" @{} $auth
$results += Show 'soumission acceptee' $r 200
$results += Show 'double soumission refusee' (Call 'POST' "/vehicles/$vehicleId/submit" @{} $auth) 409

# -------------------------------------------------------------------
Write-Host ''
Write-Host '=== 5. Recherche publique ===' -ForegroundColor Cyan
$r = Call 'GET' '/vehicles' $null $auth
$results += Show 'recherche (vehicule non publie invisible)' $r 200
$count = ($r.Body | ConvertFrom-Json).items.Count
Write-Host "  vehicules publies visibles : $count (attendu 0, le vehicule est en revue)"

$r = Call 'GET' '/vehicles?q=landcruiser' $null $auth
$results += Show 'recherche plein texte' $r 200

$r = Call 'GET' '/vehicles?perPage=500' $null $auth
$results += Show 'page trop grande refusee' $r 400

$r = Call 'GET' '/vehicles?minPrice=9000&maxPrice=1000' $null $auth
$results += Show 'intervalle de prix incoherent refuse' $r 400

$r = Call 'GET' '/vehicles?availableFrom=2026-12-20&availableTo=2026-12-10' $null $auth
$results += Show 'intervalle de dates incoherent refuse' $r 400

$r = Call 'GET' '/vehicles/mine' $null $auth
$results += Show 'mes vehicules' $r 200

# -------------------------------------------------------------------
Write-Host ''
Write-Host '=== 6. Isolation entre proprietaires ===' -ForegroundColor Cyan
$email2 = "autre.$suffix@adkcars.ci"; $phone2 = "+2250721$suffix"
Call 'POST' '/auth/register' @{ email=$email2; phone=$phone2; password=$Password; role='client'; acceptTerms=$true } | Out-Null
Start-Sleep -Milliseconds 700
$line = Get-Content 'E:\ADKauto\apps\api\api.err.log' | Select-String 'SMS simule' | Select-Object -Last 1
if ($line -and $line.Line -match 'est (\d{6})') {
  $r = Call 'POST' '/auth/verify-phone' @{ phone=$phone2; code=$Matches[1] }
  $auth2 = @{ Authorization = "Bearer $(($r.Body | ConvertFrom-Json).tokens.accessToken)" }
  # 404 et non 403 : ne pas confirmer l existence de l annonce d autrui
  $results += Show 'vehicule d autrui : 404 et non 403' (Call 'GET' "/vehicles/$vehicleId" $null $auth2) 404
  $results += Show 'modification d autrui refusee' (Call 'PATCH' "/vehicles/$vehicleId" @{ dailyRate='1' } $auth2) 404
}

Write-Host ''
$ok = ($results | Where-Object { $_ }).Count
$ko = ($results | Where-Object { -not $_ }).Count
Write-Host ("RESULTAT : {0} reussis, {1} echecs sur {2}" -f $ok, $ko, ($ok + $ko)) -ForegroundColor $(if ($ko -eq 0) { 'Green' } else { 'Red' })
exit $ko