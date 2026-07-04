-- Balance reminder cadence + email attachments:
--   * reminders_sent counts the remaining-balance reminder emails sent for an
--     'expanded' request. Three go out on a calendar-day schedule: 7 days
--     after the balance came due, 7 days before the 30-day revert, and 1 day
--     before the revert.
--   * email_queue.attachments carries optional MIME attachments as
--     [{"filename","mime_type","content_b64"}] (used for invoice PDFs).

ALTER TABLE server_expansion_requests
    ADD COLUMN IF NOT EXISTS reminders_sent SMALLINT NOT NULL DEFAULT 0;

-- Requests that already received the single legacy reminder count as 1.
UPDATE server_expansion_requests
SET reminders_sent = 1
WHERE reminder_sent_at IS NOT NULL AND reminders_sent = 0;

ALTER TABLE email_queue
    ADD COLUMN IF NOT EXISTS attachments JSONB;
