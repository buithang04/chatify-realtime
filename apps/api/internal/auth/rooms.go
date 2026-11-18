package auth

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var (
	ErrRoomNotFound  = errors.New("room not found")
	ErrRoomClosed    = errors.New("room is closed")
	ErrRoomFull      = errors.New("room is full")
	ErrAlreadyMember = errors.New("already a member")
	ErrMemberKicked  = errors.New("member is kicked")
	ErrNotMember     = errors.New("not an active member")
	ErrInvalidRoom   = errors.New("invalid room")
	ErrRoomPassword  = errors.New("room password required or incorrect")
	ErrNotRoomOwner  = errors.New("room owner required")
)

type RoomInput struct {
	Name            string `json:"name"`
	MaxParticipants int    `json:"maxParticipants"`
	Mode            string `json:"mode"`
	Password        string `json:"password"`
}

type Room struct {
	ID              string    `json:"id"`
	OwnerID         string    `json:"ownerId"`
	Name            string    `json:"name"`
	MaxParticipants int       `json:"maxParticipants"`
	Status          string    `json:"status"`
	Mode            string    `json:"mode"`
	IsLocked        bool      `json:"isLocked"`
	CreatedAt       time.Time `json:"createdAt"`
}

type RoomMember struct {
	UserID      string `json:"userId"`
	DisplayName string `json:"displayName"`
	Role        string `json:"role"`
	AvatarData  string `json:"avatarData"`
}

type RecentRoom struct {
	ID                string    `json:"id"`
	Name              string    `json:"name"`
	Mode              string    `json:"mode"`
	MaxParticipants   int       `json:"maxParticipants"`
	ActiveMemberCount int       `json:"activeMemberCount"`
	IsLocked          bool      `json:"isLocked"`
	LastVisitedAt     time.Time `json:"lastVisitedAt"`
}

func (s *PostgresService) ListRecentRooms(ctx context.Context, userID string) ([]RecentRoom, error) {
	userUUID, err := uuid.Parse(userID)
	if err != nil {
		return nil, ErrRoomNotFound
	}
	rows, err := s.pool.Query(ctx, `
		SELECT r.id::text, r.name, r.mode, r.max_participants, r.password_hash IS NOT NULL,
		       count(active_member.user_id)::int, coalesce(mine.left_at, mine.joined_at)
		FROM room_members mine
		JOIN rooms r ON r.id = mine.room_id AND r.status = 'active'
		JOIN room_members active_member ON active_member.room_id = r.id AND active_member.status = 'active'
		WHERE mine.user_id = $1 AND mine.status <> 'kicked'
		GROUP BY r.id, mine.joined_at, mine.left_at
		ORDER BY coalesce(mine.left_at, mine.joined_at) DESC, r.id DESC
		LIMIT 20`, userUUID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	rooms := make([]RecentRoom, 0)
	for rows.Next() {
		var room RecentRoom
		if err := rows.Scan(&room.ID, &room.Name, &room.Mode, &room.MaxParticipants, &room.IsLocked, &room.ActiveMemberCount, &room.LastVisitedAt); err != nil {
			return nil, err
		}
		rooms = append(rooms, room)
	}
	return rooms, rows.Err()
}

func (s *PostgresService) ListRoomMembers(ctx context.Context, userID, roomID string) ([]RoomMember, error) {
	roomUUID, err := uuid.Parse(roomID)
	if err != nil {
		return nil, ErrRoomNotFound
	}
	active, err := s.IsActiveMember(ctx, userID, roomID)
	if err != nil {
		return nil, err
	}
	if !active {
		return nil, ErrNotMember
	}
	rows, err := s.pool.Query(ctx, `
		SELECT m.user_id::text, u.display_name, m.role, u.avatar_data
		FROM room_members m JOIN users u ON u.id = m.user_id
		WHERE m.room_id = $1 AND m.status = 'active'
		ORDER BY CASE WHEN m.role = 'owner' THEN 0 ELSE 1 END, m.joined_at, m.user_id
		LIMIT 1000`, roomUUID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	members := make([]RoomMember, 0)
	for rows.Next() {
		var member RoomMember
		if err := rows.Scan(&member.UserID, &member.DisplayName, &member.Role, &member.AvatarData); err != nil {
			return nil, err
		}
		members = append(members, member)
	}
	return members, rows.Err()
}

func ValidateRoomInput(input RoomInput) (RoomInput, error) {
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" || len([]rune(input.Name)) > 120 {
		return RoomInput{}, ErrInvalidRoom
	}
	if input.MaxParticipants == 0 {
		input.MaxParticipants = 4
	}
	if input.MaxParticipants < 2 || input.MaxParticipants > 1000 {
		return RoomInput{}, ErrInvalidRoom
	}
	if input.Mode == "" {
		input.Mode = "group"
	}
	if input.Mode != "group" && input.Mode != "livestream" {
		return RoomInput{}, ErrInvalidRoom
	}
	if input.Password != "" && (len([]rune(input.Password)) < 6 || len([]byte(input.Password)) > 72) {
		return RoomInput{}, ErrInvalidRoom
	}
	return input, nil
}

func (s *PostgresService) CreateRoom(ctx context.Context, ownerID string, input RoomInput) (Room, error) {
	input, err := ValidateRoomInput(input)
	if err != nil {
		return Room{}, err
	}
	ownerUUID, err := uuid.Parse(ownerID)
	if err != nil {
		return Room{}, ErrInvalidRoom
	}
	var passwordHash *string
	if input.Password != "" {
		hash, hashErr := HashPassword(input.Password)
		if hashErr != nil {
			return Room{}, hashErr
		}
		passwordHash = &hash
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Room{}, err
	}
	defer tx.Rollback(ctx)
	var room Room
	err = tx.QueryRow(ctx, `
		INSERT INTO rooms (owner_id, name, max_participants, mode, password_hash)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id::text, owner_id::text, name, max_participants, status, mode, created_at`, ownerUUID, input.Name, input.MaxParticipants, input.Mode, passwordHash).
		Scan(&room.ID, &room.OwnerID, &room.Name, &room.MaxParticipants, &room.Status, &room.Mode, &room.CreatedAt)
	if err != nil {
		return Room{}, err
	}
	room.IsLocked = passwordHash != nil
	if _, err := tx.Exec(ctx, `INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'owner')`, room.ID, ownerUUID); err != nil {
		return Room{}, err
	}
	payload, err := json.Marshal(room)
	if err != nil {
		return Room{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
		VALUES ('room', $1, 'room.created', $2::jsonb)`, room.ID, payload); err != nil {
		return Room{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Room{}, err
	}
	return room, nil
}

func (s *PostgresService) JoinRoom(ctx context.Context, userID, roomID string) (Room, error) {
	return s.JoinRoomWithPassword(ctx, userID, roomID, "")
}

func (s *PostgresService) JoinRoomWithPassword(ctx context.Context, userID, roomID, password string) (Room, error) {
	userUUID, err := uuid.Parse(userID)
	if err != nil {
		return Room{}, ErrRoomNotFound
	}
	roomUUID, err := uuid.Parse(roomID)
	if err != nil {
		return Room{}, ErrRoomNotFound
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Room{}, err
	}
	defer tx.Rollback(ctx)
	var room Room
	var passwordHash *string
	err = tx.QueryRow(ctx, `
		SELECT id::text, owner_id::text, name, max_participants, status, mode, created_at, password_hash
		FROM rooms WHERE id = $1 FOR UPDATE`, roomUUID).
		Scan(&room.ID, &room.OwnerID, &room.Name, &room.MaxParticipants, &room.Status, &room.Mode, &room.CreatedAt, &passwordHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return Room{}, ErrRoomNotFound
	}
	if err != nil {
		return Room{}, err
	}
	if room.Status != "active" {
		return Room{}, ErrRoomClosed
	}
	room.IsLocked = passwordHash != nil
	var memberStatus string
	err = tx.QueryRow(ctx, `SELECT status FROM room_members WHERE room_id = $1 AND user_id = $2`, roomUUID, userUUID).Scan(&memberStatus)
	if err == nil && memberStatus == "active" {
		return room, nil
	}
	if err == nil && memberStatus == "kicked" {
		return Room{}, ErrMemberKicked
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Room{}, err
	}
	if passwordHash != nil && !VerifyPassword(*passwordHash, password) {
		return Room{}, ErrRoomPassword
	}
	var activeCount int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM room_members WHERE room_id = $1 AND status = 'active'`, roomUUID).Scan(&activeCount); err != nil {
		return Room{}, err
	}
	if activeCount >= room.MaxParticipants {
		return Room{}, ErrRoomFull
	}
	if err == nil {
		_, err = tx.Exec(ctx, `UPDATE room_members SET status = 'active', joined_at = now(), left_at = NULL, role = CASE WHEN user_id = $3 THEN 'owner' ELSE 'participant' END WHERE room_id = $1 AND user_id = $2`, roomUUID, userUUID, room.OwnerID)
	} else if errors.Is(err, pgx.ErrNoRows) {
		_, err = tx.Exec(ctx, `INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'participant')`, roomUUID, userUUID)
	}
	if err != nil {
		return Room{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Room{}, err
	}
	return room, nil
}

// SetRoomPassword serializes with joins through the same room row lock.
// Source: https://www.postgresql.org/docs/16/explicit-locking.html#LOCKING-ROWS
func (s *PostgresService) SetRoomPassword(ctx context.Context, userID, roomID, password string) (bool, error) {
	if password != "" && (len([]rune(password)) < 6 || len([]byte(password)) > 72) {
		return false, ErrInvalidRoom
	}
	owner, err := uuid.Parse(userID)
	if err != nil {
		return false, ErrNotRoomOwner
	}
	room, err := uuid.Parse(roomID)
	if err != nil {
		return false, ErrRoomNotFound
	}
	var hash *string
	if password != "" {
		value, err := HashPassword(password)
		if err != nil {
			return false, err
		}
		hash = &value
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	var actualOwner uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT owner_id FROM rooms WHERE id = $1 AND status = 'active' FOR UPDATE`, room).Scan(&actualOwner); errors.Is(err, pgx.ErrNoRows) {
		return false, ErrRoomNotFound
	} else if err != nil {
		return false, err
	}
	if actualOwner != owner {
		return false, ErrNotRoomOwner
	}
	if _, err := tx.Exec(ctx, `UPDATE rooms SET password_hash = $2 WHERE id = $1`, room, hash); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return hash != nil, nil
}

type MediaPolicy struct {
	RoomID      string `json:"roomId"`
	Mode        string `json:"mode"`
	Role        string `json:"role"`
	CanPublish  bool   `json:"canPublish"`
	CanConsume  bool   `json:"canConsume"`
	CanModerate bool   `json:"canModerate"`
}

func (s *PostgresService) MediaPolicy(ctx context.Context, userID, roomID string) (MediaPolicy, error) {
	userUUID, err := uuid.Parse(userID)
	if err != nil {
		return MediaPolicy{}, ErrRoomNotFound
	}
	roomUUID, err := uuid.Parse(roomID)
	if err != nil {
		return MediaPolicy{}, ErrRoomNotFound
	}
	var policy MediaPolicy
	err = s.pool.QueryRow(ctx, `
		SELECT r.id::text, r.mode, rm.role
		FROM rooms r JOIN room_members rm ON rm.room_id = r.id
		WHERE r.id = $1 AND rm.user_id = $2 AND rm.status = 'active'`, roomUUID, userUUID).
		Scan(&policy.RoomID, &policy.Mode, &policy.Role)
	if errors.Is(err, pgx.ErrNoRows) {
		return MediaPolicy{}, ErrRoomNotFound
	}
	if err != nil {
		return MediaPolicy{}, err
	}
	policy.CanConsume = true
	policy.CanModerate = policy.Role == "owner" || policy.Role == "moderator"
	policy.CanPublish = policy.Mode == "group" || policy.CanModerate
	return policy, nil
}

func (s *PostgresService) LeaveRoom(ctx context.Context, userID, roomID string) error {
	userUUID, err := uuid.Parse(userID)
	if err != nil {
		return ErrNotMember
	}
	roomUUID, err := uuid.Parse(roomID)
	if err != nil {
		return ErrNotMember
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var ownerUUID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT owner_id FROM rooms WHERE id = $1 FOR UPDATE`, roomUUID).Scan(&ownerUUID); errors.Is(err, pgx.ErrNoRows) {
		return ErrNotMember
	} else if err != nil {
		return err
	}
	result, err := tx.Exec(ctx, `UPDATE room_members SET status = 'left', left_at = now(), role = CASE WHEN role = 'owner' THEN 'participant' ELSE role END WHERE room_id = $1 AND user_id = $2 AND status = 'active'`, roomUUID, userUUID)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return ErrNotMember
	}
	if userUUID == ownerUUID {
		var successorUUID uuid.UUID
		err = tx.QueryRow(ctx, `
			SELECT user_id FROM room_members
			WHERE room_id = $1 AND status = 'active'
			ORDER BY CASE WHEN role = 'moderator' THEN 0 ELSE 1 END, joined_at, user_id
			LIMIT 1`, roomUUID).Scan(&successorUUID)
		if errors.Is(err, pgx.ErrNoRows) {
			_, err = tx.Exec(ctx, `UPDATE rooms SET status = 'ended', ended_at = now() WHERE id = $1`, roomUUID)
		} else if err == nil {
			_, err = tx.Exec(ctx, `UPDATE room_members SET role = 'owner' WHERE room_id = $1 AND user_id = $2`, roomUUID, successorUUID)
			if err == nil {
				_, err = tx.Exec(ctx, `UPDATE rooms SET owner_id = $2 WHERE id = $1`, roomUUID, successorUUID)
			}
		}
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *PostgresService) IsActiveMember(ctx context.Context, userID, roomID string) (bool, error) {
	userUUID, err := uuid.Parse(userID)
	if err != nil {
		return false, ErrRoomNotFound
	}
	roomUUID, err := uuid.Parse(roomID)
	if err != nil {
		return false, ErrRoomNotFound
	}
	var active bool
	err = s.pool.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM room_members
			WHERE room_id = $1 AND user_id = $2 AND status = 'active'
		)`, roomUUID, userUUID).Scan(&active)
	return active, err
}
