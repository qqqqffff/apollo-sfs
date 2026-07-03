-- Add grant_admin flag to invitations so an admin can provision a new account
-- with the admin role pre-assigned at registration time.
ALTER TABLE invitations
    ADD COLUMN IF NOT EXISTS grant_admin BOOLEAN NOT NULL DEFAULT FALSE;
