# ADR-003 — Hébergement : Vercel pour l'API, Supabase pour PostgreSQL

- **Statut** : accepté
- **Date** : 2026-10-03
- **Décisions concernées** : A-17 (temps réel), A-18 (hébergement) — CDCS §10.2
- **Porte la contradiction avec** : CDCS §10.2 (Socket.IO) et la recommandation antérieure d'un hôte à processus persistant pour l'API

## Contexte

Le CDC v2.0 prévoyait Socket.IO pour le temps réel et laissait
l'hébergement ouvert. La question posée était : *« comment on règle le
problème avec Vercel et Supabase »*.

Deux questions distinctes se mélangeaient. Les traiter séparément est
nécessaire, parce qu'elles n'ont ni les mêmes contraintes ni les mêmes
arbitrages :

1. **L'API peut-elle tourner sur Vercel ?**
2. **Que faut-il changer dans le code pour que ce soit correct ?**

## État des lieux vérifié

Les limites ne sont pas celles qu'on suppose :

| Sujet | Réalité vérifiée |
|---|---|
| WebSocket sur Vercel | Supportés **depuis juin 2026** (bêta publique), mais **plafond de 5 minutes** et **instance unique épinglée** à la connexion |
| Supabase, connexions | Quota compté **par base** (60 en plan Micro), pas par application |
| Pooler mode transaction (6543) | Une transaction par connexion physique ; ni `SET` persistant, ni `LISTEN`, ni prepared statements nommés |

## Décision

1. **L'API et le web sont hébergés sur Vercel.**
2. **PostgreSQL est hébergé par Supabase**, en pooler mode transaction
   pour l'application, en connexion directe pour les migrations.
3. **Supabase n'est utilisé que pour la base de données.** Ni
   `Supabase Auth`, ni accès direct depuis le navigateur.
4. **Socket.IO est abandonné au profit de SSE** (A-17).

## Pourquoi

### Pourquoi abandonner Socket.IO plutôt que de le garder

Le plafond de 5 minutes et l'épinglage à une instance ne sont pas des
limites de performance, ce sont des limites de **correction**. Socket.IO
suppose que le client et le serveur qui tient son état sont joignables
par le même chemin. Sans adaptateur partagé, la connexion d'un client peut
atterrir sur une instance qui n'a jamais vu son état.

Adapter Socket.IO à ce modèle demanderait un état externe (Redis ou
table), donc de reconstruire ce que SSE donne nativement et sans état.

### Pourquoi SSE suffit

Tous les cas d'usage sont unidirectionnels : statut de réservation,
message reçu, résultat de paiement. Le client écrit déjà par HTTP.

SSE est en outre **plus robuste sur le réseau instable** qui est le cas
dominant à Abidjan : la reconnexion est native du navigateur, alors
qu'un client Socket.IO doit la reconstruire lui-même.

### Pourquoi ne pas adopter Supabase Auth

L'authentification OTP téléphone, la rotation de jetons avec détection
de réutilisation, et 22 tests de parcours sont **déjà écrits et
validés**. Supabase Auth remplacerait du code qui fonctionne pour un
gain de fonctionnalité nul sur notre cas d'usage.

Le second argument est architectural : autoriser le navigateur à
interroger Supabase directement déplace la frontière de sécurité de
l'API vers les RLS. C'est un changement d'architecture majeur, pas un
réglage. Le CDCS §12.3 veut une API unique comme porte d'entrée ;
c'est aussi ce qui permet de journaliser, de tracer et de facturer.

## Conséquences

### Le risque que cette décision introduit, et qui est traité

**Le limiteur de débit était en mémoire.** Le stockage par défaut de
`@nestjs/throttler` est une `Map` du processus. Sur Vercel, le compteur
repart de zéro à chaque invocation : la limite annoncée à « 5/min »
devient infinie et **le code OTP à six chiffres devient forçable**.

C'est le genre de panne qu'aucun test ne détecte et qu'aucune alerte ne
signale — la protection est simplement absente.

Trois mesures, pas une :

1. stockage Redis REST (Upstash) dont le comptage et le blocage sont
   évalués dans un **script Lua atomique** ;
2. **refus de démarrer** en production si Redis n'est pas configuré ;
3. 13 tests unitaires sur le stockage, dont un qui vérifie le passage
   en **un seul aller-retour**.

> Ces tests ont immediately payback : ils ont révélé que le protocole
> EVAL recevait la *longueur* de la clé là où il attend le *nombre* de
> clés. `KEYS[1]` aurait désigné la mauvaise clé, et le blocage aurait
> porté sur une clé arbitraire. L'erreur ne se serait vue qu'en
> production, sur la première saturation.

### Les autres conséquences

| Conséquence | Traitement |
|---|---|
| **Pool de connexions** | Réduit à **1** en hébergement éphémère. Le quota est par base : 5 instances × 10 connexions saturent le plan Micro alors que la charge reste faible |
| **Prepared statements** | `node-postgres` n'en crée pas par défaut ; un avertissement au démarrage surveille le risque |
| **Workers** | Relances, rappels, réconciliation **hors Vercel** : une fonction ne vit que le temps d'une requête |
| **Fichiers** | Le disque d'une fonction est éphémère → **stockage objet obligatoire** (S3/R2) |
| **Duplication de configuration** | `main.ts` et le gestionnaire Vercel passent par **`configureApp()`** unique. Deux copies divergeraient silencieusement, et le symptôme n'apparaîtrait que sur un des deux environnements |

### Ce que cette décision ne règle pas

- Le **déploiement des workers** n'est pas tranché.
- Le **contrôle de la localisation des données** (§3.4) reste à faire :
  Supabase propose plusieurs régions, le choix doit être explicite.
- Le **reste du runtime** doit être revu pour les mêmes raisons que le
  limiteur : tout état en mémoire entre deux requêtes est à traquer.

## Vérification du raisonnement

Le test qui invaliderait cette décision : *une contrainte de
l'hébergement découverte plus tard impose-t-elle de revenir à un hôte à
processus persistant ?*

Réponse honnête : **oui, pour les workers**. Si le volume de rappels et
de réconciliation le justifie, un hôte à processus persistant sera
nécessaire. Il est plus simple de l'ajouter **à côté** de Vercel que de
tout y faire migrer après coup. Ce choix ne ferme donc pas la porte,
il la laisse ouverte, et il ne coûte rien de la garder ouverte.
