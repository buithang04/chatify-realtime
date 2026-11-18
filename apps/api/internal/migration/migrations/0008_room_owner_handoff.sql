-- Repair rooms whose creator left before ownership transfer existed.
WITH successors AS (
    SELECT DISTINCT ON (r.id) r.id AS room_id, m.user_id
    FROM rooms r
    JOIN room_members m ON m.room_id = r.id AND m.status = 'active'
    WHERE r.status = 'active'
      AND NOT EXISTS (
          SELECT 1 FROM room_members owner_member
          WHERE owner_member.room_id = r.id AND owner_member.user_id = r.owner_id AND owner_member.status = 'active'
      )
    ORDER BY r.id, CASE WHEN m.role = 'moderator' THEN 0 ELSE 1 END, m.joined_at, m.user_id
)
UPDATE rooms r SET owner_id = s.user_id
FROM successors s WHERE r.id = s.room_id;

UPDATE room_members m SET role = 'participant'
FROM rooms r
WHERE m.room_id = r.id AND m.role = 'owner' AND m.user_id <> r.owner_id;

UPDATE room_members m SET role = 'owner'
FROM rooms r
WHERE m.room_id = r.id AND m.user_id = r.owner_id AND m.status = 'active' AND m.role <> 'owner';

UPDATE rooms r SET status = 'ended', ended_at = now()
WHERE r.status = 'active'
  AND NOT EXISTS (SELECT 1 FROM room_members m WHERE m.room_id = r.id AND m.status = 'active');

CREATE UNIQUE INDEX IF NOT EXISTS idx_room_members_one_active_owner
ON room_members (room_id) WHERE status = 'active' AND role = 'owner';
