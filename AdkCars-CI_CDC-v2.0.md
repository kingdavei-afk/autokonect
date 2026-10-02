# CAHIER DES CHARGES — AdkCars CI (AutoKonnect CI)

## Plateforme SaaS de location de véhicules — Côte d'Ivoire

| | |
|---|---|
| **Version** | 2.0 (réécriture structurante du CDC v1.0) |
| **Statut** | Projet de CDC — à valider par le commanditaire |
| **Date** | 02/10/2026 |
| **Rédaction** | Équipe projet |
| **Document source** | `AutoKonnect CI.docx` (v1.0, 30 sections, 14 pages) |
| **Cycle** | phases P0 → P4, horizon 24 mois |

> **Avertissement de lecture.** Ce document propose une restructuration complète du CDC v1. Il **corrige, découpe et priorise** le périmètre initial, et **ajoute les chapitres qui manquaient** (cadre légal, modèle économique, règles métier, modèle de données, NFR chiffrées, plan de livraison). Les points non tranchés sont signalés par la mention **`[TBD]`** et regroupés au chapitre 19. Les affirmations juridiques et tarifaires sont marquées **`[À CONFIRMER]`** : elles doivent être validées par un conseil local avant tout engagement contractuel.

---

## Sommaire

1. [Comment lire ce document](#0-comment-lire-ce-document)
2. [Synthèse de cadrage](#1-synthèse-de-cadrage)
3. [Contexte, objectifs et vision](#2-contexte-objectifs-et-vision)
4. [Cadre légal et conformité](#3-cadre-légal-et-conformité)
5. [Modèle économique et cadre financier](#4-modèle-économique-et-cadre-financier)
6. [Parties prenantes et personas](#5-parties-prenantes-et-personas)
7. [Périmètre fonctionnel et priorités](#6-périmètre-fonctionnel-et-priorités)
8. [Spécifications fonctionnelles détaillées](#7-spécifications-fonctionnelles-détaillées)
9. [Règles métier et machines à états](#8-règles-métier-et-machines-à-états)
10. [Modèle de données](#9-modèle-de-données)
11. [Architecture technique](#10-architecture-technique)
12. [Exigences non fonctionnelles](#11-exigences-non-fonctionnelles)
13. [Sécurité et conformité](#12-sécurité-et-conformité)
14. [UX, UI et localisation](#13-ux-ui-et-localisation)
15. [Intégrations tierces](#14-intégrations-tierces)
16. [Plan de livraison, jalons et équipe](#15-plan-de-livraison-jalons-et-équipe)
17. [Stratégie de tests et recette](#16-stratégie-de-tests-et-recette)
18. [Livrables attendus](#17-livrables-attendus)
19. [Hypothèses, dépendances et risques](#18-hypothèses-dépendances-et-risques)
20. [Décisions à trancher](#19-décisions-à-trancher)
21. [Traçabilité vis-à-vis du CDC v1](#20-traçabilité-vis-à-vis-du-cdc-v1)
22. [Glossaire](#21-glossaire)

---

## 0. Comment lire ce document

### 0.1 Convention de priorité

Chaque exigence fonctionnelle porte une priorité. C'est l'ajout le plus important de la v2 : le CDC v1 ne distinguait rien, ce qui rendait le périmètre indistinct et non chiffrable.

| Code | Signification | Traitement contractuel |
|---|---|---|
| **MUST** | Indispensable au fonctionnement du produit | Engagement de livraison |
| **SHOULD** | Important, réalisable sans dégrader le cœur | Engagement, planifiable |
| **COULD** | Apport de valeur, non bloquant | Option, chiffrable en avenant |
| **WON'T (v2)** | Reporté hors version 2 | Hors périmètre |

### 0.2 Marqueurs

| Marqueur | Signification |
|---|---|
| `[TBD]` | Décision non prise : voir chapitre 19 |
| `[À CONFIRMER]` | À valider par un tiers compétent (juriste, PSP, opérateur) |
| `[PLACEHOLDER]` | Valeur indicative à remplacer avant chiffrage |

### 0.3 Gouvernance du document

- **Toute demande de modification** est enregistrée dans un registre de changements (version, date, auteur, motif).
- **Les arbitrages du chapitre 19** doivent être clos **avant** la signature du contrat de développement : ils conditionnent le chiffrage.
- Les versions P0 à P4 sont **des contrats séparables**. Un avenant additionne une phase ; il ne réouvre pas une phase livrée.

---

## 1. Synthèse de cadrage

### 1.1 Diagnostic du CDC v1

Le CDC v1 est une **liste de fonctionnalités cohérente et ambitieuse**, mais il présente trois défauts qui le rendent inutilisable comme base contractuelle :

| Défaut | Conséquence |
|---|---|
| **Aucune priorité** — les 30 sections sont au même niveau, toutes en « doit » | Périmètre indistinct, chiffrage non fiable, litige garanti à la livraison |
| **Aucun cadre métier ni financier** — ni commission, ni devise, ni TVA, ni règles de caution, ni politique d'annulation | Le produit ne peut pas être payment-ready : pas de flux financier concevable |
| **Aucun cadre juridique ivoirien** — seul le RGPD (européen) est cité | Non-conformité : le régime applicable est la loi ivoirienne sur les données |

S'y ajoutent des lacunes de spécification (pas de modèle de données, pas de règles métier, pas de NFR chiffrées, pas de jalons) et des choix techniques sous-estimés (voir chapitre 14).

### 1.2 Décision structurante : le périmètre v1 est reduit

Le CDC v1 décrit, en 30 sections, un produit **estimé à 18–24 mois** de développement. Il est présenté comme une « version 1.0 ». Ce décalage est la principale source de risque du projet.

**Décision proposée :** le produit est livré en **4 jalons fonctionnels** (P1 à P3), le périmètre P4 étant traité comme une extension. Le MVP (P1) devient un produit réellement commercialisable en Côte d'Ivoire, livrable en **6 à 8 mois**.

### 1.3 Périmètre en un coup d'œil

| | Phase | Durée | Objet |
|---|---|---|---|
| **P0** | Socle | M1–M3 | Infrastructure, données, authentification, CI/CD |
| **P1** | MVP commercial | M4–M8 | Réserver, payer, unpublished côté client |
| **P2** | v1 complète | M9–M13 | Monetisation agence, caution, contrat, app Android |
| **P3** | Écosystème | M14–M17 | iOS, temps réel, chauffeur, géolocalisation avancée |
| **P4** | Intelligence & expansion | M18–M24 | IA, multi-pays, location longue durée |

### 1.4 Les 5 décisions qui débloquent le projet

Elles sont détaillées au chapitre 19 et **doivent être tranchées avant le chiffrage** :

1. **Entité marchande et flux de la caution** — qui encaisse, qui restitue, sous quel délai ?
2. **Prestataire de paiement de référence** — quel PSP, et quel statut réel des API Mobile Money ?
3. **iOS en version 1 ou reporté ?** — poste de coût majeur à faible retour sur le marché ivoirien.
4. **Langues officielles de la version 1** — FR seul, ou FR + EN dès le premier jour ?
5. **Budget cible et source de financement** — conditionne la largeur du périmètre.

---

## 2. Contexte, objectifs et vision

### 2.1 Nom et marque

| Élément | Valeur |
|---|---|
| Nom de travail | **AdkCars CI** |
| Nom commercial pressenti | **AutoKonnect** |
| Décision requise | **Arbitrage 06** — un seul nom, cohérent sur les trois plateformes et les Stores |

> ⚠️ Le CDC v1 utilise « AdkCars CI » comme nom provisoire et le dossier est intitulé « AutoKonnect CI ». Deux marques pour un produit sur des stores d'applications coûtent enastore, en SEO et en communication. À trancher avant le développement.

### 2.2 Problème adresse

Sur le marché ivoirien, la location de véhicules est :
- **fragmentée** : loueurs de quartier, agences, propriétaires individuels sans canal digital ;
- **informelle** : disponibilité non fiable, pas d'historique, pas de preuve ;
- **difficile à payer en confiance** : transactions en espèces, aucune traçabilité, pas de recours en cas de litige ;
- **mal outillée côté chauffeurs** : missions gérées par téléphone, aucun planning.

### 2.3 Objectifs du projet

| # | Objectif | Indicateur | Cible `[PLACEHOLDER]` |
|---|---|---|---|
| OG1 | Digitaliser l'offre de location ivoirienne | Véhicules publiés sur la plateforme | 500 à 12 mois |
| OG2 | Fiabiliser la réservation et le paiement | Taux de réservation aboutie | > 70 % des panierstad-initiés |
| OG3 | Donner aux agences un outil de gestion | Agences actives (au moins 1 réservation/mois) | 30 à 12 mois |
| OG4 | Rendre les propriétaires indépendants autonomes | Part du CA issue des propriétaires individuels | > 15 % |
| OG5 | Bâtir une plateforme multi-pays sans refonte | Coût d'ajout d'un pays | < 30 j. de développement |

### 2.4 Vision

Devenir la référence de la location de véhicules en Côte d'Ivoire, puis en Afrique de l'Ouest, en combinant la largeur d'une marketplace internationale (marketplace, notation, paiement fractionné) et les Codes du marché local : Mobile Money, WhatsApp, recherche par commune et quartier, paiement de proximité, ouverture de l'offre aux particuliers.

Positionnement : **plus ouvert que Turo/Getaround** (modèle loueur, sans contact préalable), **plus local que Rentalcars** (moyens de paiement et canaux adapted à l'Afrique de l'Ouest).

### 2.5 Marché cible

| Phase | Zone |
|---|---|
| Phase 1 | Côte d'Ivoire — Abidjan en priorité, puis Yamoussoukro, Bouaké, San-Pédro |
| Phase 2 | Afrique de l'Ouest — Sénégal, Mali, Burkina Faso, Bénin, Togo |

`[TBD]` Ordre d'entrée des pays de phase 2 : arbitrage 07.

### 2.6 Hors périmètre explicite

Ne sont **pas** livrés dans la version 2 :

| Exclu | Motif |
|---|---|
| Location de bateaux, d'engins de chantier, de camions | Nécessitent des modèles métier spécifiques (horaire, opérateur, garanties) — à réserver pour P4 |
| Leasing et location longue durée | Modèle financier et juridique distinct (crédit-bail) |
| Assurance intégrée (revente d'assurances) | Partenariat assureur à monter — hors périmètre d'un projet de développement |
| Marketplace de chauffeurs indépendante | Requiert la stabilisation du module chauffeur (P3) |
| Programme de fidélité et parrainage | Marketing, non produit — P4 |
| Production native sans navigateur | Décision d'architecture, non périmètre |

---

## 3. Cadre légal et conformité

> ⚠️ **Chapitre entièrement nouveau.** Le CDC v1 ne mentionne aucun cadre réglementaire. Ce chapitre est une **base de travail** : chaque point marqué `[À CONFIRMER]` doit être validé par un conseil juridique ivoirien avant signature.

### 3.1 Réglementation de l'activité de location

| Point | Exigence | Statut |
|---|---|---|
| Agrément de loueur de véhicules | Obligation légale d'exploitation en CI | `[À CONFIRMER]` — nom exact du titre, autorité délivratrice, délai |
| Carte professionnelle | Conditionne la délivrance de l'agrément | `[À CONFIRMER]` |
| Assurance Responsabilité Civile Automobile (RCA) | Obligatoire pour tout véhicule circulant et pour tout loueur | `[À CONFIRMER]` — textes d'application, montants minimaux |
| Assurance de flotte du loueur | Contrat annuel couvrant les véhicules de la flotte | `[À CONFIRMER]` |
| Contrôle technique | Périodicité et organisme de contrôle | `[À CONFIRMER]` |
| Immatriculation et carte grise | Gérée par le propriétaire ou l'agence | Intégrer au parcours de publication |

**Exigence produit :** le back-office doit pouvoir **enregistrer et suivre** ces documents par véhicule avec date d'échéance et alerte d'expiration (MUST).

### 3.2 Protection des données personnelles

| Élément | Détail |
|---|---|
| Texte applicable | Loi n°2013-450 du 19 juin 2013 relative à la protection des données à caractère personnel, modifiée par la loi n°2020-997 du 15 décembre 2020 `[À CONFIRMER]` |
| Autorité de contrôle | **CNDP** — Commission Nationale de la Protection des Données `[À CONFIRMER]` |
| RGPD | **Non applicable** de plein droit : mention du CDC v1 à remplacer par le régime ivoirien. Le RGPD peut être retenu comme **référence de bonnes pratiques** voluntarily. |
| Base légale | Exécution du contrat (locataire), consentement (marketing, localisation), intérêt légitime (géolocalisation véhicule) |
| Droits des personnes | Droit d'accès, de rectification, d'effacement, d'opposition, portabilité `[À CONFIRMER]` — modalités et délais |
| Obligations du responsable | Registre des traitements, information des utilisateurs, sécurité, notification des violations dans un délai réglementaire `[À CONFIRMER]` |

**Exigences produit [MUST] :**
1. Consentement explicite et révocable pour le marketing et la géolocalisation.
2. Registre des traitements tenu et versionné.
3. Export et effacement du compte en libre-service (soft delete + purge).
4. Journal d'audit des accès aux données sensibles (voir §12.5).
5. Purge automatique des données de localisation brute après durée de conservation définie.

### 3.3 Obligations fiscales et comptables

| Point | Exigence | Statut |
|---|---|---|
| TVA | Taux applicable en CI | `[À CONFIRMER]` — 18 % usuel, à confirmer |
| Facturation | Facture normalisée exigible | `[À CONFIRMER]` — mentions obligatoires, structure |
| Numérotation | Séries et continuité des factures | À intégrer au module Facturation |
| Comptabilité | Tenue des encaissements de la marketplace, reversements agences | `[À CONFIRMER]` — obligations du responsable de la plateforme |

**Décision structurante [TBD — arbitrage 01] :** le modèle de flux financier (voir §4.2) détermine qui est le redevable de la TVA sur les commissions et qui facture le client final. **Cette décision doit être prise avant le développement du module Paiement.**

### 3.4 Obligations de la plateforme

| Point | Exigence | Statut |
|---|---|---|
| Responsabilité du contenu | Modération des annonces, des avis, des signalements | `[À CONFIRMER]` — seuils, procédures |
| Publicité | Emplacements réservés (section 4.1) | `[TBD]` — emplacements sponsorisés |
| Propriété intellectuelle | Licence du CDU livrée au commanditaire (voir §17) | À formaliser |
| Hébergement des données | Localisation des serveurs `[À CONFIRMER]` | À arbitrer (§15.2) |

### 3.5 Clauses contractuelles prestataire

À inscrire au marché :
- Sous-traitance des données encadrée (hébergeur, PSP, prestataires SMS/push).
- Clause de réversibilité : restitution et effacement des données en fin de contrat.
- Garantie de non-détournement des données et données de paiement.

---

## 4. Modèle économique et cadre financier

> ⚠️ **Chapitre entièrement nouveau.** Le CDC v1 ne contient **aucun** élément financier. Sans ce chapitre, le module Paiement ne peut pas être spécifié.

### 4.1 Sources de revenus

| Source | Description | Cible `[PLACEHOLDER]` |
|---|---|---|
| **Commission sur location** | Pourcentage prélevé sur chaque location conclue | `[TBD]` |
| **Commission sur caution** | Option — sur la caution versée | `[TBD]` |
| **Abonnement fournisseur** | Formule mensuelle pour agences (Starter / Business / Premium / Enterprise) | `[TBD]` |
| **Services additionnels** | Livraison, chauffeur, équipements enfant, assistant(e) de voyage | `[TBD]` |
| **Publicité** | Emplacements promotionnels, bannières, mise en avantpayante | `[TBD]` |
| **Commission chauffeur** | Option — si le module chauffeur devient un canal de mise en relation | `[TBD]` |

### 4.2 Flux financier — **section critique**

Trois modèles possibles, impacts très différents :

| Modèle | Description | Risques |
|---|---|---|
| **A — Plateforme mandataire** | La plateforme est loueur ; contrat avec le client ; sous-location à l'agence/propriétaire | Maximal : obligations assurances, TVA, restrictions sur la liquidité financière |
| **B — Plateforme intermédiaire** | Contrat direct client ↔ fournisseur ; la plateforme prélève une commission sur le paiement | **Retenu `[TBD]`** — plus léger juridiquement, mais nécessite un PSP acceptant les paiements entre tiers |
| **C — Modèle hybride** | Modèle B par défaut ; modèle A pour un stock de véhicules et des partenariats stratégiques | Recommandé pour P4 |

**Exigences produit communes aux trois modèles [MUST] :**
1. Séparation stricte des flux : prix du véhicule, caution, frais de service, pénalités.
2. Virement vers le fournisseur avec référence de location traçable.
3. Compte d'attente (escrow) de la caution, restitution ou capture conditionnée à un état de restitution documenté.
4. Relevé fournisseur mensuel : locations, montants, commissions, pénalités.
5. Rapprochement automatique des paiements Mobile Money et bancaires.

### 4.3 Devise et change

| Élément | Spécification |
|---|---|
| Devise principale | **XOF** (franc CFA) — devise non convertible, zone UEMOA `[À CONFIRMER]` |
| Multi-devises | Modèle de données dimensionné pour n'importe quelle devise dès P0, mais **une seule devise active par pays** |
| Taux de change | Aucun : facturation dans la devise du pays, pas de conversion à l'affichage |
| Arrondi | Arrondi à l'unité supérieure pour tout montant `[TBD]` |

> **Contrainte structurante [MUST]** : **tous les montants sont stockés en entier (bigint en centimes)**. Les décimaux flottants sont proscrits.

### 4.4 Grille tarifaire fournisseur

Formules du CDC v1, à compléter :

| Formule | Véhicules max | Collaborateurs | Statistiques | Commission | Prix `[PLACEHOLDER]` |
|---|---|---|---|---|---|
| **Starter** | 5 | 1 | Basiques | `[TBD]` | `[TBD]` |
| **Business** | 25 | 5 | Complètes | `[TBD]` | `[TBD]` |
| **Premium** | 100 | 20 | Complètes + export | `[TBD]` | `[TBD]` |
| **Enterprise** | Illimité | Illimité | Sur mesure | `[TBD]` | Sur devis |

**Exigences produit [MUST]** : les plafonds de chaque formule sont **appliqués côté serveur** (API), pas seulement dans l'interface ; toute limite atteinte bloque l'action concernée avec un message explicite d'upsell.

### 4.5 Structure tarifaire côté client

| Élément | Spécification |
|---|---|
| Tarif du véhicule | Tarif journalier publié + suppléments (conducteur additionnel, livraison) |
| Caution | Montant affiché avant paiement, restitué après restitution |
| Frais de service plateforme | Pourcentage ou montant fixe affiché avant paiement — obligatoire |
| Pénalités | Retard, dépassement de kilométrage, dommages, non-présentation |
| Paiement fractionné | Part d'acompte + solde ; échéancier pour les locations longues |

> **Règle d'acceptation [MUST] : le montant total est connu et affiché avant toute validation de paiement.** Aucun frais ne peut être ajouté après le paiement.

### 4.6 Politiques financières

| Politique | Contenu minimal |
|---|---|
| Annulation client | Délai gratuit, pénalité, remboursement partiel ou total — `[TBD]` |
| Non-présentation (no-show) | Cas le plus fréquent en CI : deposition forfeiture `[TBD]` |
| Annulation fournisseur | Pénalité appliquée au fournisseur ; impact sur la note |
| Restitution tardive | Tarif horaire de dépassement `[TBD]` |
| Dommages | Constat photo obligatoire via l'app ; chaîne de validation et de facturation `[TBD]` |
| Remboursement | Délai maximal de remboursement par canal `[TBD]` |
| Litige | Circuit de médiation, Qui détermine l'arbitrage, délais `[TBD]` |
| Perte de clé / de carte | `[TBD]` |

---

## 5. Parties prenantes et personas

### 5.1 Parties prenantes

| Partie prenante | Intérêt | Attentes |
|---|---|---|
| **Commanditaire** | Création d'une plateforme leader du marché ivoirien | Rentabilité, maîtrise des coûts, propriété du code |
| **Locataire (client)** | Trouver et réserver un véhicule | Fiabilité, prix clair, paiement de proximité |
| **Propriétaire indépendant** | Rentabiliser son véhicule | Revenus, contrôle des disponibilités,.Contracts |
| **Agence** | Professionnaliser sa gestion | Multi-véhicules, collaborateurs, statistiques |
| **Chauffeur** | Recevoir des missions | Planning, rémunération, contact client — `[TBD]` rémunération |
| **Administrateur plateforme** | Gérer l'écosystème | Modération, litiges, paramétrage, commission |
| **Prestataire technique** | Réaliser et livrer | Périmètre clair, chiffrage fiable, données de test |

### 5.2 Personas principaux

**P1 — Amadou, 34 ans, particulier, Abidjan**
> Loue une berline ou un SUV 2 à 4 fois par mois. Paie par Mobile Money. Décide en moins de 3 minutes sur téléphone. Sensible au prix et à la confirmation immédiate (SMS).

**P2 — Fatou, 28 ans, salariée,isha, Ilcoussin**
> Cherche un SUV avec chauffeur pour un week-end ou une berline automatique pour la semaine. Compare les avis. Ne veut pas appeler. Exige un prix final connu avant de payer.

**P3 — Koffi, 52 ans, propriétaire, 2 véhicules**
> Veut publier ses 2 véhicules, bloquer des dates, suivre ses revenus et ses versements. Sensible au délai de paiement.

**P4 — Mariam, 41 ans, gérante d'agence (12 véhicules, 4 collaborateurs)**
> Veut un tableau de bord unique : occupation, chiffre d'affaires, reservations à traiter, gestion des collaborateurs et des chauffeurs.

**P5 — Yao, 29 ans, chauffeur**
> Veut ses missions du jour, le trajet, le contact du client. Paie par semaine. Exige des horaires fiables.

**P6 — Admin (007), 35 ans,moderateur + support**
> Doit traiter les signalements, vérifier les documents, bloquer un compte, arbitrage les litiges, suivre les transactions.

### 5.3 Matrice des permissions

| Fonctionnalité | Client | Propriétaire | Agence | Chauffeur | Admin |
|---|---|---|---|---|---|
| Rechercher, consulter un véhicule | ✅ | ✅ | ✅ | ✅ | ✅ |
| Réserver, payer | ✅ | ✅ | ✅ | — | — |
| Publier / modifier un véhicule | — | Ses véhicules | Ses véhicules | — | Tous |
| Gérer les disponibilités | — | Ses véhicules | Ses véhicules | — | Tous |
| Gérer les collaborateurs | — | — | Son agence | — | Toutes |
| Suivre les revenus | — | Ses revenus | Son agence | Ses courses | Tous |
| Consulter les missions | — | — | Ses chauffeurs | Ses missions | Toutes |
| Modérer / arbitrer | — | — | — | — | ✅ |
| Configurer commission, plans, CMS | — | — | — | — | ✅ |

> **Règle [MUST]** : toute permission est vérifiée **côté API**. L'interface n'est jamais la frontière de sécurité.

---

## 6. Périmètre fonctionnel et priorités

Synthèse du périmètre, avec priorité et phase. Le détail des critères d'acceptation est au chapitre 7.

### 6.1 Comptes et authentification

| # | Fonctionnalité | Priorité | Phase |
|---|---|---|---|
| F-01 | Inscription par email + téléphone | MUST | P1 |
| F-02 | Vérification par code OTP (SMS) | MUST | P1 |
| F-03 | Connexion OAuth Google | MUST | P1 |
| F-04 | Connexion OAuth Apple | SHOULD | P3 |
| F-05 | Connexion Facebook | SHOULD | P3 |
| F-06 | Réinitialisation de mot de passe | MUST | P1 |
| F-07 | Double authentification (2FA) sur compte OTP | SHOULD | P2 |
| F-08 | Gestion des sessions multi-appareils | SHOULD | P2 |
| F-09 | Suppression de compte (auto-service) | MUST | P1 |

### 6.2 Catalogue et recherche

| # | Fonctionnalité | Priorité | Phase |
|---|---|---|---|
| F-10 | Fiche véhicule détaillée | MUST | P1 |
| F-11 | Galerie photos + vidéos | MUST | P1 |
| F-12 | Recherche par ville / commune / quartier | MUST | P1 |
| F-13 | Filtres (prix, catégorie, transmission, carburant, places, année) | MUST | P1 |
| F-14 | Filtre disponibilité par dates | MUST | P1 |
| F-15 | Filtre avec / sans chauffeur, climatisation, boîte auto | MUST | P1 |
| F-16 | Recherche géolocalisée + carte interactive | MUST | P1 |
| F-17 | Tri (prix, distance, note, pertinence) | MUST | P1 |
| F-18 | Recherche plein texte (modèle, marque) | SHOULD | P2 |
| F-19 | Recommandations « véhicules similaires » | SHOULD | P2 |
| F-20 | Recherche par coordonnées + distance | SHOULD | P3 |

### 6.3 Réservation et calendrier

| # | Fonctionnalité | Priorité | Phase |
|---|---|---|---|
| F-21 | Calendrier de disponibilité par véhicule | MUST | P1 |
| F-22 | Blocage manuel des dates par le propriétaire | MUST | P1 |
| F-23 | Blocage automatique après réservation confirmée | MUST | P1 |
| F-24 | Choix des dates, heures, lieux de prise en charge / restitution | MUST | P1 |
| F-25 | Devis détaillé (base, suppléments, caution, frais de service) | MUST | P1 |
| F-26 | Confirmation de réservation | MUST | P1 |
| F-27 | Annulation par le client | MUST | P1 |
| F-28 | Historique et suivi des réservations | MUST | P1 |
| F-29 | Lieu de restitution différent (aller simple) | SHOULD | P2 |
| F-30 | Prolongation de location | SHOULD | P3 |
| F-31 | Bon de réservation / QR code de prise en charge | SHOULD | P2 |

### 6.4 Paiement et caution

| # | Fonctionnalité | Priorité | Phase |
|---|---|---|---|
| F-32 | Paiement Mobile Money — **1 opérateur de référence** | MUST | P1 |
| F-33 | Paiement par carte bancaire (PSP local) | MUST | P2 |
| F-34 | Écran de confirmation et reçu | MUST | P1 |
| F-35 | Facture PDF automatique | MUST | P2 |
| F-36 | Dépôt et restitution de la caution | MUST | P2 |
| F-37 | Capture de caution pour dommages | MUST | P2 |
| F-38 | Intégration des 5 opérateurs Mobile Money | SHOULD | P2 |
| F-39 | Paiement fractionné (acompte + solde) | SHOULD | P2 |
| F-40 | Rejets et remboursements automatisés | MUST | P2 |
| F-41 | Relevé fournisseur et commission | MUST | P2 |

### 6.5 Contrat et documents

| # | Fonctionnalité | Priorité | Phase |
|---|---|---|---|
| F-42 | Génération automatique du contrat PDF | MUST | P2 |
| F-43 | Signature électronique du contrat | MUST | P2 |
| F-44 | Archivage des contrats signés | MUST | P2 |
| F-45 | Bloc de restitution avec photos et signature | MUST | P2 |
| F-46 | Constat de dommages avec photos | MUST | P2 |

### 6.6 Confiance et réputation

| # | Fonctionnalité | Priorité | Phase |
|---|---|---|---|
| F-47 | Notation ★ et avis Publishing | MUST | P2 |
| F-48 | Signalement d'un avis abusif | MUST | P2 |
| F-49 | Modération des avis par l'admin | MUST | P2 |
| F-50 | Réponse du propriétaire aux avis | SHOULD | P2 |
| F-51 | Vérification d'identité du propriétaire | SHOULD | P2 |
| F-52 | Vérification des documents de véhicule | MUST | P2 |
| F-53 | Label « véhicule vérifié » | SHOULD | P3 |
| F-54 | Réputation du chauffeur | SHOULD | P3 |

### 6.7 Communication

| # | Fonctionnalité | Priorité | Phase |
|---|---|---|---|
| F-55 | Notifications e-mail | MUST | P1 |
| F-56 | Notifications SMS | MUST | P1 |
| F-57 | Notifications push (FCM) | SHOULD | P3 |
| F-58 | Notifications WhatsApp | SHOULD | P3 |
| F-59 | Messagerie interne avec pièces jointes | MUST | P2 |
| F-60 | Photos dans la messagerie | MUST | P2 |
| F-61 | Alertes prix / disponibilité | COULD | P4 |
| F-62 | Préférences de notification par canal et par événement | SHOULD | P2 |

### 6.8 Géolocalisation

| # | Fonctionnalité | Priorité | Phase |
|---|---|---|---|
| F-63 | Carte Google Maps des véhicules | MUST | P1 |
| F-64 | Calcul d'itinéraire | SHOULD | P3 |
| F-65 | Distance et temps estimé | SHOULD | P3 |
| F-66 | Position du véhicule pendant la location | SHOULD | P3 |
| F-67 | Partage de position du chauffeur | SHOULD | P3 |
| F-68 | Regroupement des zones par ville / commune / quartier | MUST | P1 |

### 6.9 Espace chauffeur

| # | Fonctionnalité | Priorité | Phase |
|---|---|---|---|
| F-69 | Compte chauffeur lié à une agence | SHOULD | P3 |
| F-70 | Liste des missions du jour | SHOULD | P3 |
| F-71 | Planning hebdomadaire | SHOULD | P3 |
| F-72 | Détail de mission et itinéraire | SHOULD | P3 |
| F-73 | Statut de mission (acceptée, en cours, terminée) | SHOULD | P3 |
| F-74 | Historique des courses et des revenus | SHOULD | P3 |

### 6.10 Back-office

| # | Fonctionnalité | Priorité | Phase |
|---|---|---|---|
| F-75 | Tableau de bord administrateur (KPIs) | MUST | P2 |
| F-76 | Gestion des utilisateurs | MUST | P1 |
| F-77 | Modération des véhicules et des annonces | MUST | P1 |
| F-78 | Gestion des agences | MUST | P1 |
| F-79 | Gestion des commissions et plans | MUST | P2 |
| F-80 | Gestion des coupons et promotions | SHOULD | P3 |
| F-81 | Pages CMS | SHOULD | P2 |
| F-82 | FAQ | SHOULD | P2 |
| F-83 | Bannières et bandeaux d'accueil | SHOULD | P2 |
| F-84 | Paramètres de la plateforme | MUST | P2 |
| F-85 | Suivi des transactions et réconciliation | MUST | P2 |
| F-86 | Gestion des litiges | MUST | P2 |
| F-87 | Journal d'audit | MUST | P2 |
| F-88 | Gestion des catégories et équipements | MUST | P1 |
| F-89 | Export de données (CSV / XLSX) | SHOULD | P3 |

### 6.11 Mobile

| # | Fonctionnalité | Priorité | Phase |
|---|---|---|---|
| F-90 | Application Android (Flutter) | SHOULD | P2 |
| F-91 | Application iOS (Flutter) | SHOULD | P3 |
| F-92 | PWA installable et hors-ligne léger | MUST | P1 |
| F-93 | Profondeur notification → deep link | MUST | P3 |
| F-94 | Mode hors-ligne : brouillon de réservation | SHOULD | P3 |
| F-95 | Scan du QR de prise en charge | SHOULD | P3 |

### 6.12 Internationalisation

| # | Fonctionnalité | Priorité | Phase |
|---|---|---|---|
| F-96 | Architecture i18n (FR, EN) | MUST | P0 |
| F-97 | Interface française | MUST | P1 |
| F-98 | Interface anglaise | SHOULD | P3 |
| F-99 | Architecture multi-devises | MUST | P0 |
| F-100 | Architecture multi-pays | MUST | P0 |

### 6.13 Fonctionnalités IA (P4)

Toutes **COULD** / reportées au CDC v2 de l'IA :

| # | Fonctionnalité | Priorité |
|---|---|---|
| F-101 | Suggestion de véhicules personnalisée | COULD |
| F-102 | Détection de fraude (paiement, inscriptions) | COULD |
| F-103 | Recommandation de prix (pricing dynamique) | COULD |
| F-104 | Chatbot d'assistance | COULD |
| F-105 | Analyse prédictive des statistiques | COULD |

---

## 7. Spécifications fonctionnelles détaillées

> Ce chapitre donne, pour les parcours les plus structurants, la formulation **utilisateur** et les **critères d'acceptation**. Dans un marché réel, chaque module doit être couvert par une spécification de niveau comparable ; le présent document définit le niveau de détail attendu et le couvre sur les parcours cœur.

### 7.1 Inscription et compte

**US-001 — En tant que visiteur, je veux m'inscrire avec mon email et mon numéro de téléphone, afin de réserver un véhicule.**

Critères d'acceptation :
- Les champs email et téléphone sont tous deux obligatoires et validés (format + unicité).
- Un code OTP à 6 chiffres est envoyé par SMS ; expiration à 10 minutes `[PLACEHOLDER]`; maximum 3 tentatives.
- Le compte est inactif tant que le téléphone n'est pas vérifié ; il ne peut pas réserver avant.
- La création déclenche l'envoi d'un e-mail de bienvenue.

**US-002 — En tant qu'utilisateur, je veux m'inscrire via Google, afin de ne pas créer un compte de plus.**

- L'API sociale fournit l'email et le nom ; le numéro de téléphone reste obligatoire (clé métier de la plateforme).
- Si l'email existe déjà, l'utilisateur est rattaché au compte existant après vérification du numéro.

### 7.2 Publication d'un véhicule

**US-003 — En tant que propriétaire, je veux publier mon véhicule, afin qu'il soit louable.**

Critères d'acceptation :
- Un véhicule nécessite : catégorie, marque, modèle, année, immatriculation, ville, photos (≥ 5), tarif journalier, documents de conformité.
- **Statuts** : `BROUILLON` → `EN_VALIDATION` → `PUBLIE` ou `REFUSE`. Seul `PUBLIE` apparaît dans la recherche.
- Le refus est motivé et notifié. Le véhicule refusé peut être corrigé et resoumis.
- Un véhicule sans disponibilité-defined ni sans tarif ne peut pas être publié.
- La publication est refusée si les documents sont expirés (§3.1).

### 7.3 Recherche

**US-004 — En tant que client, je veux trouver un véhicule disponible à Abidjan entre deux dates, afin de le réserver.**

Critères d'acceptation :
- Le filtre de dates exclut tout véhicule ayant au moins un jour bloqué sur l'intervalle (chevauchement d'intervalles `[début_inclusif, fin_exclu]`).
- Les résultats sont limités à 20 par page, pagination ou défilement infini.
- Chaque résultat affiche : photo, nom, catégorie, note, prix journalier, badge « avec chauffeur », distance si position connue.
- Aucun résultat renvoie un état vide explicite et des suggestions (élargir dates, autres communes).
- **Budget de performance** : réponse < 500 ms au 95e percentile sur la recherche simple.

### 7.4 Réservation

**US-005 — En tant que client, je veux connaître le prix total exact avant de payer.**

Critères d'acceptation :
- Le récapitulatif affiche : nombre de jours × tarif, suppléments, caution, frais de service, pénalités éventuelles, **total**.
- Le total est calculé côté serveur et figé au moment de la création de la réservation ; toute modification de dates ou de lieux impose un nouveau calcul.
- Le prix ne peut jamais être modifié après encaissement sans nouvelle réservation et sans trace d'audit.

**US-006 — En tant que client, je veux payer et obtenir une confirmation immédiate.**

- La réservation est créée à l'état `EN_ATTENTE_PAIEMENT` pour une durée limitée `[PLACEHOLDER]` (ex. 15 min), puis passe à `EXPIREE`.
- Le paiement confirmé fait passer la réservation à `PAYEE` et déclenche la notification au fournisseur.
- Le paiement échoué ne bloque pas la réservation : l'utilisateur peut réessayer jusqu'à expiration.
- **Le véhicule reste bloqué dès la création de la réservation** et non au paiement, afin d'éviter la sur-réservation.
- Un identifiant de réservation unique est affiché ; il sert de référence de paiement.

### 7.5 Prise en charge et restitution

**US-007 — En tant que chauffeur ou fournisseur, je want valider la prise en charge, pour engager les deux parties.**

- Bloc de prise en charge : photo du véhicule, kilométrage, état des lieux, signatures des deux parties.
- Le compte à rebours de retard démarre à l'heure de prise en charge prévue ; au-delà, une alerte est émise.

**US-008 — En tant que fournisseur, je want constater les dommages à la restitution, pour pouvoir facturer.**

- Bloc de restitution avec photos obligatoires.
- Un constat de dommages déclenche une proposition de capture sur caution, **qui doit être validée ou rejetée par le client**, puis confirmée ou contestée par l'admin (§8.3).

### 7.6 Avis

**US-009 — En tant que client, je veux noter et commenter une location terminée.**

- Un avis par location, uniquement après restitution, dans un délai de `[PLACEHOLDER]` jours.
- Note de 1 à 5 ; le commentaire est obligatoire pour une note ≤ 3.
- Modification et suppression par l'auteur pendant `[PLACEHOLDER]` jours ; suppression après validation par l'admin tracée en audit.
- Un avis ne peut pas être posé sur une location having une réclamation ouverte `[TBD]`.

### 7.7 Notifications

**US-010 — En tant qu'utilisateur, je veux être notifié par SMS de mes événements clés.**

- Événements déclencheurs : réservation créée, réservation confirmée, rappel 24 h avant, échéance de paiement, annulation, restitution, litige, paiement reçu.
- Repli obligatoire : si le push échoue, envoi SMS ; si le SMS échoue, e-mail.
- L'utilisateur peut choisir son canal préféré par type d'événement (F-62).
- Tout envoi est journalisé (canal, statut, réponse du fournisseur).

### 7.8 Back-office

**US-011 — En tant qu'administrateur, je veux valider les véhicules publiés, afin de protéger la qualité de la plateforme.**

- File de validation triée par date, avec aperçu complet.
- Décision : valider / refuser motivé / demander une pièce.
- Chaque décision est journalisée (utilisateur, horodatage, motif).

**US-012 — En tant qu'administrateur, je veux suivre les KPIs, afin de piloter l'activité.**

- Indicateurs : reservations créées / confirmées / annulées, CA total, commissions prélevées, taux d'occupation moyen, véhicules actifs, agences actives, taux de conversion du tunnel, panier moyen.
- Graphiques : évolution mensuelle, répartition par catégorie, top véhicules, top agences, répartition par commune.
- Filtres par période, catégorie, ville, agence.

---

## 8. Règles métier et machines à états

> ⚠️ **Chapitre entièrement nouveau.** Le CDC v1 ne définit aucune règle métier. Sans ces règles, le module Réservation n'est pas implémentable de façon fiable.

### 8.1 Machine à états de la réservation

```
BROUON_DRAFT
   └─(valider)→ EN_ATTENTE_PAIEMENT
                       ├─(paiement OK)────────────→ PAYEE
                       │                                  ├─(prise en charge)→ EN_COURS
                       │                                  │        ├─(restitution sans litige)→ TERMINEE
                       │                                  │        ├─(restitution + dommages)→ LITIGE
                       │                                  │        └─(restitution tardive)→ RETARD
                       │                                  ├─(annulation client, délai)→ ANNULEE_CLIENT
                       │                                  └─(annulation fournisseur)→ ANNULEE_FOURNISSEUR
                       ├─(délai dépassé)────────────→ EXPIREE
                       └─(paiement échoué, nouvelle tentative)→ EN_ATTENTE_PAIEMENT

LITIGE ─(arbitrage admin)→ RESOLU_FAVORABLE_CLIENT | RESOLU_FAVORABLE_FOURNISSEUR | RESOLU_PARTAGE
TERMINEE ─(délai d'avis dépassé)→ CLOTUREE
```

**Invariants [MUST] :**
1. Le véhicule est indisponible sur `[début, fin)` dès que la réservation quitte `EN_ATTENTE_PAIEMENT`, et le reste jusqu'à `TERMINEE`, `CLOTUREE`, ou annulation.
2. Une transition n'est possible que si l'état actuel le permet ; l'API refuse toute transition non autorisée (erreur `409 TRANSITION_NON_AUTORISEE`).
3. Chaque transition écrit une ligne d'audit : acteur, horodatage, état source, état cible.
4. Aucun état n'est modifiable manuellement en base : correction par script tracé, jamais par `UPDATE` manuel.

### 8.2 Règles de chevauchement

Deux réservations `[d1, f1)` et `[d2, f2)` sont en conflit si et seulement si `d1 < f2 AND d2 < f1`.

- Chevauchement strict : `d1 == f2` est **compatible** (fin le matin, début le matin plus tard) — `[TBD]` si l'heure de restitution/prise en charge est gérée (voir §8.4).
- Le contrôle est appliqué **sous transaction** à la création de la réservation, pour éviter toute double réservation concurrente. Un index PostgreSQL sur la plage `[début, fin)` renforce la garantie `[TBD : exclusion constraint]`.

### 8.3 Machine à états du litige

```
OUVERT (par le client, le fournisseur ou l'admin)
   └─(pièces jointes, dans un délai de 48 h)→ EN INSTRUCTION
          ├─(accord des parties ou décision admin)→ RÉSOLU
          ├─(capture de caution approuvée)→ RÉSOLU
          └─(délai d'instruction dépassé, 30 j)→ CLÔTURÉ D'OFFICE
```

### 8.4 Règle des horaires

| Cas | Règle |
|---|---|
| Retrait et restitution à la même heure | Tarif = nombre de jours `⌊(f − d)/24h⌋`, minimum 1 jour `[PLACEHOLDER]` |
| Période de grâce | 30 min après l'heure prévue pour la restitution, sans pénalité `[PLACEHOLDER]` |
| Dépassement | facturé à l'heure entamée, au tarif horaire journalier prorata |
| Retard de prise en charge | Blocage des véhicule après un délai `[PLACEHOLDER]` ; libérée après 30 min sans contact |

### 8.5 Règle de commission

```
commission = base_commissionnable × taux_du_plan
base_commissionnable = prix_total − TVA − caution − pénalités_reversées
```

- **TVA** prélevée sur la part plateforme, reversée au Trésor (à confirmer §3.3).
- **Caution** : hors commission (elle n'est pas un revenu).
- **Commission agency** : le taux est celui du plan de l'agence au **moment de la réservation**, figé pour sa durée de vie.

### 8.6 Règle de disponibilité

- Le calendrier distingue : **disponible**, **indisponible (blocage manuel)**, **réservé**, **maintenance**.
- Un véhicule `PUBLIE` sans aucune plage disponible n'apparaît pas sur les dates correspondantes, mais reste visible si l'utilisateur consulte une autre date.
- La maintenance est déclarée par le fournisseur sur une plage ; elle bloque le calendrier et déclenche l'information des réservations concernées `[TBD]`.

### 8.7 Règle de suppression

| Entité | Politique |
|---|---|
| Compte utilisateur | Soft delete (90 j) puis anonymisation irréversible |
| Véhicule | Soft delete ; indisponible à la recherche ; historique conservé |
| Réservation | Jamais supprimée (obligation comptable et contentieuse) |
| Avis | Suppression logiquelie avec trace d'audit |
| Message | Conservé 1 an `[PLACEHOLDER]` |
| Localisation brute | Purge automatique après 90 jours `[PLACEHOLDER]` |

---

## 9. Modèle de données

> ⚠️ **Chapitre entièrement nouveau.** Vue d'ensemble des entités. Le schéma DDL complet fait partie des livrables (§17) et doit être validé avant P0.

### 9.1 Entités principales

| Entité | Rôle | Champs clés |
|---|---|---|
| `user` | Compte d'accès | `id`, `email`, `phone`, `password_hash`, `status`, `roles`, `locale`, `created_at` |
| `agency` | Agence partenaire | `id`, `name`, `slug`, `plan_id`, `commission_rate`, `ibusiness_identifiers`, `status` |
| `agency_member` | Collaborateur d'agence | `agency_id`, `user_id`, `role`, `permissions[]` |
| `driver` | Chauffeur | `id`, `user_id`, `agency_id`, `license_number`, `license_expiry`, `rating`, `status` |
| `vehicle_category` | Catégorie et attributs | `id`, `slug`, `label`, `attributes_schema` (jsonb) |
| `vehicle` | Véhicule publié | `id`, `owner_id` (ou `agency_id`), `category_id`, `brand`, `model`, `year`, `plate`, `transmission`, `fuel`, `seats`, `ac`, `daily_rate`, `with_driver`, `location_id`, `status` |
| `vehicle_feature` | Équipements | `vehicle_id`, `feature` |
| `vehicle_media` | Photos et vidéos | `vehicle_id`, `url`, `kind`, `order`, `is_cover` |
| `vehicle_document` | Documents de conformité | `vehicle_id`, `kind`, `file_url`, `expires_at` |
| `location` | Ville / commune / quartier | `id`, `country_code`, `type`, `name`, `parent_id`, `lat`, `lng` |
| `availability` | Plage de disponibilité | `vehicle_id`, `start_at`, `end_at`, `type` (`available`, `blocked`, `maintenance`) |
| `booking` | Réservation | `id`, `reference`, `client_id`, `provider_id`, `provider_type`, `vehicle_id`, `start_at`, `end_at`, `status`, `quote_snapshot`, `pricing_snapshot`, `created_at` |
| `booking_status_history` | Historique d'états | `booking_id`, `from_status`, `to_status`, `actor_id`, `reason`, `at` |
| `payment` | Paiement | `id`, `booking_id`, `provider_id`, `amount`, `currency`, `status`, `paid_at`, `raw` (jsonb) |
| `refund` | Remboursement / capture de caution | `id`, `payment_id`, `kind` (`refund`, `deposit_capture`), `amount`, `status`, `reason` |
| `payout` | Virement fournisseur | `id`, `provider_id`, `period`, `gross_amount`, `commission`, `net_amount`, `status`, `paid_at` |
| `contract` | Contrat numérique | `id`, `booking_id`, `pdf_url`, `status`, `created_at` |
| `signature` | Signature électronique | `contract_id`, `signer_id`, `method`, `signed_at`, `hash`, `ip` |
| `handover` | Prise en charge / restitution | `booking_id`, `kind` (`pickup\|return`), `mileage`, `fuel_level`, `photos[]`, `notes` |
| `damage_report` | Constat de dommages | `booking_id`, `reported_by`, `photos[]`, `description`, `estimated_amount`, `status` |
| `dispute` | Litige | `booking_id`, `opened_by`, `reason`, `status`, `resolution`, `resolved_by` |
| `review` | Avis | `booking_id`, `author_id`, `rating`, `comment`, `status`, `reported` |
| `review_report` | Signalement d'avis | `review_id`, `reporter_id`, `reason` |
| `conversation` | Fil de messagerie | `booking_id` (nullable), `created_at` |
| `message` | Message | `conversation_id`, `sender_id`, `body`, `attachments[]`, `read_at` |
| `notification` | Notification | `user_id`, `type`, `channel`, `status`, `payload`, `sent_at`, `error` |
| `notification_pref` | Préférence de notification | `user_id`, `event`, `channels[]` |
| `coupon` / `promotion` | Remises | `code`, `type` (`percent\|amount`), `scope`, `min_amount`, `max_uses`, `used`, `valid_from`, `valid_to` |
| `plan` | Formule d'abonnement | `key`, `vehicle_limit`, `member_limit`, `commission_rate`, `price` |
| `subscription` | Abonnement fournisseur | `provider_id`, `plan_id`, `status`, `renews_at` |
| `cms_page` | Page CMS | `slug`, `locale`, `title`, `body`, `status` |
| `faq_item` | FAQ | `question`, `answer`, `order`, `status` |
| `banner` | Bannière | `placement`, `image_url`, `link_url`, `start_at`, `end_at`, `status` |
| `setting` | Paramètre global | `key`, `value` (jsonb), `group` |
| `audit_log` | Journal d'audit | `actor_id`, `action`, `entity`, `entity_id`, `before`, `after`, `ip`, `at` |
| `country` / `currency` | Multi-pays | `code`, `name`, `default_currency`, `timezone`, `locale`, `is_active` |

### 9.2 Conventions

| Convention | Règle |
|---|---|
| Clé primaire | UUID (v7 ou v4) pour éviter l'énumération |
| Montants | `bigint` en centimes — **jamais** de `float` |
| Dates/heures | `timestamptz` stocké en UTC, affiché en heure locale du pays |
| Suppression | `deleted_at timestamptz null` sur les entités supprimables |
| Versioning optimiste | `version integer` sur les entités concurrentes (booking, vehicle) |
| Nommage | `snake_case` ; tables au pluriel ; énumérations en `text` avec `CHECK` |
| Index | Sur `status`, `city_id`, `created_at`, et toutes les clés étrangères filtrées |
| Recherche | Index GIN `tsvector` sur `vehicle` (marque, modèle, catégorie) |
| Images | `url` CDN + dimensions en base pour éviter les recalculs de mise en page |

### 9.3 Cardinalités clés

- Un `user` peut être propriétaire (`vehicle`), membre d'agence (`agency_member`) et/ou chauffeur (`driver`) — **les rôles se cumulent**.
- Un `vehicle` appartient **soit** à un propriétaire, **soit** à une agence (contrainte d'exclusion).
- Une `booking` référence **toujours** un `vehicle` et **toujours** un fournisseur (propriétaire ou agence).
- Un `payment` appartient à une `booking` et à un fournisseur ; les cautions sont des `payment` de type distinct.
- Un `review` est lié à une `booking` terminée — **garantit l'unicité de l'avis par location**.

### 9.4 Séparation des données sensibles

- Aucune donnée de carte bancaire stockée (tokenisation PSP uniquement).
- Les documents d'identité sont chiffrés au repos et hors du périmètre des dumps d'analyse.
- La localisation n'est accessible qu'aux acteurs de la réservation concernée.

---

## 10. Architecture technique

### 10.1 Vue d'ensemble

```
                 ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
                 │  Web (Next)  │   │ Flutter mob. │   │  Back-office │
                 └───────┬──────┘   └──────┬───────┘   └──────┬───────┘
                         └─────────────────┼──────────────────┘
                            ┌────────────▼─────────────┐
                            │   API REST (NestJS)      │
                            │  + WebSocket (Socket.IO)  │
                            └─────┬───────┬───────┬────┘
                       ┌──────────┘       │       └──────────┐
              ┌────────▼────────┐ ┌────────▼────────┐ ┌───────▼───────┐
              │  PostgreSQL    │ │      Redis       │ │  File d'attente │
              │  (données)     │ │ cache + sessions │ │  (BullMQ)       │
              └─────────────────┘ └──────────────────┘ └───────┬───────┘
                                                              │
              ┌───────────────────────────────┐   ┌───────────▼──────────┐
              │  Workers : mail, SMS, push,   │   │  Stockage objet S3/R2 │
              │  PDF, reconciliation, rappels │   │  + CDN               │
              └───────────────────────────────┘   └──────────────────────┘
```

### 10.2 Stack retenue

| Couche | Technologie | Justification / décision |
|---|---|---|
| Front web | **Next.js (App Router) + TypeScript + Tailwind** | SSR/ISR pour le SEO (indispensable marketplace) ; un seul codebase pour le site **et** le back-office |
| Mobile | **Flutter** (Android + iOS) | Un seul code pour deux stores ; excellent pour caméra, GPS, signature |
| Back-office | **Next.js**, pas d'application séparée | ⚠️ **Divergence vs CDC v1** : 3 tableaux de bord distincts sont coûteux. Un back-office unique à rôles, internes cloisonnés |
| Backend | **Node.js + NestJS (TypeScript)** | Structure modulaire, DI, documentation OpenAPI native |
| Base de données | **PostgreSQL 16** | Transactions, JSONB, recherche plein texte, contraintes d'exclusion |
| Cache / files | **Redis** (cache, sessions, rate limiting) + **BullMQ** (files d'attente) | Requis pour les rappels, l'envoi d'e-mails et la réconciliation |
| Recherche | **PostgreSQL FTS** en P1, **Meilisearch / Typesense** si seuil atteint | Évite un composant de plus au démarrage |
| Stockage | **Cloudflare R2 ou S3** derrière une interface `StorageProvider` | Évite le verrouillage fournisseur |
| Authentification | **JWT court + refresh rotation**, **OAuth2** (Google, Apple, Facebook) | Refresh rotation + révocation serveur |
| Temps réel | **Socket.IO** avec adaptateur Redis | ⚠️ **Usage restreint** à la messagerie et au statut de réservation ; le reste passe par polling ou invalidation de cache |
| Paiement | Interface `PaymentProvider` × N implémentations | **Obligatoire** : les APIs locales ont des cycles de vie indépendants (§14.2) |
| Signature | Signature électronique native + horodatage `[TBD]` | Évite une dépendance externe à forte contrainte |
| PDF | Génération serveur (Puppeteer ou PDFKit) | Contrats, factures, constats |
| Observabilité | **Sentry** + logs structurés + métriques OpenTelemetry | Requis par les NFR (§11) |
| CI/CD | GitHub Actions → registre d'images → déploiement | Voir §15.4 |
| IaC | **Terraform** | Reproductibilité et environments documentaires |

### 10.3 Structure du dépôt (monorepo)

```
/
├─ apps/
│  ├─ web/            Next.js — site + back-office (routes /admin)
│  └─ mobile/         Flutter
├─ services/
│  └─ api/            NestJS
│     ├─ src/modules/    (auth, users, vehicles, booking, payment, ...)
├─ packages/
│  ├─ contracts/      types partagés + schémas zod
│  └─ ui/             composants design system (React)
├─ docs/              CDC, ADR, API, diagrammes
├─ infra/             Terraform
└─ .github/workflows/
```

**Règle [MUST]** : un seul dépôt, un seul `pnpm install`, un seul pipeline de qualité. Le monorepo évite la dérive de versions et la duplication de contrats.

### 10.4 Intégrations externes — points de vigilance

| Intégration | Point de vigilance |
|---|---|
| **Google Maps** | Coût par appel ; **plafond de budget + alertes** obligatoires ; cache des géocodages ; Google Maps pour la recherche, Mapbox ou tuiles ouvertes en secours si indisponible |
| **Firebase (FCM)** | Fiabilité réseau en CI ; toujours prévoir un repli SMS |
| **WhatsApp Business API** | Coût « par conversation » `[À CONFIRMER]` ; obtenir un compteprofessionnel Meta et un numéro dédié |
| **PSP Mobile Money** | 5 contrats, 5 cycles de certification, aucune documentation unifiée |
| **E-mail** | Nécessite un domaine avec SPF/DKIM/DMARC dès P0 ; sinon les e-mails partent en spam |
| **SMS** | Prestataire régional recommandé (`[TBD]`) ; vérifier la couverture de chaque zone |

### 10.5 Résilience réseau (exigence terrain)

| Contrainte terrain | Réponse produit |
|---|---|
| Réseau 2G/3G fréquent | Budget de poids strict (§11.3), requêtes incrémentales, résiliation des appels |
| Coupures électriques | Aucune dépendance temps réel : toute action doit être retentable sans état local figé |
| Modes de paiement Mobile Money souvent sur *ussd* | Prévoir une confirmation serveur par **webhook + polling de réconciliation**, jamais par le seul retour du client |
| Utilisateurs dual-SIM / prepayment | Nombre de téléphone unique unique, validation par OTP |

### 10.6 Internationalisation dès la conception

- **`i18n` au niveau framework** (`next-intl`), clés de traduction en fichiers, jamais de texte en dur.
- **Devise au niveau modèle** : colonne `currency` sur les montants, `country.default_currency`.
- **Zone de recherche par pays** : `location` est hiérarchique et rattaché à un pays.
- **Multi-rôles, multi-devises, multi-pays : aucun de ces actifs ne doit nécessiter de migration de schéma** — exigence du CDC v1 §29, rendue ici vérifiable.

---

## 11. Exigences non fonctionnelles

> ⚠️ **Chapitre entièrement nouveau.** Le CDC v1 ne contient qu'une seule exigence mesurable (« chargement < 2 s »), sans méthode de mesure. Les valeurs ci-dessous sont **proposées** et doivent être arrêtées en comité.

### 11.1 Performance

| Indicateur | Cible MVP | Cible v2 | Méthode de mesure |
|---|---|---|---|
| Temps de réponse API (hors intégrations tierces) | p95 < 400 ms | p95 < 250 ms | APM, 1 000 req/min |
| Recherche de véhicules | p95 < 600 ms | p95 < 300 ms | Load test |
| Largest Contentful Paint (4G) | < 2,5 s | < 1,8 s | Lighthouse / CrUX |
| Largest Contentful Paint (3G réel) | < 4,0 s | < 3,0 s | Terrain — Abidjan |
| Interaction to Next Paint | < 200 ms | < 150 ms | Web Vitals |
| Taux d'erreur 5xx | < 0,5 % | < 0,1 % | Supervision |
| Notification (délai réservation → SMS) | < 60 s | < 30 s | Supervision asynchrone |

> **Note de réalisme** : la cible « < 2 s » du CDC v1 est **atteignable en 4G** mais **irréaliste en 3G**, qui reste courante. Le NFR doit donc être exprimé par conditions de réseau, sinon il ne sera pas vérifiable.

### 11.2 Charge et montée en charge

| Élément | Cible MVP | Cible v2 |
|---|---|---|
| Utilisateurs actifs simultanés | 2 000 | 20 000 |
| Débit API en pointe | 100 req/s | 1 000 req/s |
| Réservations_created en pointe (tests) | 10/min | 100/min |
| Stockage médias | 100 Go | 1 To |
| Requêtes analytiques complexes | < 5 s | < 2 s |

**Test de charge obligatoire** avant chaque jalon de production, avec un scénario de pic réaliste (concentration à 18 h,+fête).

### 11.3 Budget de poids des pages (contrainte terrain)

| Ressource | Budget |
|---|---|
| HTML | < 60 Ko gzip |
| JavaScript (route critique) | < 200 Ko gzip |
| CSS | < 40 Ko gzip |
| Images (LCP) | < 150 Ko, formats **WebP/AVIF** |
| Image de couverture d'un véhicule | ≤ 3 variantes responsives (400/800/1600 px) |
| Polices | 2 maximum, `font-display: swap`, sous-ensemble latin |

### 11.4 Disponibilité et résilience

| Indicateur | Cible MVP | Cible v2 |
|---|---|---|
| Disponibilité | 99,5 % | 99,9 % |
| RPO (perte de données max) | 24 h | 1 h |
| RTO (remise en service max) | 4 h | 1 h |
| Sauvegardes | quotidiennes | continues (PITR) |
| Test de restauration | trimestriel | mensuel |
| Failover base de données | non | oui (réplica) |

**Maintenance** : fenêtre annoncée, jamais en heure de pointe locale (18 h–22 h), avec mode dégradé en lecture.

### 11.5 Sécurité (détails au chapitre 12)

- HTTPS obligatoire partout, HSTS, redirection 80 → 443.
- Rate limiting par IP, par utilisateur, par endpoint sensible.
- Protection CSRF sur les mutations web ; SameSite strict sur les cookies.
- En-têtes : CSP stricte, `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors`.
- Scan de dépendances et de conteneurs en CI (bloquant).

### 11.6 Accessibilité

| Exigence | Niveau |
|---|---|
| Conformité | **WCAG 2.1 niveau AA** — engagement fort, à confirmer selon le budget |
| Navigation clavier | Obligatoire sur le parcours de réservation |
| Contrastes de couleur | ≥ 4,5:1 |
| Alternatives textuelles | Obligatoires sur les images porteuses d'information |
|libre accessible | `lang`, `aria-label` sur les contrôles iconiques |

### 11.7 Qualité du code

| Exigence | Cible |
|---|---|
| Couverture de tests unitaires | ≥ 70 % des modules métier (réservation, paiement, commission) |
| Couverture de tests fonctionnels | 100 % des parcours P1 |
| Typage | TypeScript `strict`, aucun `any` non justifié |
| Lint / format | ESLint + Prettier, bloquant en CI |
| Analyse de sécurité | npm audit / CodeQL sans vulnérabilité haute |
| Documentation | OpenAPI généré automatiquement, à jour à chaque build |

### 11.8 Observabilité

| Élément | Exigence |
|---|---|
| Logs | Structurés (JSON), corrélés par `request_id`, 30 jours de rétention |
| Métriques | Saturation API, temps de réponse, file d'attente, taux d'erreur par module |
| Traces | OpenTelemetry sur les appels sortants (PSP, SMS, carte) |
| Alertes | Page sur 5xx > 2 %, file d'attente bloquée, échec de paiement, indisponibilité PSP |
| Tableau de bord | Centralisé, accessible au commanditaire |

### 11.9 Localisation

| Exigence | Valeur |
|---|---|
| Fuseau horaire | Stockage UTC, affichage en heure de `country.timezone` |
| Format de date | Localisé par pays (`jj/mm/aaaa` par défaut) |
| Format monétaire | Localisé (espace insécable, symbole après le montant) |
| Recherche textuelle | **Insensible aux accents et à la casse** — « Abidjan » doit trouver « abidjan » |
| SMS | Encodage restreint (GSM-7 quand possible), coût par segment maîtrisé |

---

## 12. Sécurité et conformité

### 12.1 Principes

1. **Défense en profondeur** : aucune confiance accordée au client.
2. **Least privilege** : permissions minimales par rôle, vérifiées côté API.
3. **Aucune donnée sensible dans les journaux**.
4. **Échec fermé** : en cas d'incertitude sur une autorisation, la requête est refusée.

### 12.2 Authentification

| Mesure | Détail |
|---|---|
| Mots de passe | Argon2id ou bcrypt (coût ≥ 12) ; jamais de SHA simple |
| Jetons d'accès | JWT court (15 min), signature asymétrique (RS256) |
| Jetons de rafraîchissement | Rotation à chaque usage, détection de réutilisation, révocation serveur |
| OTP | 6 chiffres, 10 min, 3 tentatives, protection contre le bombardment (rate limit par numéro) |
| OAuth | PKCE côté mobile, `state` anti-CSRF côté web |
| Sessions web | Cookie `HttpOnly`, `Secure`, `SameSite=Lax`, stockage serveur (Redis) |
| Déconnexion | Révocation immédiate des refresh tokens |
| Élévation de privilèges | L'accès admin n'est **jamais** accordé par simple inscription |

### 12.3 Autorisation

- Modèle **RBAC** par rôle, avec extensions par ressource (`agency_member.permissions[]`).
- Vérification systématique côté API : filtre applicatif + contrainte de propriété (`WHERE vehicle.owner_id = :user`).
- **Test d'autorisation obligatoire** : pour chaque endpoint, un test vérifie qu'un utilisateur d'un autre tenant/propriété reçoit `403`.

### 12.4 Protection de l'API

| Vecteur | Contre-mesure |
|---|---|
| Injection SQL | Requêtes paramétrées / ORM ; **interdiction des chaînes concaténées** |
| XSS | Échappement par défaut, CSP stricte, nettoyage du HTML riche |
| CSRF | Jeton CSRF sur mutations ; `SameSite` ; vérification `Origin` |
| SSRF | Liste d'hôtes autorisés pour tout appel sortant |
| Path traversal | Normalisation et validation des chemins de fichiers |
| DDos /-force brute | Rate limiting global + par IP + par compte, avec file d'attente |
| IDOR | Identifiants UUID, contrôle de propriété systématique |
| Mass assignment | DTOs stricts, liste blanche de champs acceptés |
| Fuite de secrets | Variables d'environnement / coffre de secrets, jamais en dépôt |

### 12.5 Audit et traçabilité

- **Toutes** les actions d'administration et **toutes** les transitions de réservation sont journalisées : acteur, horodatage, IP, entité, valeurs avant/après.
- Journal en append-only, conservé 3 ans `[PLACEHOLDER]`.
- Consultable par l'admin, exportable pour audit externe.

### 12.6 Sécurité des paiements

- **Aucune donnée de carte stockée** (tokenisation par le PSP).
- Validation côté serveur du montant, de la devise et de la booking associée à chaque callback.
- **Idempotence** : un callback de paiement répété ne crée jamais de double débit ni de double crédit.
- Signature des webhooks vérifiée (HMAC ou asymétrique) ; rejet des webhooks non signés.
- Comptes de séparation des fonds pour les caution (voir §4.2).

### 12.7 Sécurité mobile

- Pas de secret embarqué dans l'application mobile ; les clés passent par le serveur.
- Attestation d'application `[SHOULD]`.
- Protection des données locales (chiffrement du stockage privé).
- Certificate pinning optionnel `[COULD]`.

### 12.8 Sécurité des fichiers

- Validation du type MIME réel (magic bytes), pas seulement de l'extension.
- Limite de taille (images 10 Mo, vidéos 200 Mo `[PLACEHOLDER]`).
- Re-nommage des fichiers ; URLs non devinables ; liens signés à durée courte pour les documents sensibles.

### 12.9 Gestion des incidents

| Étape | Action |
|---|---|
| 1. Détection | Alerte automatique |
| 2. Qualification | Gravité (P1–P4), périmètre, données concernées |
| 3. Notification | Commanditaire sous 4 h pour un incident P1 |
| 4. Remédiation | Contournement, correctif, retour arrière |
| 5. Retour d'expérience | Rapport sous 15 jours, actions correctives suivies |
| 6. Notification réglementaire | Selon obligation CNDP en cas de violation de données |

**Engagement de notification : toute violation de données personnelles est notifiée au commanditaire sous 4 heures.**

---

## 13. UX, UI et localisation

### 13.1 Principes directeurs

| Principe | Application |
|---|---|
| **Mobile d'abord** | 80 % du trafic attendu en Côte d'Ivoire est mobile ; la maquette mobile est la référence, le web s'adapte |
| **Moins de 3 minutes** | Parcours de réservation ≤ 3 écrans entre la recherche et le paiement |
| **Prix toujours visible** | Le prix total est affiché avant chaque étape engageante |
| **Paiement de proximité** | Mobile Money mis en avant par rapport à la carte bancaire |
| **Fonctionnement dégradé** | Toute action importante doit être retentable sans réseau |
| **Français simple** | Phrases courtes, pas de jargon technique |

### 13.2 Parcours à concevoir en priorité (maquettes)

| # | Parcours | Phase |
|---|---|---|
| M-01 | Inscription et vérification OTP | P1 |
| M-02 | Recherche et filtres (mobile) | P1 |
| M-03 | Fiche véhicule et galerie | P1 |
| M-04 | Réservation et récapitulatif de prix | P1 |
| M-05 | Paiement Mobile Money | P1 |
| M-06 | Confirmation et gestion de réservation | P1 |
| M-07 | Publication de véhicule (propriétaire) | P1 |
| M-08 | Tableau de bord propriétaire | P2 |
| M-09 | Tableau de bord agence | P2 |
| M-10 | Back-office admin (validation, litiges, KPIs) | P2 |
| M-11 | Bloc de prise en charge / restitution | P2 |
| M-12 | Espace chauffeur | P3 |

> **Exigence [MUST]** : les maquettes des parcours P1 sont **validées avant le développement**. Un développement.Parallel à la validation des maquettes est la principale source de rework sur ce type de projet.

### 13.3 Design system

- Bibliothèque de composants partagée web ↔ mobile (tokens de couleur, typographie, espacement).
- Thème sombre en option pour les applications mobiles `[COULD]`.
- Support des écrans à faible contraste et de la lumière directe (lisibilité en plein soleil).

### 13.4 Localisation linguistique

| Élément | Spécification |
|---|---|
| Langues P1 | **Français** |
| Langues P3 | **Anglais** |
| Currencies P1 | **XOF** (CI) |
| Currencies P4 | Par pays (XOF, XOF, XOF, XAF — noter que plusieurs pays partagent le XOF/XAF) |
| Format des montants | Espace insécable + devise après le montant |
| Fuso horaires | `Africa/Abidjan` (UTC+0) pour la phase 1 `[À CONFIRMER]` |

### 13.5 Saisie mobile

- Clavier numérique pour les montants et le téléphone.
- Détection du format de téléphone ivoirien (`+225 07 00 00 00 00`) avec validation stricte.
- Auto-capitalisation désactivée pour les identifiants.

### 13.6 SEO et performance organique

- Métadonnées Open Graph et données structurées `Product` / `LocalBusiness`.
- Sitemaps pour les pages de catégorie et de ville ; URLs propres.
- Contenu éditorial minimal par ville (marché local, le plus utile pour le référencement local).
- `robots.txt` bloquant les pages admin et authentifiées.

---

## 14. Intégrations tierces

> ⚠️ **Chapitre entièrement nouveau.** Le CDC v1 liste des intégrations sans évaluer leur faisabilité ni leur coût. **C'est la principale source de dérapage du projet.**

### 14.1 Tableau de synthèse

| Intégration | Priorité | Phase | Statut réel | Risque |
|---|---|---|---|---|
| **OTP / SMS** | MUST | P1 | Standard | Faible |
| **E-mail transactionnel** | MUST | P1 | Standard | Domaine + SPF/DKIM à configurer |
| **Mobile Money (1 opérateur)** | MUST | P1 | Contrat marchand requis | **Moyen-élevé** |
| **Google Maps** | MUST | P1 | Standard, **payant à l'appel** | **Élevé (coût)** |
| **Stockage objet** | MUST | P1 | Standard | Faible |
| **Push FCM** | SHOULD | P3 | Standard | Moyen (fiabilité réseau) |
| **PSP cartes** | MUST | P2 | **Non disponible pour un marchand ivoirien** | **Élevé** |
| **Mobile Money (4 autres)** | SHOULD | P2 | 4 contrats séparés | **Élevé (délais)** |
| **WhatsApp Business API** | SHOULD | P3 | Compte Meta + facturation par conversation | Moyen-élevé |
| **Signature électronique** | MUST | P2 | À choisir | Moyen |
| **Biométrie / vérification d'identité** | SHOULD | P2 | Prestataire à sélectionner | Moyen |

### 14.2 Point critique : Mobile Money

**Constat** : les cinq opérateurs (Orange Money, MTN Money, Wave, Moov Money) ne proposent pas la même offre, ni les mêmes délais, ni les mêmes conditions.

| Opérateur | Offre marchande | Délai d'obtention `[À CONFIRMER]` | Intégration |
|---|---|---|---|
| **Orange Money** | API marchand + Web Payment | `[À CONFIRMER]` | Web Payment (virement en ligne) + push API |
| **MTN Money** | API marchand | `[À CONFIRMER]` | Checkout + callback serveur |
| **Wave** | API marchand | `[À CONFIRMER]` | Checkout + webhook |
| **Moov Money** | API marchand | `[À CONFIRMER]` | Web Payment + callback |

**Contraintes [MUST] :**
1. Chaque opérateur = **un contrat marchand** + **une phase de certification/test** avec l'opérateur. Les cycles sont indépendants et non simultanés.
2. Aucun élément de l'API d'un opérateur ne doit fuiter dans un autre : **classe d'implémentation par opérateur**, tests distincts.
3. Les retours utilisateur ne font **jamais** foi : la confirmation de paiement provient **toujours** d'un appel serveur ou d'un webhook signé.
4. Une **file de réconciliation** compare transactions PSP ↔ transactions plateforme et alerte sur les écarts.

**Décision [TBD — arbitrage 02]** : **quel opérateur est l'intégration P1 ?** Le choix doit résulter d'une analyse de couverture et de coût, pas d'une préférence technique.

### 14.3 Point critique : paiement par carte

Le CDC v1 mentionne « Stripe si disponible ». **À corriger** :

- Stripe n'ouvre pas de compte marchand aux entités basées en Côte d'Ivoire `[À CONFIRMER]`.
- Solution : un **acquéreur local** (banque, ou PSP régional), ou une **solution de paiement fractionné** intégrée au flux Mobile Money.
- Action : sélectionner **deux** prestataires locaux et obtenir une démonstration technique avant l'engagement `[TBD]`.

### 14.4 Point critique : Google Maps

| Risque | Contrôle |
|---|---|
| Coût par appel incontrôlé | **Plafond de budget mensuel, alertes à 50/75/90 %**, quotas par clé |
| Requêtes répétitives | Cache serveur des géocodages et distances (TTL 7 j) |
| Indisponibilité | Adaptation possible vers une autre source de cartes |
| Volume estimé | `[PLACEHOLDER]` — à estimer après la phase pilote |

### 14.5 Notification : stratégie de repli

| Canal | Rôle | Repli |
|---|---|---|
| E-mail | Non urgent | — |
| **SMS** | **Critique** (confirmation, paiement, rappel) | E-mail |
| Push | Engagement utilisateur | **SMS** |
| WhatsApp | Marketing et rappel | SMS |

> **Règle [MUST]** : tout événement critique (réservation confirmée, paiement reçu, restitution) est envoyé par **SMS**, sans dépendance au push.

### 14.6 Prestataires à sélectionner

| Catégorie | Critère de sélection | Statut |
|---|---|---|
| Hébergement cloud | Non-exclusion d'un fournisseur, SLA, localisation des données | `[TBD]` |
| PSP / acquéreur | Support des Mobile Money, couverture CI, coûts | `[TBD]` |
| SMS | Couverture nationale, coût par message, API | `[TBD]` |
| E-mail | Délivérabilité, envoi transactionnel | `[TBD]` |
| Signature électronique | Conformité locale, horodatage | `[TBD]` |
| Supervision | Coût, Functions vs Self-hosted | `[TBD]` |

---

## 15. Plan de livraison, jalons et équipe

### 15.1 Découpage en phases

| Phase | Période | Contenu | Critère de sortie |
|---|---|---|---|
| **P0 — Socle** | M1–M3 | Infra, CI/CD, DB, auth, RBAC, back-office minimal, maquettes validées | Un utilisateur inscrit et connecté sur un environnement de staging |
| **P1 — MVP commercial** | M4–M8 | Recherche, fiche, réservation, 1 paiement, notifications, publication de véhicules, admin de validation | **Parcours complet : inscription → recherche → réservation → paiement → confirmation**, testé en production |
| **P2 — v1 complète** | M9–M13 | PSP cartes, caution, contrats et signature, avis, dashboards propriétaire/agence, facturation, app Android | Recette fonctionnelle validée sur les parcours P1 et P2 |
| **P3 — Écosystème** | M14–M17 | App iOS, temps réel, messagerie, espace chauffeur, géolocalisation avancée, push, multilingue | Recette P3 validée |
| **P4 — IA & expansion** | M18–M24 | Module IA, multi-pays, location longue durée | Hors engagement de la version 2 |

> **Chaque phase est un jalon de recette indépendant.** En cas de dépassement, la priorité est de **livrer la phase en cours**, jamais d'entamer la suivante.

### 15.2 Environments

| Environnement | Usage | Données | Accès |
|---|---|---|---|
| **Local** | Développement | Jeu de fixtures | Équipe |
| **CI** (intégration continue) | Tests automatisés | Fixtures | Équipe |
| **Staging** | Recette | Données de démonstration réalistes | Équipe + commanditaire |
| **Production** | Exploitation | Réelles | Restreint |

**Exigences :**
- Base de données éphémère par exécution de tests (aucun état partagé).
- Données de staging **non réelles** (données synthétiques).
- Aucun accès direct à la production en dehors d'une procédure d'urgence tracée.

### 15.3 Équipe type

| Rôle | Charge | Phase |
|---|---|---|
| Chef de projet | 0,5 ETP | Toutes |
| Développeur backend senior | 1 ETP | Toutes |
| Développeur backend | 1 ETP | P1–P3 |
| Développeur frontend senior | 1 ETP | Toutes |
| Développeur mobile (Flutter) | 1 ETP | P2–P3 |
| DevOps / SRE | 0,5 ETP | Toutes |
| QA / recette | 0,5–1 ETP | Toutes |
| Designer UI/UX | 0,5 ETP | P0–P1 |

**Estimations :** P0–P3 ≈ **17 mois** avec cette équipe ; P1 seul ≈ **8 mois**.
`[PLACEHOLDER]` Effort en jours-homme à confirmer après chiffrage.

### 15.4 CI/CD

| Étape | Outil | Blocage |
|---|---|---|
| Analyse statique + types | ESLint + `tsc` + analyse Flutter | Oui |
| Tests unitaires | Jest / test | Oui sous le seuil de couverture |
| Tests fonctionnels | Playwright / integration | Oui |
| Analyse de sécurité des dépendances | `npm audit`, CodeQL | Oui sur vulnérabilité haute |
| Construction des images | Docker multi-stage | Oui |
| Déploiement staging | Automatique | — |
| Déploiement production | **Manuel, sur validation** | — |
| Migration de base | Prisma migrate, versionnée, avec script de retour | — |

**Politique de versionnage :** Semantic Versioning. Toute modification d'API publique incompatible est versionnée et documentée. Les migrations sont **non destructives** en production.

---

## 16. Stratégie de tests et recette

### 16.1 Pyramide de tests

| Niveau | Périmètre | Cible | Outil |
|---|---|---|---|
| **Unitaires** | Logique métier : tarifs, commissions, transitions, chevauchement | ≥ 70 % | Jest |
| **Intégration** | API + base de données, files d'attente | 100 % des modules métier | Jest + testcontainers |
| **Fonctionnels (E2E)** | Parcours P1 complets | 100 % des parcours P1 | Playwright |
| **Mobile** | Parcours critiques Android/iOS | 8 parcours | Widget + tests d'intégration |
| **Non fonctionnels** | Charge, sécurité, résilience | Avant chaque jalon | k6, OWASP ZAP |
| **Accessibilité** | Parcours de réservation | AA | axe-core |
| **Terrain** | Utilisation réelle Abidjan | 1 semaine par phase | Utilisateurs pilotes |

### 16.2 Cas de test critiques à couvrir obligatoirement

1. Deux réservations concurrentes sur les mêmes dates → **une seule** aboutit.
2. Double callback de paiement → **un seul** débit, un seul crédit.
3. Expiration d'une réservation non payée → véhicule libéré automatiquement.
4. Utilisateur tentant de modifier un véhicule d'un autre propriétaire → `403`.
5. Tentative de réservation sur un véhicule dont les documents sont expirés → refusée.
6. Annulation tardive → bonne pénalité appliquée, bonne notification.
7. Captage de caution → contestable par le client, arbitré par l'admin.
8. Panne du PSP en cours de paiement → reprise sans double débit.
9. Coupure réseau pendant la soumission d'une réservation → reprise sans perte.
10. Restauration de la base depuis une sauvegarde → intégrité vérifiée.

### 16.3 Recette (UAT)

- Scénarios métier écrits par le commanditaire, exécutables sur staging.
- **Critères d'acceptation formels** par phase, signés avant passage à la phase suivante.
- Un blocage de recette est traité comme un **écart** (bug, improvement, hors périmètre) avec une gravité et une priorité.
- **Aucun jalon n'est facturé ni clos avec des écarts bloquants ouverts.**

### 16.4 Suivi des anomalies

| Gravité | Définition | Délai de correction |
|---|---|---|
| **Bloquante** | Empêche l'usage d'un parcours cœur | 48 h |
| **Majeure** | Fonction dégradée, contournement possible | 5 jours |
| **Mineure** | Gêne visuelle ou mineure | Version suivante |
| **Mineure** | Cosmétique | Backlog |

---

## 17. Livrables attendus

| # | Livrable | Phase | Formats |
|---|---|---|---|
| L-01 | Documentation fonctionnelle complète | P0–P1 | Markdown / PDF |
| L-02 | Maquettes UI/UX (mobile + desktop) | P0 | Figma |
| L-03 | Design system documenté | P0–P1 | Figma + Storybook |
| L-04 | Schéma de base de données | P0 | Diagramme + DDL versionné |
| L-05 | Documentation API (OpenAPI) | Toutes | HTML auto-généré |
| L-06 | Code source complet | Toutes | Dépôt Git, monorepo |
| L-07 | Site web responsive | P1 | Déploiement |
| L-08 | Back-office (Admin / Agence / Propriétaire) | P1–P2 | Déploiement |
| L-09 | Application Android | P2 | APK / AAB + Play Store |
| L-10 | Application iOS | P3 | IPA + TestFlight / App Store |
| L-11 | Base de code mobile (Flutter) | P2–P3 | Dépôt Git |
| L-12 | Scripts de déploiement Docker + IaC | P0 | Dépôt Git |
| L-13 | Documentation d'installation | P0–P1 | Markdown |
| L-14 | Documentation d'exploitation / runbook | P1 | Markdown |
| L-15 | Manuel utilisateur (FR) | P2 | PDF |
| L-16 | Guide administrateur | P2 | PDF |
| L-17 | Rapports de tests | P1–P3 | JUnit + rapport |
| L-18 | Documentation de sécurité | P1 | Markdown |
| L-19 | Registre des décisions d'architecture (ADR) | Toutes | Dépôt Git |
| L-20 | Procédure de réversibilité et restitution des données | P1 | Markdown |

### 17.1 Propriété intellectuelle et transfert

- Le code source est livré **en licence complète pour le commanditaire** à la livraison de chaque phase `[À CONFIRMER]`.
- Le prestataire garantit la **titularité** des droits sur les dépendances et l'absence de code à copy-left obligatoire non déclaré.
- Le prestataire ne réutilise aucun livrable pour un autre client.
- Toute bibliothèque tierce est déclarée avec sa licence.

### 17.2 Documentation obligatoire à la livraison

Procédures de : démarrage, sauvegarde et restauration, montée en charge, rotation des secrets, gestion des incidents, bascule d'opérateur de paiement, export des données.

---

## 18. Hypothèses, dépendances et risques

### 18.1 Hypothèses

| # | Hypothèse | Conséquence si fausse |
|---|---|---|
| H-01 | Les agréments et assurances sont obtenus par le commanditaire | Blocage de la mise en production |
| H-02 | Les contrats marchands Mobile Money sont signés avant P1 pour l'opérateur retenu | Report du MVP |
| H-03 | Des données de démonstration réalistes sont fournies pour la recette | Retard de recette |
| H-04 | Un interlocuteur métier est disponible pour valider les maquettes | Retard, decisions reportées |
| H-05 | L'hébergement cloud retenu est conforme aux obligations locales | Non-conformité |
| H-06 | Un moyen de paiement alternatif au PSP principal est identifié | Blocage des paiements cartes |

### 18.2 Dépendances externes

| Dépendance | Contrôle |
|---|---|
| Opérateurs Mobile Money | Suivi commercial actif, point d'escalade |
| Hébergeur cloud | SLA contractuel |
| Nom de domaine et e-mail de service | Configurés dès P0 (SPF/DKIM/DMARC) |
| Compte développeur Apple | À commander avant P3 (délai d'approbation) |
| Compte développeur Google Play | À ouvrir avant P2 |
| Compte Meta Business (WhatsApp) | À ouvrir avant P3 |

### 18.3 Registre de risques

| # | Risque | Prob. | Impact | Réponse |
|---|---|---|---|---|
| R-01 | Retard ou refus d'un contrat marchand Mobile Money | Élevée | Élevé | Démarcher les 5 en parallèle ; démarrer P1 sur le plus advanced |
| R-02 | Aucune solution de paiement carte disponible | Moyenne | Élevé | Report de F-33 ; renforcer le paiement fractionné Mobile Money |
| R-03 | Dérive du périmètre (ajouts non arbitrés) | Élevée | Élevé | Registre de changements + validation formelle de toute évolution |
| R-04 | Sous-performance sur réseau lent | Moyenne | Élevé | Budget de poids, tests terrain, cache |
| R-05 | Coût Google Maps supérieur au prévu | Moyenne | Moyen | Plafond, cache, alertes |
| R-06 | Insuffisance de moyens en phase pilote | Moyenne | Élevé | Recette formelle ; utilisateurs pilotes dès P1 |
| R-07 | Fuite ou usage détourné de données | Faible | **Critique** | Chiffrement, audit, revue de code, tests d'intrusion |
| R-08 | Turnover de l'équipe prestataire | Moyenne | Moyen | Documentation continue, handover, engage de réversibilité |
| R-09 | Indisponibilité d'un opérateur réseau | Moyenne | Moyen | Repli SMS, mode dégradé |
| R-10 | Non-conformité réglementaire | Moyenne | **Critique** | Validation juridique avant lancement (§3) |

---

## 19. Décisions à trancher

> **Ces 16 arbitrages doivent être clos avant le chiffrage définitif.** Chaque ligne non tranchée est un risque contractuel.

| # | Décision | Impact | Responsable | Échéance |
|---|---|---|---|---|
| **A-01** | Modèle de flux financier (mandataire / intermédiaire / hybride) | **Critique** — conditionne le module Paiement, la fiscalité, les contrats | Direction + juriste | Avant P0 |
| **A-02** | Prestataire de paiement de référence + opérateur Mobile Money P1 | **Critique** — conditionne le MVP | Direction | Avant P0 |
| **A-03** | Solution de paiement carte (acquéreur local) | Élevé — F-33 | Direction | Avant P1 |
| **A-04** | Gestion de la caution (escrow, délais, Conditions) | **Critique** — flux financier | Direction + juriste | Avant P1 |
| **A-05** | Taux de commission et grille d'abonnements | Élevé | Direction | Avant P1 |
| **A-06** | Nom de marque unique (AdkCars vs AutoKonnect) | Moyen — store, SEO | Direction | Avant P1 |
| **A-07** | iOS en v1 ou reporté en P3 | **Élevé** — coût et délai | Direction | Avant P1 |
| **A-08** | Langues de la v1 (FR seul ou FR+EN) | Moyen | Direction | Avant P1 |
| **A-09** | Back-office unique à rôles ou 3 applications séparées | **Élevé** — écart de coût majeur | Direction | Avant P0 |
| **A-10** | Prestataire cloud + localisation des données | Moyen | Direction | Avant P0 |
| **A-11** | Prestataires SMS, e-mail, WhatsApp | Moyen | Technique | Avant P1 |
| **A-12** | Niveau d'engagement d'accessibilité (AA ?) | Moyen | Direction | Avant P1 |
| **A-13** | Périmètre exact de P4 (IA, multi-pays, longue durée) | Élevé | Direction | Avant P3 |
| **A-14** | Ordre d'entrée des pays de phase 2 | Moyen | Direction | Avant P4 |
| **A-15** | Budget cible et modèle de financement | **Critique** | Direction | Avant P0 |
| **A-16** | Formalisation juridique des agréments, assurances et protection des données | **Critique** | Direction + juriste | Avant mise en production |

---

## 20. Traçabilité vis-à-vis du CDC v1

Ce tableau permet de vérifier qu'aucune exigence du document initial n'a été perdue, et d'en expliquer la réorientation.

| § CDC v1 | Contenu | Disposition en v2 | Justification |
|---|---|---|---|
| 1 | Présentation du projet | §2 | Conservé, enrichi |
| 2 | Public cible | §5.1–5.2 | Conservé, structuré en personas |
| 3 | Pays ciblé | §2.5, F-100 | Conservé |
| 4 | Types de véhicules | §6.2, modèle `vehicle_category` | Conservé ; **engins de chantier et camions reportés** (modèles métier spécifiques) |
| 5 | Plateformes (web, Android, iOS, dashboards) | §6.10–6.11, **A-09** | **Divergence assumée** : back-office unique à rôles ; iOS reporté en P3 (**A-07**) |
| 6 | Architecture (BD unique, temps réel) | §10 | Conservé ; temps réel restreint |
| 7 | Gestion des comptes | §6.1, §7.1 | Conservé, priorisé |
| 8 | Profils utilisateurs | §5.2–5.3 | Conservé, enrichi de la matrice de permissions |
| 9 | Recherche de véhicules | §6.2, §7.3 | Conservé |
| 10 | Fiche véhicule | §6.2 (F-10 à F-11) | Conservé |
| 11 | Calendrier | §6.3, §8.6 | Conservé |
| 12 | Réservation | §6.3, §7.4, **§8.1** | **Enrichci** : machine à états et règles de chevauchement ajoutés |
| 13 | Paiement | §6.4, §4.2, **§14.2–14.3** | **Corrigé** : PSP local substituted à Stripe ; Mobile Money detailé |
| 14 | Contrat numérique | §6.5, §14.1 | Conservé |
| 15 | Notifications | §6.7, §14.5 | Conservé, stratégie de repli ajoutée |
| 16 | Messagerie | §6.7 (F-59, F-60) | Conservé |
| 17 | Géolocalisation | §6.8, §14.4 | Conservé, **contrôle de coût ajouté** |
| 18 | Avis | §6.6, §7.6 | Conservé |
| 19 | Tableau de bord / statistiques | §6.10, §7.8 | Conservé |
| 20 | Administration | §6.10 | Conservé |
| 21 | Monétisation SaaS | **§4.1, §4.4** | **Enrichci** : taux, grille, flux financier |
| 22 | Sécurité | **§12**, §3.2 | **Enrichci** ; **RGPD remplacé par le régime ivoirien** (§3.2) |
| 23 | Technologies souhaitées | §10.2 | Conservé + **composants manquants ajoutés** |
| 24 | Hébergement | §15.2, §14.6 | Conservé, **A-10** |
| 25 | Performances | **§11** | **Enrichci** : NFR chiffrées par condition de réseau |
| 26 | Intelligence artificielle | §6.13 | **Reporté en P4 (COULD)** |
| 27 | Fonctionnalités futures | §2.6, §6.13 | **Reporté** hors version 2 |
| 28 | Livrables attendus | §17 | Conservé, enrichi (L-01 à L-20) |
| 29 | Exigences de qualité | §10.6, §11.7 | Conservé, **rendu vérifiable** |
| 30 | Vision | §2.4 | Conservé |

**Bilan :** 30 sections reprises, **1 corrigée** (paiement), **2 enrichies** (sécurité, performance), **3 reportées** (IA, futures, iOS/back-office), **5 chapitres ajoutés** (légal, économique, règles métier, modèle de données, intégrations).

---

## 21. Glossaire

| Terme | Définition |
|---|---|
| **Agence** | Fournisseur professionnel exploitant plusieurs véhicules et des collaborateurs |
| **Arbitrage** | Décision à prendre, listée au chapitre 19 |
| **Caution** | Montant bloqué chez le client, restitué ou capturé après restitution |
| **Chevauchement** | Conflit entre deux réservations selon la règle §8.2 |
| **CNDP** | Commission Nationale de la Protection des Données (autorité ivoirienne) |
| **Commission** | Pourcentage prélevé par la plateforme sur une location |
| **DC** | Document de conception |
| **Escrow (compte d'attente)** | Fonds conservés jusqu'à satisfaction d'une condition |
| **Fournisseur** | Entité propriétaire du véhicule : agence ou propriétaire particulier |
| **Litige** | Contestation d'un damage, d'un montant ou d'une restitution |
| **MoSCoW** | Méthode de priorisation : Must, Should, Could, Won't |
| **NFR** | Exigence non fonctionnelle (performance, disponibilité, sécurité) |
| **PSP** | Prestataire de service de paiement |
| **RCA** | Responsabilité Civile Automobile (assurance obligatoire) |
| **RPO / RTO** | Perte de données maximale tolérée / délai maximal de remise en service |
| **Slug** | Identifiant lisible d'une ressource dans une URL |
| **Take rate** | Ratio du revenu de commission sur le volume d'affaires total |
| **Webhook** | Callback HTTP envoyé par un tiers pour notifier un événement |
| **XOF** | Franc CFA, devise de la zone UEMOA |

---

## Annexe A — Documents à produire en P0

1. ADR-001 — Monorepo et stratégie des langages
2. ADR-002 — Back-office : application unique ou séparée (**dépend de A-09**)
3. ADR-003 — Moteur de recherche : PostgreSQL FTS ou moteur dédié
4. ADR-004 — Stratégie temps réel : WebSocket ou polling
5. ADR-005 — Modèle de commission et périmètre comptable
6. ADR-006 — Stratégie multi-devises et multi-pays
7. ADR-007 — Politique de rétention et de purge des données
8. ADR-008 — Sélection du PSP et abstraction paiement

## Annexe B — Checklist de lancement (avant mise en production)

- [ ] Agréments et assurances obtenus et vérifiés
- [ ] Validation juridique du modèle financier et du statut de l'entité
- [ ] Avis de conformité et protection des données obtenu `[À CONFIRMER]`
- [ ] CGU, CGV et politique de confidentialité publiés
- [ ] Contrat numérique testé et validé juridiquement
- [ ] Domaine configuré (SPF, DKIM, DMARC), e-mail transactionnel en production
- [ ] Sauvegardes automatiques testées et restauration validée
- [ ] Supervision et alertes actives, contact d'astreinte défini
- [ ] Équipe de support et procédure d'escalade en place
- [ ] Équipe pilote recruited et formed
- [ ] Conditions financières et pensions de caution validées en test

## Annexe C — Journal des changements

| Version | Date | Auteur | Modification |
|---|---|---|---|
| 1.0 | 2026-08-02 | — | Document initial (30 sections, liste de fonctionnalités) |
| 2.0 | 2026-10-02 | Équipe projet | Restructuration en phases, priorisation MoSCoW, ajout des chapitres 3, 4, 8, 9, 14, 16, 18, 19, 20 ; correction du volet paiement et du volet juridique ; NFR chiffrées ; plan de livraison |

---

*Fin du cahier des charges — AdkCars CI v2.0 — Document de travail à valider par le commanditaire.*
