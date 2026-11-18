CREATE TABLE IF NOT EXISTS direct_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES users(id),
    recipient_id UUID NOT NULL REFERENCES users(id),
    client_message_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (room_id, sender_id, client_message_id),
    CHECK (sender_id <> recipient_id),
    CHECK (char_length(client_message_id) BETWEEN 1 AND 128),
    CHECK (char_length(body) BETWEEN 1 AND 4000)
);

CREATE INDEX IF NOT EXISTS idx_direct_messages_room_pair_created
    ON direct_messages (room_id, sender_id, recipient_id, created_at DESC, id DESC);
