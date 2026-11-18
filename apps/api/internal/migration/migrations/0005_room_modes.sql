ALTER TABLE rooms ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'group';
ALTER TABLE rooms ADD CONSTRAINT rooms_mode_check CHECK (mode IN ('group', 'livestream'));
