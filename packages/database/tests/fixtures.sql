-- ===================================================================
-- Donnees de reference minimales pour les tests de commission.
-- Ce fichier n'est PAS une migration : il alimente les tests uniquement.
-- ===================================================================

INSERT INTO country (code, name, phone_code, default_currency, timezone, is_active)
VALUES ('CI', 'Cote d''Ivoire', '+225', 'XOF', 'Africa/Abidjan', true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO currency (code, name, symbol, minor_units)
VALUES ('XOF', 'Franc CFA', 'FCFA', 0)
ON CONFLICT (code) DO NOTHING;

INSERT INTO vehicle_category (slug, label)
VALUES ('berline', 'Berline'), ('suv', 'SUV'), ('citadine', 'Citadine')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO "user" (email, phone, status, roles, phone_verified_at)
VALUES ('client@test.ci', '+2250700000001', 'active', '{client}', now()),
       ('owner2@test.ci', '+2250700000002', 'active', '{owner}', now())
ON CONFLICT (email) DO NOTHING;