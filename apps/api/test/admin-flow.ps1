# Back-office : file de validation vehicule, de bout en bout.
#
# Prerequis : API demarree sur :3000, base migree.
#   .\scripts\dev-db.ps1 start
#   pnpm db:migrate
#   pnpm dev:api
#   .\apps\api\test\admin-flow.ps1
param()

$ErrorActionPreference = 'Stop'
$Base = 'http://127.0.0.1:3000'
$psql = 'E:\ADKauto\.tools\pgsql\pgsql\bin\psql.exe'
$env:PGPASSWORD = 'adkcars_dev'

if (-not (Test-Path $psql)) {
  Write-Host "psql introuvable : $psql" -ForegroundColor Red
  Write-Host 'Renseignez PSQL_BIN ou adaptez $psql dans ce script.' -ForegroundColor Red
  exit 1
}

# Suffixe unique par execution : derive de l'horloge a la milliseconde.
#
# Un tirage aleatoire produisait des collisions entre runs successifs, et
# le test echouait sur un EMAIL_ALREADY_USED emis par le run precedent
# avant meme d'avoir verifie quoi que ce soit.
$suffix = '{0:D8}' -f ([DateTime]::UtcNow.Ticks % 100000000)
$Password = 'MotDePasseSolide2026'
$results  = @()

function Call($Method, $Path, $Body, $Headers = @{}) {
  $params = @{
    Uri = "$Base$Path"; Method = $Method; Headers = $Headers
    UseBasicParsing = $true; TimeoutSec = 25
  }
  if ($null -ne $Body) {
    $params['Body'] = ($Body | ConvertTo-Json -Depth 8 -Compress)
    $params['ContentType'] = 'application/json'
  }
  # Le limiteur de debit compte par IP et toutes les requetes viennent de
  # 127.0.0.1 : on attend la fin de la fenetre plutot que de la contourner.
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
    if ($result.Status -eq 429 -and $attempt -le 3) {
      Write-Host '  (limite de debit : attente de la fin de la fenetre)' -ForegroundColor DarkYellow
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
    if ($j.code)            { $detail = "[$($j.code)] $($j.message)" }
    elseif ($null -ne $j.items)  { $detail = "$($j.items.Count) element(s), page $($j.pagination.page)/$($j.pagination.totalPages)" }
    elseif ($null -ne $j.blockers) { $detail = "blocages : $($j.blockers -join ' | ')" }
    elseif ($j.documents)   { $detail = "$($j.documents.Count) document(s)" }
    elseif ($j.status)      { $detail = "statut=$($j.status)" }
  } catch { $detail = $Result.Body }
  Write-Host ("{0}{1,-48} attendu {2} -> {3}  {4}" -f $ok, $Label, $Expected, $Result.Status, $detail)
  return ($Result.Status -eq $Expected)
}

function Invoke-Sql([string] $statement) {
  # Le SQL passe par l'entree standard, jamais par `-c`.
  #
  # PowerShell transmet les arguments aux processus natifs via une ligne de
  # commande : les guillemets doubles internes y sont perdus.
  # `UPDATE "user" ...` devenait `UPDATE user ...`, erreur de syntaxe car
  # `user` est un mot reserve en SQL.
  # Pendant l'appel a psql, `Stop` est desactive : sinon PowerShell
  # transforme la sortie stderr de psql en erreur bloquante AVANT que
  # le code puisse l'examiner, et une simple requete SQL invalide
  # interromprait le script sans diagnostic.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $output = $statement | & $psql -U adkcars -h 127.0.0.1 -d adkcars_dev -q -t -A 2>&1
  $ErrorActionPreference = $previous

  $text = ($output -join "`n")

  # Toute erreur SQL est remontee avec la requete : sans cela, le test
  # echoue sur un message generique sans piste (CDCS 11.8).
  if ($text -match 'ERROR') {
    Write-Host "  [SQL EN ERREUR] $statement" -ForegroundColor Red
    Write-Host "  [DETAIL] $text" -ForegroundColor Red
  }

  return $text
}

function Sql([string] $statement) {
  Invoke-Sql $statement | Out-Null
}

function SqlScalar([string] $statement) {
  return (((Invoke-Sql $statement) -join '').Trim())
}

function New-Account([string] $email, [string] $phone) {
  # Cree un compte et verifie son telephone. Ne renvoie PAS de jeton :
  # la promotion d'un role doit pouvoir intervenir entre la creation et
  # l'obtention des droits.
  $r = Call 'POST' '/auth/register' @{
    email = $email; phone = $phone; password = $Password
    role = 'client'; acceptTerms = $true
  }
  if ($r.Status -ne 201) {
    throw "inscription echouee (statut $($r.Status)) : $($r.Body)"
  }

  Start-Sleep -Milliseconds 800
  $line = Get-Content 'E:\ADKauto\apps\api\api.err.log' -ErrorAction SilentlyContinue |
    Select-String 'SMS simule' | Select-Object -Last 1
  if ($line.Line -match 'est (\d{6})') { $code = $Matches[1] } else { throw 'code OTP introuvable' }

  $v = Call 'POST' '/auth/verify-phone' @{ phone = $phone; code = $code }
  if ($v.Status -ne 200) {
    throw "verification echouee (statut $($v.Status)) : $($v.Body)"
  }

  return @{ email = $email; phone = $phone }
}

function Login([string] $email) {
  # Les roles sont figes dans le jeton a son emission (CDCS 12.3) :
  # un jeton obtenu AVANT une promotion ne porterait pas le role.
  $r = Call 'POST' '/auth/login' @{ identifier = $email; password = $Password }
  if ($r.Status -ne 200) {
    throw "connexion echouee (statut $($r.Status)) : $($r.Body)"
  }

  return @{ Authorization = "Bearer $(($r.Body | ConvertFrom-Json).accessToken)" }
}

# -------------------------------------------------------------------
Write-Host ''
Write-Host '=== 0. Preparation ===' -ForegroundColor Cyan
Sql "INSERT INTO currency (code,name,symbol,minor_units) VALUES ('XOF','Franc CFA','FCFA',0) ON CONFLICT DO NOTHING;"
Sql "INSERT INTO vehicle_category (slug,label,sort_order) VALUES ('suv','SUV',1) ON CONFLICT DO NOTHING;"
$cat = SqlScalar "SELECT id FROM vehicle_category WHERE slug='suv'"

$ownerAccount = New-Account "owner.$suffix@adkcars.ci" "+2250730$suffix"
$authOwner = Login $ownerAccount.email

# Le compte administrateur est cree, puis promeu par SQL.
#
# L'octroi d'un role administrateur par requete directe est reserve au
# developpement local ; en production il passe par une procedure
# outillee et journalisee (CDCS 12.5).
#
# L'ordre compte : la promotion intervient AVANT l'obtention du jeton,
# car les roles sont figes dans le jeton a son emission (CDCS 12.3).
$adminAccount = New-Account "admin.$suffix@adkcars.ci" "+2250731$suffix"
Sql "UPDATE ""user"" SET roles = array_append(roles,'admin') WHERE email = '$($adminAccount.email)';"

$authAdmin = Login $adminAccount.email

$adminRoles = SqlScalar "SELECT array_to_string(roles, ',') FROM ""user"" WHERE email = '$($adminAccount.email)'"
Write-Host "  categorie       : $cat"
Write-Host "  roles du compte : $adminRoles" -ForegroundColor $(if ($adminRoles -like '*admin*') { 'Green' } else { 'Red' })

Write-Host ''
Write-Host '=== 1. Controle d acces ===' -ForegroundColor Cyan
$results += Show 'file sans jeton'       (Call 'GET' '/admin/vehicles') 401
$results += Show 'file avec role client' (Call 'GET' '/admin/vehicles' $null $authOwner) 403

# -------------------------------------------------------------------
Write-Host ''
Write-Host '=== 2. Soumission a validation ===' -ForegroundColor Cyan
$vid = (Call 'POST' '/vehicles' @{
  categoryId = $cat; brand = 'Nissan'; model = 'Qashqai'; year = 2021
  plateNumber = "A$suffix"; transmission = 'manual'; fuel = 'petrol'; seats = 5
  dailyRate = '2500000'
} $authOwner).Body | ConvertFrom-Json | Select-Object -ExpandProperty id

# Une soumission sans documents est refusee : c'est le premier garde-fou
# du proprietaire, avant meme que l'administrateur n'intervienne.
$results += Show 'soumission sans documents refusee' `
  (Call 'POST' "/vehicles/$vid/submit" @{} $authOwner) 422

$results += Show 'validation avant soumission' `
  (Call 'POST' "/admin/vehicles/$vid/decision" @{ action = 'approve' } $authAdmin) 400

# -------------------------------------------------------------------
Write-Host ''
Write-Host '=== 3. Depot des documents et soumission ===' -ForegroundColor Cyan
Call 'POST' "/vehicles/$vid/documents" @{ kind='registration'; fileUrl='https://f.ci/cg.pdf'; expiresAt='2031-01-01' } $authOwner | Out-Null
Call 'POST' "/vehicles/$vid/documents" @{ kind='insurance';   fileUrl='https://f.ci/as.pdf'; expiresAt='2031-01-01' } $authOwner | Out-Null

$results += Show 'soumission avec documents' `
  (Call 'POST' "/vehicles/$vid/submit" @{} $authOwner) 200

# -------------------------------------------------------------------
Write-Host ''
Write-Host '=== 4. File d attente et examen ===' -ForegroundColor Cyan
$r = Call 'GET' '/admin/vehicles?status=in_review' $null $authAdmin
$results += Show 'file de validation' $r 200
$present = ($r.Body | ConvertFrom-Json).items | Where-Object { $_.id -eq $vid }
Write-Host ("  vehicule present dans la file : " + $(if ($present) { 'oui' } else { 'NON' })) -ForegroundColor $(if ($present) { 'Green' } else { 'Red' })
$results += ($null -ne $present)

$r = Call 'GET' "/admin/vehicles/$vid" $null $authAdmin
$results += Show 'detail de revue' $r 200
$docIds = @{}
foreach ($d in ($r.Body | ConvertFrom-Json).documents) { $docIds[$d.kind] = $d.id }
Write-Host "  documents : $($docIds.Keys -join ', ')"

# -------------------------------------------------------------------
Write-Host ''
Write-Host '=== 5. Publication bloquee tant que les documents ne sont pas valides ===' -ForegroundColor Cyan
$results += Show 'publication documents non valides' `
  (Call 'POST' "/admin/vehicles/$vid/decision" @{ action = 'approve' } $authAdmin) 409

# -------------------------------------------------------------------
Write-Host ''
Write-Host '=== 5. Revue des documents ===' -ForegroundColor Cyan
$results += Show 'rejet de document sans motif' `
  (Call 'POST' "/admin/vehicles/$vid/documents/review" @{ documentId = $docIds['registration']; accept = $false } $authAdmin) 400

$results += Show 'rejet de document motive' `
  (Call 'POST' "/admin/vehicles/$vid/documents/review" @{ documentId = $docIds['registration']; accept = $false; rejectReason = 'Photo illisible, verso manquant' } $authAdmin) 200

$results += Show 'publication avec document rejete' `
  (Call 'POST' "/admin/vehicles/$vid/decision" @{ action = 'approve' } $authAdmin) 409

$results += Show 'validation du premier document' `
  (Call 'POST' "/admin/vehicles/$vid/documents/review" @{ documentId = $docIds['registration']; accept = $true } $authAdmin) 200
$results += Show 'validation du second document' `
  (Call 'POST' "/admin/vehicles/$vid/documents/review" @{ documentId = $docIds['insurance']; accept = $true } $authAdmin) 200

# -------------------------------------------------------------------
Write-Host ''
Write-Host '=== 6. Publication ===' -ForegroundColor Cyan
$results += Show 'publication' `
  (Call 'POST' "/admin/vehicles/$vid/decision" @{ action = 'approve' } $authAdmin) 200
$results += Show 'lecture du vehicule' (Call 'GET' "/vehicles/$vid" $null $authOwner) 200

$r = Call 'GET' '/vehicles?q=qashqai' $null $authOwner
$results += Show 'recherche publique' $r 200
$found = ($r.Body | ConvertFrom-Json).items | Where-Object { $_.id -eq $vid }
Write-Host ("  vehicule retrouve en recherche publique : " + $(if ($found) { 'oui' } else { 'NON' })) -ForegroundColor $(if ($found) { 'Green' } else { 'Red' })
$results += ($null -ne $found)

# -------------------------------------------------------------------
Write-Host ''
Write-Host '=== 7. Refus motive et resoumission ===' -ForegroundColor Cyan
$vid2 = (Call 'POST' '/vehicles' @{
  categoryId = $cat; brand = 'Kia'; model = 'Sportage'; year = 2020
  plateNumber = "B$suffix"; transmission = 'automatic'; fuel = 'hybrid'; seats = 5
  dailyRate = '3000000'
} $authOwner).Body | ConvertFrom-Json | Select-Object -ExpandProperty id

Call 'POST' "/vehicles/$vid2/documents" @{ kind='registration'; fileUrl='https://f.ci/cg2.pdf'; expiresAt='2031-01-01' } $authOwner | Out-Null
Call 'POST' "/vehicles/$vid2/documents" @{ kind='insurance';   fileUrl='https://f.ci/as2.pdf'; expiresAt='2031-01-01' } $authOwner | Out-Null
Call 'POST' "/vehicles/$vid2/submit" @{} $authOwner | Out-Null

$results += Show 'refus sans motif' `
  (Call 'POST' "/admin/vehicles/$vid2/decision" @{ action = 'reject' } $authAdmin) 400
$results += Show 'refus motive' `
  (Call 'POST' "/admin/vehicles/$vid2/decision" @{ action = 'reject'; reason = 'Kilometrage non verifiable sur la photo' } $authAdmin) 200

$r = Call 'GET' "/vehicles/$vid2" $null $authOwner
$status = ($r.Body | ConvertFrom-Json).status
$results += Show 'statut rejete' $r 200
Write-Host "  statut du vehicule : $status"

$results += Show 'resoumission autorisee' (Call 'POST' "/vehicles/$vid2/submit" @{} $authOwner) 200

# -------------------------------------------------------------------
Write-Host ''
Write-Host '=== 8. Expiration d un document ===' -ForegroundColor Cyan
$vid3 = (Call 'POST' '/vehicles' @{
  categoryId = $cat; brand = 'Dacia'; model = 'Duster'; year = 2019
  plateNumber = "C$suffix"; transmission = 'manual'; fuel = 'diesel'; seats = 5
  dailyRate = '1800000'
} $authOwner).Body | ConvertFrom-Json | Select-Object -ExpandProperty id

Call 'POST' "/vehicles/$vid3/documents" @{ kind='registration'; fileUrl='https://f.ci/cg3.pdf'; expiresAt='2020-01-01' } $authOwner | Out-Null
Call 'POST' "/vehicles/$vid3/documents" @{ kind='insurance';   fileUrl='https://f.ci/as3.pdf'; expiresAt='2020-01-01' } $authOwner | Out-Null

$r = Call 'GET' "/admin/vehicles/$vid3" $null $authAdmin
$expired = ($r.Body | ConvertFrom-Json).documents | Where-Object { $_.effectiveStatus -eq 'expired' }
Write-Host ("  documents detectes expires : {0} (statut en base : {1})" -f $expired.Count, (($expired | ForEach-Object { $_.storedStatus }) -join ', '))
$results += ($expired.Count -eq 2)
$results += Show 'soumission refusee (documents expires)' `
  (Call 'POST' "/vehicles/$vid3/submit" @{} $authOwner) 422

# -------------------------------------------------------------------
Write-Host ''
Write-Host '=== 9. Journal d audit ===' -ForegroundColor Cyan
$audit = SqlScalar "SELECT count(*) FROM audit_log WHERE entity='vehicle' AND entity_id='$vid'"
Write-Host "  entrees d audit pour le vehicule publie : $audit"
$results += ([int]$audit -ge 3)

$queued = SqlScalar "SELECT count(*) FROM notification WHERE event IN ('vehicle.published','vehicle.rejected','vehicle.document_rejected')"
Write-Host "  notifications mises en file : $queued"
$results += ([int]$queued -ge 1)

Write-Host ''
$ok = ($results | Where-Object { $_ }).Count
$ko = ($results | Where-Object { -not $_ }).Count
Write-Host ("RESULTAT : {0} reussis, {1} echecs sur {2}" -f $ok, $ko, ($ok + $ko)) -ForegroundColor $(if ($ko -eq 0) { 'Green' } else { 'Red' })
exit $ko