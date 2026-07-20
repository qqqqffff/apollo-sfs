-- Tracks notification-bell items a user has dismissed. Notification items
-- themselves are derived on every request from live tables (see
-- Handler.Notifications) rather than stored, so dismissal is just a
-- per-user denylist of notification IDs (which are stable: derived from the
-- underlying entity's UUID plus a kind suffix, e.g. "<uuid>:email-received").
CREATE TABLE IF NOT EXISTS dismissed_notifications (
    username        TEXT        NOT NULL REFERENCES users (username) ON UPDATE CASCADE ON DELETE CASCADE,
    notification_id TEXT        NOT NULL,
    dismissed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (username, notification_id)
);
