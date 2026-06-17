-- Allow admins to pre-assign a drive when creating an invitation.
-- When set, registration allocates the user to this specific drive instead of
-- auto-selecting via SelectDriveForQuota.

ALTER TABLE invitations
    ADD COLUMN initial_drive_id UUID REFERENCES drives(id) ON DELETE SET NULL;
