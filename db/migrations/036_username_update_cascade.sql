-- Username renames (admin rename, and the new self-service profile rename) set
-- users.username, which is the PK every per-user table references. Several of
-- those FKs were created without ON UPDATE CASCADE, so a rename would fail with
-- a foreign-key violation for any user that has rows in them. Recreate each
-- missing FK with ON UPDATE CASCADE, preserving its original ON DELETE
-- behaviour. (shares, user_bans, file_server_links already cascade on update.)

-- api_keys.username — keep ON DELETE CASCADE.
ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_username_fkey;
ALTER TABLE api_keys
    ADD CONSTRAINT api_keys_username_fkey
    FOREIGN KEY (username) REFERENCES users (username) ON UPDATE CASCADE ON DELETE CASCADE;

-- payments.username — keep ON DELETE CASCADE.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_username_fkey;
ALTER TABLE payments
    ADD CONSTRAINT payments_username_fkey
    FOREIGN KEY (username) REFERENCES users (username) ON UPDATE CASCADE ON DELETE CASCADE;

-- storage_orders.username — keep ON DELETE CASCADE.
ALTER TABLE storage_orders DROP CONSTRAINT IF EXISTS storage_orders_username_fkey;
ALTER TABLE storage_orders
    ADD CONSTRAINT storage_orders_username_fkey
    FOREIGN KEY (username) REFERENCES users (username) ON UPDATE CASCADE ON DELETE CASCADE;

-- math_game_scores.username — keep ON DELETE CASCADE.
ALTER TABLE math_game_scores DROP CONSTRAINT IF EXISTS math_game_scores_username_fkey;
ALTER TABLE math_game_scores
    ADD CONSTRAINT math_game_scores_username_fkey
    FOREIGN KEY (username) REFERENCES users (username) ON UPDATE CASCADE ON DELETE CASCADE;

-- user_drive_allocations.user_id — no prior delete rule; add ON UPDATE CASCADE,
-- keep delete as NO ACTION (a user's allocations must be released explicitly).
ALTER TABLE user_drive_allocations DROP CONSTRAINT IF EXISTS user_drive_allocations_user_id_fkey;
ALTER TABLE user_drive_allocations
    ADD CONSTRAINT user_drive_allocations_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users (username) ON UPDATE CASCADE;

-- server_expansion_requests.username — no prior delete rule; add ON UPDATE CASCADE.
ALTER TABLE server_expansion_requests DROP CONSTRAINT IF EXISTS server_expansion_requests_username_fkey;
ALTER TABLE server_expansion_requests
    ADD CONSTRAINT server_expansion_requests_username_fkey
    FOREIGN KEY (username) REFERENCES users (username) ON UPDATE CASCADE;
