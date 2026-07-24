-- Admin-invite Premium trial expiry: mirrors users.premium_expires_at
-- (migration 058, the admin Users page's role editor) so a "grant premium"
-- invitation can carry the same optional trial expiry, applied to the new
-- user's premium_expires_at at registration time (see
-- AuthService.provisionInvitedAppUser). Null means either not granting
-- premium, or granting it permanently.
ALTER TABLE invitations
    ADD COLUMN IF NOT EXISTS premium_expires_at TIMESTAMPTZ;
