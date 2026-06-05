-- Migration 012: add grant_premium flag to invitations.
-- Allows an admin to pre-assign the Keycloak "premium" realm role when the
-- invitee registers, without requiring a manual Keycloak step.

ALTER TABLE invitations
    ADD COLUMN grant_premium BOOLEAN NOT NULL DEFAULT FALSE;
