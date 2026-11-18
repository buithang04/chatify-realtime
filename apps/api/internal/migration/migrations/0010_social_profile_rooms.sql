ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_data TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD CONSTRAINT users_avatar_data_size CHECK (char_length(avatar_data) <= 140000);

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS password_hash TEXT;

CREATE TABLE friendships (
    user_low UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_high UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_low, user_high),
    CHECK (user_low < user_high),
    CHECK (requested_by IN (user_low, user_high))
);
CREATE INDEX friendships_high_status ON friendships (user_high, status);

CREATE TABLE friend_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_message_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (sender_id, client_message_id),
    CHECK (sender_id <> recipient_id),
    CHECK (char_length(client_message_id) BETWEEN 1 AND 128),
    CHECK (char_length(body) BETWEEN 1 AND 4000)
);
CREATE INDEX friend_messages_pair_created ON friend_messages (sender_id, recipient_id, created_at DESC, id DESC);
