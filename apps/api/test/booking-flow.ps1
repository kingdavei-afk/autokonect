# Test du parcours de reservation de bout en bout (CDCS 8).
#
# Ce que ce test verifie, et pourquoi :
#
#   1. Une reservation creee occupe le vehicule, et la base REFUSE la
#      seconde reservation sur les memes dates. Le refus vient du
#      declencheur, pas du service : c'est la seule garantie qui tient
#      sous concurrence reelle.
#
#   2. Une reservation VUE par un tiers est invisible, pas seulement
#      interdite. C'est ce qui empeche d'enumerer le carnet de commandes
#      d'un concurrent par sondage d'identifiants.
#
#   3. Une transition non autorisee est refusee en 409, avec la liste de
#      ce qui serait possible.
#
#   4. Le verrou optimiste : deux transitions concurrentes ne peuvent pas
#      aboutir. Sans lui, une annulation disparait en silence.
#
#   5. Chaque transition laisse une trace d'audit. Un changement d'etat
#      sans trace est inexpliquable en cas de litige.

$ErrorActionPreference = 'Continue'
$Base = 'http://127.0.0.1:3000'

$suffix = '{0:D8}' -f ([DateTime]::UtcNow.Ticks % 100000000)

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
    $params['Body'] = ($Body | ConvertTo-Json -Depth 8 -Compress)
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

# ---------------------------------------------------------------------------
# Utilitaires de jeu de donnees
# ---------------------------------------------------------------------------
$psql = 'E:\ADKauto\.tools\pgsql\pgsql\bin\psql.exe'
$env:PGPASSWORD = 'adkcars_dev'

function Sql([string] $query) {
  return (($query | & $psql -U adkcars -h 127.0.0.1 -d adkcars_dev -q -t -A 2>&1 | Out-String).Trim())
}

# Le role `admin` est FIGE dans le JWT au moment de sa delivrance :
# l]'octroi apres l'obtention du jeton ne servirait a rien.
function GrantAdmin([string] $userId) {
  Sql ("UPDATE ""user"" SET roles = array_append(roles,'admin') WHERE id = '$userId';") | Out-Null
}

# `$prefix` rend chaque compte unique : `phone` porte une contrainte
# d'unicite, et quatre comptes sur le meme numero se contamineraient.
#
# `$promoteAdmin` promou le compte APRES inscription. Le role ne peut pas
# etre demande a l'inscription — un client ne s'attribue pas
# administrateur — c'est une regle de securite, pas une commodite de
# test. La promotion se fait donc en base, comme en exploitation.
function NewUser([string] $tag, [string] $role = 'client', [string] $prefix = '0750', [switch] $promoteAdmin) {
  $phone = "+225$prefix$suffix"
  $email = "$tag.$suffix@adkcars.ci"
  $password = 'MotDePasseSolide2026'

  $r = Call 'POST' '/auth/register' @{ email = $email; phone = $phone; password = $password; role = $role; acceptTerms = $true }
  if ($r.Status -ne 201) { Write-Host "  inscription $tag impossible : $($r.Body)" -ForegroundColor Red; exit 1 }

  Start-Sleep -Milliseconds 900
  $line = Get-Content 'E:\ADKauto\apps\api\api.err.log' -ErrorAction SilentlyContinue |
    Select-String -Pattern 'SMS simule' | Select-Object -Last 1
  $code = $null
  if ($line -and $line.Line -match 'est (\d{6})') { $code = $Matches[1] }

  $r = Call 'POST' '/auth/verify-phone' @{ phone = $phone; code = if ($code) { $code } else { '000000' } }
  if ($r.Status -ne 200) { Write-Host "  verification $tag impossible : $($r.Body)" -ForegroundColor Red; exit 1 }

  # Promotion AVANT la connexion : les roles sont figes dans le JWT au
  # moment de sa delivrance. Promouvoir apres n'aurait aucun effet sur
  # le jeton obtenu.
  if ($promoteAdmin) { GrantAdmin ((Sql ("SELECT id FROM ""user"" WHERE phone = '$phone';"))) }

  $r = Call 'POST' '/auth/login' @{ identifier = $phone; password = $password }
  if ($r.Status -ne 200) { Write-Host "  connexion $tag impossible : $($r.Body)" -ForegroundColor Red; exit 1 }

  return @{ Phone = $phone; Email = $email; Password = $password; Token = (ConvertFrom-Json $r.Body).accessToken }
}

function Auth($u) { return @{ Authorization = "Bearer $($u.Token)" } }

# Fenetre de dates dans le futur, distincte par reservation pour eviter
# que deux tests se marchent dessus.
#
# ⚠️ Cette variable ne doit PAS s'appeler `$base`. PowerShell ignore la
# casse des noms de variables : `$base = (Get-Date)...` ecrase
# `$Base = 'http://127.0.0.1:3000'`, et la premiere requete part alors
# vers « 10/10/2026 ... POST/auth/register ». L'erreur est un refus de
# connexion, sans aucun rapport avec la reservation — ce qui la rend
# très difficile à relier à sa cause.
$windowStart = (Get-Date).AddDays(40)

function Dates([int] $dayOffset, [int] $nights = 3) {
  $start = $windowStart.AddDays($dayOffset).ToUniversalTime()
  return @{
    startAt = $start.ToString('yyyy-MM-ddTHH:mm:ssZ')
    endAt = $start.AddDays($nights).ToString('yyyy-MM-ddTHH:mm:ssZ')
  }
}

Write-Host ''
Write-Host '=== 1. COMPTES ===' -ForegroundColor Cyan

$client = NewUser 'client' 'client' '0750'
$other = NewUser 'other' 'client' '0751'
$owner = NewUser 'owner' 'owner' '0752'
$admin = NewUser 'admin' 'client' '0753' -promoteAdmin
# Second fournisseur, cree ICI et non dans la section 13 : la section 12 a
# besoin de SON vehicule pour tester la tentative de reservation par un
# administrateur. Un compte cree plus bas serait inconnu a ce stade.
$owner2 = NewUser 'owner2' 'owner' '0755'

Check 'comptes crees et connectes' ($client.Token -and $other.Token -and $owner.Token -and $admin.Token -and $owner2.Token)

Write-Host ''
Write-Host '=== 2. VEHICULE PUBLIÉ PAR LE FOURNISSEUR ===' -ForegroundColor Cyan

Sql "INSERT INTO vehicle_category (slug,label,sort_order) VALUES ('pickup','Pick-up',90) ON CONFLICT DO NOTHING;" | Out-Null
$cat = Sql "SELECT id FROM vehicle_category WHERE slug='pickup';"
Check 'categorie de vehicule disponible' ([bool]$cat) "(recu : '$cat')"

$vh = @{
  categoryId = $cat; brand = 'Toyota'; model = 'Hilux'; year = 2022
  plateNumber = "AB$suffix"; transmission = 'manual'; fuel = 'diesel'
  seats = 5; dailyRate = 60000; depositAmount = 500000; withDriver = $false
}

$r = Call 'POST' '/vehicles' $vh (Auth $owner)
if ($r.Status -ne 201) { Write-Host "  creation vehicule impossible : $($r.Body)" -ForegroundColor Red; exit 1 }
$vehicle = ConvertFrom-Json $r.Body
Check 'vehicule cree par le fournisseur' ($r.Status -eq 201) "($($r.Status))"

# Publication directe en base : ce test porte sur la reservation, pas sur
# la revue. Publier par SQL evite d'enchainer le parcours de validation,
# qui est deja couvert par admin-flow.ps1.
Sql ("UPDATE vehicle SET status = 'published' WHERE id = '$($vehicle.id)';") | Out-Null
Check 'vehicule publie' ((Sql ("SELECT status FROM vehicle WHERE id = '$($vehicle.id)';")) -eq 'published')

Write-Host ''
Write-Host '=== 3. CREATION DE LA RESERVATION ===' -ForegroundColor Cyan

$d1 = Dates 0
$r = Call 'POST' '/bookings' @{ vehicleId = $vehicle.id; startAt = $d1.startAt; endAt = $d1.endAt; isOneWay = $false } (Auth $client)
if ($r.Status -ne 201) { Write-Host "  reservation impossible : $($r.Body)" -ForegroundColor Red; exit 1 }

$booking = ConvertFrom-Json $r.Body
Check 'reservation creee en awaiting_payment' ($r.Status -eq 201 -and $booking.status -eq 'awaiting_payment') "($($r.Status) $($booking.status))"

# 3 nuits x 60 000 + caution 500 000
Check 'total = 3 nuits + caution (680 000)' ($booking.total -eq '680000') "(recu : $($booking.total))"
Check 'deposit = caution (500 000)' ($booking.deposit -eq '500000') "(recu : $($booking.deposit))"
Check 'devis fige avec 3 jours factures' ($booking.pricingSnapshot.billedDays -eq 3) "(recu : $($booking.pricingSnapshot.billedDays))"
Check 'taux de commission fige a la creation' ($booking.pricingSnapshot.commissionRate -ne $null) "(recu : $($booking.pricingSnapshot.commissionRate))"
Check 'provenance du taux conservee' ($booking.pricingSnapshot.commissionSource -ne $null) "(recu : $($booking.pricingSnapshot.commissionSource))"
Check 'reference courte attribuee' ($booking.reference -match '^[A-Z0-9]{6,12}$') "(recu : $($booking.reference))"
Check 'transitions autorisees exposees' ($booking.allowedTransitions.Count -ge 1) "(recu : $($booking.allowedTransitions -join ', '))"

Write-Host ''
Write-Host '=== 4. CHEVAUCHEMENT : REFUSE PAR LA BASE ===' -ForegroundColor Cyan

$dOverlap = Dates 1
$r = Call 'POST' '/bookings' @{ vehicleId = $vehicle.id; startAt = $dOverlap.startAt; endAt = $dOverlap.endAt } (Auth $other)
$e = $r.Body | ConvertFrom-Json
Check 'chevauchement refuse en 409' ($r.Status -eq 409) "(recu : $($r.Status))"
Check 'code VEHICULE_DEJA_RESERVE' ($e.code -eq 'VEHICULE_DEJA_RESERVE') "(recu : $($e.code))"
Check 'le refus explique la cause en langage client' ($e.message -match 'reserve|dates') "(recu : $($e.message))"

# Bornes exclusives : une fin au meme instant qu'un debut est compatible.
$dEdge = Dates 3
$r = Call 'POST' '/bookings' @{ vehicleId = $vehicle.id; startAt = $d1.startAt; endAt = $d1.endAt; customerNotes = 'chevauchement frontalier' } (Auth $other)
Check 'bornes exclusives respectees (conflit frontalier detecte)' ($r.Status -eq 409) "(recu : $($r.Status))"

$edge = Call 'POST' '/bookings' @{ vehicleId = $vehicle.id; startAt = $d1.endAt; endAt = $dEdge.endAt } (Auth $other)
Check 'location demarrant a la fin d une autre acceptee' ($edge.Status -eq 201) "(recu : $($edge.Status) $($edge.Body)"

Write-Host ''
Write-Host '=== 5. DISPONIBILITE ===' -ForegroundColor Cyan

$dAvail = Dates 10
$r = Call 'GET' "/bookings/vehicle/$($vehicle.id)/availability?startAt=$($dAvail.startAt)&endAt=$($dAvail.endAt)" $null (Auth $client)
$a = $r.Body | ConvertFrom-Json
Check 'vehicule disponible sur une plage libre' ($r.Status -eq 200 -and $a.available -eq $true) "(recu : $($r.Status) $($r.Body))"

$q = [uri]::EscapeDataString($d1.startAt)
$f = [uri]::EscapeDataString($d1.endAt)
$r = Call 'GET' "/bookings/vehicle/$($vehicle.id)/availability?startAt=$q&endAt=$f" $null (Auth $client)
$a = $r.Body | ConvertFrom-Json
Check 'vehicule indisponible sur une plage reservee' ($a.available -eq $false -and $a.reason -eq 'booked') "(recu : $($r.Body))"

# Un blocage declare doit etre respecte meme sans reservation.
$dBlocked = Dates 20
Sql ("INSERT INTO availability (vehicle_id, start_at, end_at, type, reason) VALUES ('$($vehicle.id)', '$($dBlocked.startAt)', '$($dBlocked.endAt)', 'maintenance', 'Revision');") | Out-Null

$r = Call 'POST' '/bookings' @{ vehicleId = $vehicle.id; startAt = $dBlocked.startAt; endAt = $dBlocked.endAt } (Auth $client)
$e = $r.Body | ConvertFrom-Json
Check 'reservation refusee sur un vehicule en maintenance' ($r.Status -eq 409 -and $e.code -eq 'VEHICLE_IN_MAINTENANCE') "(recu : $($r.Status) $($e.code))"

$r = Call 'GET' "/bookings/vehicle/$($vehicle.id)/availability?startAt=$([uri]::EscapeDataString($dBlocked.startAt))&endAt=$([uri]::EscapeDataString($dBlocked.endAt))" $null (Auth $client)
$a = $r.Body | ConvertFrom-Json
Check 'maintenance signalee dans la disponibilite' ($a.reason -eq 'maintenance') "(recu : $($a.reason))"

Write-Host ''
Write-Host '=== 6. CONFIDENTIALITE ===' -ForegroundColor Cyan

$r = Call 'GET' "/bookings/$($booking.id)" $null (Auth $client)
Check 'le client voit sa reservation' ($r.Status -eq 200) "(recu : $($r.Status))"

$r = Call 'GET' "/bookings/$($booking.id)" $null (Auth $other)
# 404 et non 403 : un 403 confirmerait l existence de la reservation.
Check 'un tiers ne voit pas la reservation (404, pas 403)' ($r.Status -eq 404) "(recu : $($r.Status))"

$r = Call 'GET' "/bookings/$($booking.id)" $null (Auth $owner)
Check 'le fournisseur voit la reservation de son parc' ($r.Status -eq 200) "(recu : $($r.Status))"

$r = Call 'GET' "/bookings/$($booking.id)" $null (Auth $admin)
Check 'un administrateur voit la reservation' ($r.Status -eq 200) "(recu : $($r.Status))"

$r = Call 'GET' '/bookings' $null (Auth $client)
$list = $r.Body | ConvertFrom-Json
Check 'liste limitee aux reservations de l acteur' ($list.items.Count -eq 1 -and $list.items[0].id -eq $booking.id) "(recu : $($list.items.Count) element(s))"

$r = Call 'GET' '/bookings' $null (Auth $admin)
$list = $r.Body | ConvertFrom-Json
Check 'liste admin plus large' ($list.items.Count -ge 2) "(recu : $($list.items.Count) element(s))"

Write-Host ''
Write-Host '=== 7. TRANSITIONS NON AUTORISEES ===' -ForegroundColor Cyan

$r = Call 'POST' "/bookings/$($booking.id)/transitions" @{ to = 'completed'; expectedVersion = $booking.version } (Auth $client)
$e = $r.Body | ConvertFrom-Json
Check 'awaiting_payment -> completed refuse' ($r.Status -eq 409) "(recu : $($r.Status))"
Check 'code TRANSITION_NON_AUTORISEE' ($e.code -eq 'TRANSITION_NON_AUTORISEE') "(recu : $($e.code))"
Check 'les transitions possibles sont listees' ($e.details.allowed.Count -ge 1) "(recu : $($e.details.allowed -join ', '))"

# Un client ne doit pas pouvoir s'attribuer une resolution de litige.
$r = Call 'POST' "/bookings/$($booking.id)/transitions" @{ to = 'resolved_client'; expectedVersion = $booking.version } (Auth $client)
Check 'resolution de litige refusee au client' ($r.Status -eq 409) "(recu : $($r.Status))"

Write-Host ''
Write-Host '=== 8. TRANSITION AUTORISEE ET AUDIT ===' -ForegroundColor Cyan

$r = Call 'POST' "/bookings/$($booking.id)/transitions" @{ to = 'paid'; expectedVersion = $booking.version; reason = 'Paiement recu' } (Auth $client)
Check 'awaiting_payment -> paid accepte' ($r.Status -eq 200 -and (ConvertFrom-Json $r.Body).status -eq 'paid') "(recu : $($r.Status))"
$b2 = ConvertFrom-Json $r.Body
Check 'version incrementee' ($b2.version -eq ($booking.version + 1)) "(recu : $($b2.version))"
Check 'horodatage de confirmation pose' ($b2.confirmedAt -ne $null)

Write-Host ''
Write-Host '=== 9. VERROU OPTIMISTE ===' -ForegroundColor Cyan

# La version lue AVANT la transition precedente est obsolete : la
# transition doit etre refusee meme si l'etat cible est valide.
$r = Call 'POST' "/bookings/$($booking.id)/transitions" @{ to = 'in_progress'; expectedVersion = $booking.version } (Auth $owner)
$e = $r.Body | ConvertFrom-Json
Check 'version obsolete refusee' ($r.Status -eq 409) "(recu : $($r.Status))"
Check 'code VERSION_CONFLIT' ($e.code -eq 'VERSION_CONFLIT') "(recu : $($e.code))"
Check 'la version courante est communiquee' ($e.details.currentVersion -ne $null) "(recu : $($e.details.currentVersion))"

# Deux agents lisent la MEME version valide et demandent deux
# transitions differentes : une seule doit aboutir.
$stale = $b2.version
$a1 = Call 'POST' "/bookings/$($booking.id)/transitions" @{ to = 'in_progress'; expectedVersion = $stale } (Auth $owner)
$a2 = Call 'POST' "/bookings/$($booking.id)/cancel" @{ by = 'client'; reason = 'Changement de programme'; expectedVersion = $stale } (Auth $client)

Write-Host ("  diagnostic : transition=[{0}] annulation=[{1}] version lue={2}" -f $a1.Status, $a2.Status, $stale)

# ⚠️ Le `@(...)` autour du pipeline n'est pas cosmetique.
# `Where-Object` qui ne renvoie QU'UN element ne produit pas un tableau
# mais l'element lui-meme. Or `.Count` sur un `Hashtable` renvoie le
# NOMBRE DE CLES — ici 2 (`Status` et `Body`). Sans l'enveloppe, un
# resultat correct de « 1 succes, 1 refus » s'afficherait « 2 et 2 », et
# le test echouerait en annonçant une course qui n'existe pas.
$success = @(@($a1, $a2) | Where-Object { $_.Status -eq 200 })
$refused = @(@($a1, $a2) | Where-Object { $_.Status -eq 409 })
Check 'une seule des deux transitions concurrentes aboutit' ($success.Count -eq 1 -and $refused.Count -eq 1) `
  "(succes : $($success.Count), refus : $($refused.Count))"

Write-Host ''
Write-Host '=== 10. AUDIT COMPLET ===' -ForegroundColor Cyan

$r = Call 'GET' "/bookings/$($booking.id)" $null (Auth $admin)
$b = ConvertFrom-Json $r.Body
Check 'historique present' ($b.history.Count -ge 2) "(recu : $($b.history.Count) entree(s))"
Check 'la creation est tracee avec un etat source nul' ($b.history[($b.history.Count - 1)].fromStatus -eq $null) "(recu : $($b.history[-1].fromStatus))"
$hasPaid = @($b.history | Where-Object { $_.toStatus -eq 'paid' }).Count
Check 'chaque transition a laisse une trace' ($hasPaid -ge 1) "(trace de 'paid' : $hasPaid)"

$states = @($b.history | ForEach-Object { $_.toStatus })
Check 'aucune transition concurrente fantome tracee' ($states.Count -eq (@($states | Select-Object -Unique)).Count) `
  "(etats : $($states -join ', '))"

Write-Host ''
Write-Host '=== 10. ANNULATION IMPOSSIBLE UNE FOIS LA LOCATION EN COURS ===' -ForegroundColor Cyan

# Apres la course ci-dessus, la reservation est FORCEMENT soit
# `in_progress`, soit `cancelled_client` : les deux issues sont
# legitimes. Dans les deux cas l'annulation ulterieure est impossible,
# ce qui est la regle : on ne resilie pas une location deja commencee.
$b = ConvertFrom-Json (Call 'GET' "/bookings/$($booking.id)" $null (Auth $client)).Body
Check 'etat final coherent avec la course' ($b.status -in @('in_progress', 'cancelled_client')) "(recu : $($b.status))"

$r = Call 'POST' "/bookings/$($booking.id)/cancel" @{ by = 'client'; reason = 'Annulation tardive'; expectedVersion = $b.version } (Auth $client)
$e = $r.Body | ConvertFrom-Json
Check 'annulation refusee apres le debut de la location' ($r.Status -eq 409 -and $e.code -eq 'TRANSITION_NON_AUTORISEE') "(recu : $($r.Status) $($e.code))"

Write-Host ''
Write-Host '=== 11. ANNULATION ET ROLE (RESERVATION DEDIEE) ===' -ForegroundColor Cyan

# Une reservation FAITE POUR CE TEST, payee puis annulee. Reutiliser
# celle du dessus rendrait le resultat dependent de l'issue de la
# course — un test qui passe ou echoue selon le hasard n'eprouve rien.
$dCancel = Dates 15
$r = Call 'POST' '/bookings' @{ vehicleId = $vehicle.id; startAt = $dCancel.startAt; endAt = $dCancel.endAt } (Auth $client)
$toCancel = ConvertFrom-Json $r.Body
Check 'reservation de test creee' ($r.Status -eq 201) "(recu : $($r.Status))"

$r = Call 'POST' "/bookings/$($toCancel.id)/transitions" @{ to = 'paid'; expectedVersion = $toCancel.version } (Auth $client)
$paid = ConvertFrom-Json $r.Body
Check 'reservation payee' ($r.Status -eq 200 -and $paid.status -eq 'paid') "(recu : $($r.Status))"

# Un fournisseur ne peut pas faire passer son annulation pour celle du
# client : cela changerait le sort de la commission et de la sanction.
$r = Call 'POST' "/bookings/$($toCancel.id)/cancel" @{ by = 'client'; reason = 'Fausse declaration'; expectedVersion = $paid.version } (Auth $owner)
$e = $r.Body | ConvertFrom-Json
Check 'le fournisseur ne peut pas annuler au nom du client' ($r.Status -eq 403 -and $e.code -eq 'ACTOR_MISMATCH') "(recu : $($r.Status) $($e.code))"

$r = Call 'POST' "/bookings/$($toCancel.id)/cancel" @{ by = 'client'; reason = 'Empechement professionnel'; expectedVersion = $paid.version } (Auth $client)
Check 'annulation par le client acceptee' ($r.Status -eq 200 -and (ConvertFrom-Json $r.Body).status -eq 'cancelled_client') "(recu : $($r.Status))"
$b3 = ConvertFrom-Json $r.Body
Check 'motif d annulation conserve' ($b3.cancelReason -eq 'Empechement professionnel') "(recu : $($b3.cancelReason))"
Check 'horodatage d annulation pose' ($b3.cancelledAt -ne $null)

# L'etat est terminal : plus aucune sortie possible.
$r = Call 'POST' "/bookings/$($toCancel.id)/transitions" @{ to = 'paid'; expectedVersion = $b3.version } (Auth $owner)
Check 'etat terminal : aucune transition possible' ($r.Status -eq 409) "(recu : $($r.Status))"

# Le vehicule doit etre immediatement relibre.
$dFree = Dates 30
$r = Call 'POST' '/bookings' @{ vehicleId = $vehicle.id; startAt = $dFree.startAt; endAt = $dFree.endAt } (Auth $other)
Check 'vehicule libere apres annulation' ($r.Status -eq 201) "(recu : $($r.Status))"

Write-Host ''
Write-Host '=== 12. REGLES DE SAISIE ===' -ForegroundColor Cyan

$dBad = Dates 40
$r = Call 'POST' '/bookings' @{ vehicleId = $vehicle.id; startAt = $dBad.endAt; endAt = $dBad.startAt } (Auth $client)
Check 'fin anterieure au debut refusee' ($r.Status -eq 400 -or $r.Status -eq 422) "(recu : $($r.Status))"

$r = Call 'POST' '/bookings' @{ vehicleId = $vehicle.id; startAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); endAt = (Get-Date).AddDays(400).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') } (Auth $client)
$e = $r.Body | ConvertFrom-Json
Check 'duree aberrante refusee' ($r.Status -eq 422 -and $e.code -eq 'DUREE_IMPLAUSIBLE') "(recu : $($r.Status) $($e.code))"

# Le vehicule appartient a un FOURNISSEUR, pas a l'administrateur : la
# regle `ADMIN_CANNOT_PUBLISH` interdit a un administrateur de detenir un
# vehicule, et c'est la bonne regle. L'administrateur va simplement
# tenter de reserver celui d'un autre.
$vhAdmin = $vh.Clone()
$vhAdmin['plateNumber'] = "AE$suffix"
$r = Call 'POST' '/vehicles' $vhAdmin (Auth $owner2)
$adminVeh = ConvertFrom-Json $r.Body
if ($r.Status -ne 201) { Write-Host "  creation vehicule impossible : $($r.Body)" -ForegroundColor Red }
Sql ("UPDATE vehicle SET status = 'published' WHERE id = '$($adminVeh.id)';") | Out-Null
$dAdm = Dates 50
$r = Call 'POST' '/bookings' @{ vehicleId = $adminVeh.id; startAt = $dAdm.startAt; endAt = $dAdm.endAt } (Auth $admin)
$e = $r.Body | ConvertFrom-Json
Check 'un administrateur ne reserve pas pour lui' ($r.Status -eq 403 -and $e.code -eq 'ADMIN_CANNOT_BOOK') "(recu : $($r.Status) $($e.code))"

Write-Host ''
Write-Host '=== 13. VEHICULE NON PUBLIE ===' -ForegroundColor Cyan

$cat2 = Sql "SELECT id FROM vehicle_category WHERE slug='suv';"
if (-not $cat2) {
  Sql "INSERT INTO vehicle_category (slug,label,sort_order) VALUES ('suv','SUV',1) ON CONFLICT DO NOTHING;" | Out-Null
  $cat2 = Sql "SELECT id FROM vehicle_category WHERE slug='suv';"
}
$vh2 = @{
  categoryId = $cat2; brand = 'Renault'; model = 'Duster'; year = 2021
  plateNumber = "CD$suffix"; transmission = 'manual'; fuel = 'petrol'
  seats = 5; dailyRate = 45000; depositAmount = 300000; withDriver = $false
}
$r = Call 'POST' '/vehicles' $vh2 (Auth $owner2)
$draft = ConvertFrom-Json $r.Body
$dDraft = Dates 60
$r = Call 'POST' '/bookings' @{ vehicleId = $draft.id; startAt = $dDraft.startAt; endAt = $dDraft.endAt } (Auth $client)
$e = $r.Body | ConvertFrom-Json
Check 'reservation d un brouillon refusee' ($r.Status -eq 409 -and $e.code -eq 'VEHICLE_NOT_PUBLISHED') "(recu : $($r.Status) $($e.code))"

Write-Host ''
if ($script:fail -eq 0) {
  Write-Host "=== TOUS LES TESTS DE RESERVATION SONT PASSES ($($script:pass)) ===" -ForegroundColor Green
  exit 0
} else {
  Write-Host "=== $($script:fail) ECHEC(S) SUR $($script:pass + $script:fail) ===" -ForegroundColor Red
  exit 1
}
