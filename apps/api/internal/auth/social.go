package auth

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"image/jpeg"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var ErrFriendNotFound = errors.New("friendship not found")
var ErrFriendRequest = errors.New("friend request cannot be accepted")

type ProfileInput struct {
	DisplayName string `json:"displayName"`
	AvatarData  string `json:"avatarData"`
}

// Avatars are small, browser-resized JPEGs. Decoding and checking dimensions
// prevents arbitrary data URIs or active SVG content from entering profile UI.
func ValidateProfile(input ProfileInput) (ProfileInput, error) {
	input.DisplayName = strings.TrimSpace(input.DisplayName)
	if input.DisplayName == "" || utf8.RuneCountInString(input.DisplayName) > 80 {
		return ProfileInput{}, ErrInvalidInput
	}
	if input.AvatarData == "" {
		return input, nil
	}
	const prefix = "data:image/jpeg;base64,"
	if !strings.HasPrefix(input.AvatarData, prefix) || len(input.AvatarData) > 140000 {
		return ProfileInput{}, ErrInvalidInput
	}
	data, err := base64.StdEncoding.Strict().DecodeString(strings.TrimPrefix(input.AvatarData, prefix))
	if err != nil || len(data) > 100000 {
		return ProfileInput{}, ErrInvalidInput
	}
	config, err := jpeg.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width < 1 || config.Height < 1 || config.Width > 512 || config.Height > 512 {
		return ProfileInput{}, ErrInvalidInput
	}
	return input, nil
}

func (s *PostgresService) GetProfile(ctx context.Context, userID string) (PublicUser, error) {
	var user PublicUser
	err := s.pool.QueryRow(ctx, `SELECT id::text, email, display_name, avatar_data, created_at FROM users WHERE id = $1`, userID).
		Scan(&user.ID, &user.Email, &user.DisplayName, &user.AvatarData, &user.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return PublicUser{}, ErrInvalidInput
	}
	return user, err
}

func (s *PostgresService) UpdateProfile(ctx context.Context, userID string, input ProfileInput) (PublicUser, error) {
	input, err := ValidateProfile(input)
	if err != nil {
		return PublicUser{}, err
	}
	var user PublicUser
	err = s.pool.QueryRow(ctx, `UPDATE users SET display_name = $2, avatar_data = $3 WHERE id = $1 RETURNING id::text, email, display_name, avatar_data, created_at`, userID, input.DisplayName, input.AvatarData).
		Scan(&user.ID, &user.Email, &user.DisplayName, &user.AvatarData, &user.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return PublicUser{}, ErrInvalidInput
	}
	return user, err
}

type Friend struct {
	UserID      string    `json:"userId"`
	Email       string    `json:"email"`
	DisplayName string    `json:"displayName"`
	AvatarData  string    `json:"avatarData"`
	Status      string    `json:"status"`
	CreatedAt   time.Time `json:"createdAt"`
}

func (s *PostgresService) ListFriends(ctx context.Context, userID string) ([]Friend, error) {
	rows, err := s.pool.Query(ctx, `SELECT u.id::text, u.email, u.display_name, u.avatar_data,
		CASE WHEN f.status = 'accepted' THEN 'accepted' WHEN f.requested_by = $1 THEN 'pending_outgoing' ELSE 'pending_incoming' END,
		f.created_at FROM friendships f JOIN users u ON u.id = CASE WHEN f.user_low = $1 THEN f.user_high ELSE f.user_low END
		WHERE f.user_low = $1 OR f.user_high = $1 ORDER BY f.created_at DESC LIMIT 200`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	friends := make([]Friend, 0)
	for rows.Next() {
		var friend Friend
		if err := rows.Scan(&friend.UserID, &friend.Email, &friend.DisplayName, &friend.AvatarData, &friend.Status, &friend.CreatedAt); err != nil {
			return nil, err
		}
		friends = append(friends, friend)
	}
	return friends, rows.Err()
}

func (s *PostgresService) RequestFriend(ctx context.Context, userID, email string) error {
	email = normalizeEmail(email)
	if !validEmail(email) {
		return ErrInvalidInput
	}
	var other string
	err := s.pool.QueryRow(ctx, `SELECT id::text FROM users WHERE email = $1`, email).Scan(&other)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrFriendNotFound
	}
	if err != nil {
		return err
	}
	if other == userID {
		return ErrInvalidInput
	}
	low, high := userID, other
	if low > high {
		low, high = high, low
	}
	_, err = s.pool.Exec(ctx, `INSERT INTO friendships (user_low, user_high, requested_by, status)
		VALUES ($1,$2,$3,'pending') ON CONFLICT (user_low,user_high) DO NOTHING`, low, high, userID)
	return err
}

func (s *PostgresService) RespondFriend(ctx context.Context, userID, otherID string, accept bool) error {
	if _, err := uuid.Parse(otherID); err != nil {
		return ErrInvalidInput
	}
	query := `DELETE FROM friendships WHERE requested_by = $2 AND status = 'pending' AND ((user_low = $1 AND user_high = $2) OR (user_high = $1 AND user_low = $2))`
	if accept {
		query = `UPDATE friendships SET status = 'accepted', updated_at = now() WHERE requested_by = $2 AND status = 'pending' AND ((user_low = $1 AND user_high = $2) OR (user_high = $1 AND user_low = $2))`
	}
	tag, err := s.pool.Exec(ctx, query, userID, otherID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrFriendRequest
	}
	return nil
}

func (s *PostgresService) RemoveFriend(ctx context.Context, userID, otherID string) error {
	if _, err := uuid.Parse(otherID); err != nil {
		return ErrInvalidInput
	}
	tag, err := s.pool.Exec(ctx, `DELETE FROM friendships WHERE (user_low = $1 AND user_high = $2) OR (user_low = $2 AND user_high = $1)`, userID, otherID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrFriendNotFound
	}
	return nil
}

type SuggestedRoom struct {
	ID                string   `json:"id"`
	Name              string   `json:"name"`
	Mode              string   `json:"mode"`
	IsLocked          bool     `json:"isLocked"`
	ActiveMemberCount int      `json:"activeMemberCount"`
	FriendNames       []string `json:"friendNames"`
}

func (s *PostgresService) ListSuggestedRooms(ctx context.Context, userID string) ([]SuggestedRoom, error) {
	rows, err := s.pool.Query(ctx, `SELECT r.id::text, r.name, r.mode, r.password_hash IS NOT NULL,
		(SELECT count(*) FROM room_members all_members WHERE all_members.room_id = r.id AND all_members.status = 'active'),
		array_agg(DISTINCT u.display_name)
		FROM friendships f
		JOIN users u ON u.id = CASE WHEN f.user_low = $1 THEN f.user_high ELSE f.user_low END
		JOIN room_members rm ON rm.user_id = u.id AND rm.status = 'active'
		JOIN rooms r ON r.id = rm.room_id AND r.status = 'active'
		WHERE f.status = 'accepted' AND (f.user_low = $1 OR f.user_high = $1)
		AND NOT EXISTS (SELECT 1 FROM room_members me WHERE me.room_id = r.id AND me.user_id = $1 AND me.status = 'active')
		GROUP BY r.id ORDER BY count(DISTINCT u.id) DESC, r.created_at DESC LIMIT 30`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	rooms := make([]SuggestedRoom, 0)
	for rows.Next() {
		var room SuggestedRoom
		if err := rows.Scan(&room.ID, &room.Name, &room.Mode, &room.IsLocked, &room.ActiveMemberCount, &room.FriendNames); err != nil {
			return nil, err
		}
		rooms = append(rooms, room)
	}
	return rooms, rows.Err()
}
