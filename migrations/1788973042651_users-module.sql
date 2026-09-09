-- Up Migration

-- 1. A session could not be revoked, only outlived
--
-- Accounts are soft-deleted: `deleted_at` is set and `uq_users_email_live` frees the
-- address. What that does not do is end the session the person is already holding. Sessions
-- are stateless JWTs and nothing re-reads the database on a verified one, so a dismissed
-- employee keeps a working token for the rest of its seven days, and the only lever is
-- rotating JWT_SECRET -- which signs everybody out, not the one account.
--
-- That was tolerable while there was no way to delete a user over HTTP. This increment adds
-- one, and an endpoint that reports success while leaving the account usable is worse than
-- no endpoint at all.
--
-- Rejected: a shorter TOKEN_TTL. It shortens the window, it does not close it, and it pays
-- for that with a login every few hours for everyone. Rejected too: a revocation list or a
-- sessions table -- both are a second store to keep, and neither is needed when the users
-- row is already being read.
--
-- A counter, not a timestamp. `token_version` is compared for equality against the claim
-- the token carries, so it needs no clock and no tolerance for skew; bumping it invalidates
-- every token minted before the bump, which is exactly the intent. NOT NULL DEFAULT 0 so
-- every existing row answers the comparison without a backfill.
--
-- The cost, stated because it is a reversal: verifyToken() now reads `users` on every
-- authenticated request, where before it read nothing and requireRole() was free. One
-- primary-key lookup at dozens of users and low concurrency is the right price, and it buys
-- more than revocation -- role and area stop being up to seven days stale, because the same
-- read supplies them. RF-USR-01 and RF-USR-02 put the account lifecycle in coordination's
-- hands; a lifecycle that takes a week to take effect is not one.

ALTER TABLE users ADD COLUMN token_version integer NOT NULL DEFAULT 0;


-- 2. The avatar goes back onto the row
--
-- `schema-proofing` §6 replaced `avatar_url text` with `avatar_file_id bigint REFERENCES
-- files (id)`, so a profile picture would be one more object in the content-addressed
-- store. That is the better model and it is not reversed here on its merits: the store is
-- written but not wired -- nothing calls openVolumes() -- and connecting it is I8, a whole
-- increment away. Blocking the users module on it would trade a working feature for an
-- ordering preference.
--
-- So the bytes go on the row. A profile picture is small, bounded and read exactly when its
-- user is, which is the one case where the argument for the file store is weakest.
--
-- `avatar_file_id` is dropped rather than kept alongside. Two columns for one fact is
-- precisely the failure schema-proofing existed to fix -- area leadership living in three
-- places, none of which agreed -- and leaving an unused nullable column behind is how the
-- next person discovers there are two ways to set an avatar and picks the wrong one.
-- Nothing reads or writes it today, so nothing is lost.
--
-- When I8 wires the store, the honest path back is the Down of this migration: re-add
-- `avatar_file_id`, migrate the bytes into `files`, then drop `profile_picture`.
--
-- The type travels with the bytes. `files` would have carried it as a column; a bare bytea
-- does not, and bytes alone cannot tell a browser whether they are a PNG or a JPEG -- the
-- read endpoint would have to answer application/octet-stream and let the client sniff.
-- The pair is constrained the way `logs_target_complete` constrains its own: both set or
-- both null, because a picture with no type and a type with no picture are each a row that
-- no reader can use.

DROP INDEX idx_users_avatar_file_id;
ALTER TABLE users DROP COLUMN avatar_file_id;
ALTER TABLE users ADD COLUMN profile_picture bytea;
ALTER TABLE users ADD COLUMN profile_picture_mime varchar(100);

ALTER TABLE users ADD CONSTRAINT users_profile_picture_complete
    CHECK (num_nonnulls(profile_picture, profile_picture_mime) IN (0, 2));


-- Down Migration
--
-- Lossy on the picture bytes, and it has to be: there is nowhere to put them once the
-- column is gone. Said plainly rather than discovered.

ALTER TABLE users DROP CONSTRAINT users_profile_picture_complete;
ALTER TABLE users DROP COLUMN profile_picture_mime;
ALTER TABLE users DROP COLUMN profile_picture;
ALTER TABLE users ADD COLUMN avatar_file_id bigint REFERENCES files (id);
CREATE INDEX idx_users_avatar_file_id ON users (avatar_file_id);

ALTER TABLE users DROP COLUMN token_version;
