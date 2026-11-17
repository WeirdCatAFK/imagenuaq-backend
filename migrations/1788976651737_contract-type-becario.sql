-- Up Migration

-- A fifth contract scheme, for becarios.
--
-- `catalog-bootstrap` seeded the four schemes RF-AUS-02 names -- Honorarios, Eventual,
-- Base de confianza, Base sindicalizada -- and those are the four the collective contract
-- covers. Becarios are none of them: they are on a beca rather than a contract, and the
-- entitlements RF-AUS-04 versions per scheme mostly do not apply to them.
--
-- Which is exactly why this row is safe to add before anybody has said it should exist.
-- `contract_type_entitlements` is seeded empty on purpose (a guessed cap silently explains
-- consumed history against a figure that was never in force), so a scheme with no
-- entitlement rows grants nothing -- and for becarios that is close to correct rather than
-- a placeholder waiting to be discovered. If coordination later says otherwise, the fix is
-- an entitlement row per RF-AUS-04, not an edit here.
--
-- It also unblocks something ordinary: users.contract_type_id is NOT NULL, so creating an
-- account through POST /api/users requires naming a scheme, and until the caps arrive the
-- four seeded ones are all assertions about people's real conditions of employment. This
-- one is not.
--
-- Named for the scheme, as its four neighbours are, so the catalogue reads as one list.

-- The row is no longer seeded: contract types are coordination's data, entered from the app.
-- The file stays so databases that already ran it keep their migration history.


-- Down Migration
