package auth

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type DirectMessage struct {
	ChatMessage
	RecipientID string `json:"recipientId"`
}

func directMessageIDs(userID, roomID, peerID string) (uuid.UUID, uuid.UUID, uuid.UUID, error) {
	user, userErr := uuid.Parse(userID)
	room, roomErr := uuid.Parse(roomID)
	peer, peerErr := uuid.Parse(peerID)
	if userErr != nil || roomErr != nil || peerErr != nil || user == peer {
		return uuid.UUID{}, uuid.UUID{}, uuid.UUID{}, ErrInvalidMessage
	}
	return user, room, peer, nil
}

func (s *PostgresService) directPeersActive(ctx context.Context, room, user, peer uuid.UUID) (bool, error) {
	var active bool
	err := s.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM room_members
		WHERE room_id = $1 AND user_id IN ($2, $3) AND status = 'active') = 2`, room, user, peer).Scan(&active)
	return active, err
}

func (s *PostgresService) SendDirectMessage(ctx context.Context, userID, roomID, peerID string, input ChatMessageInput) (DirectMessage, error) {
	input, err := ValidateChatMessageInput(input)
	if err != nil {
		return DirectMessage{}, err
	}
	user, room, peer, err := directMessageIDs(userID, roomID, peerID)
	if err != nil {
		return DirectMessage{}, err
	}
	active, err := s.directPeersActive(ctx, room, user, peer)
	if err != nil {
		return DirectMessage{}, err
	}
	if !active {
		return DirectMessage{}, ErrNotMember
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return DirectMessage{}, err
	}
	defer tx.Rollback(ctx)
	var message DirectMessage
	err = tx.QueryRow(ctx, `INSERT INTO direct_messages (room_id, sender_id, recipient_id, client_message_id, body)
		SELECT $1, $2, $3, $4, $5 WHERE
			(SELECT count(*) FROM room_members WHERE room_id = $1 AND user_id IN ($2, $3) AND status = 'active') = 2
		ON CONFLICT (room_id, sender_id, client_message_id) DO NOTHING
		RETURNING id::text, room_id::text, sender_id::text, recipient_id::text, client_message_id, body, created_at`,
		room, user, peer, input.ClientMessageID, input.Body).
		Scan(&message.ID, &message.RoomID, &message.SenderID, &message.RecipientID, &message.ClientMessageID, &message.Body, &message.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(ctx, `SELECT id::text, room_id::text, sender_id::text, recipient_id::text, client_message_id, body, created_at
			FROM direct_messages WHERE room_id = $1 AND sender_id = $2 AND recipient_id = $3 AND client_message_id = $4`, room, user, peer, input.ClientMessageID).
			Scan(&message.ID, &message.RoomID, &message.SenderID, &message.RecipientID, &message.ClientMessageID, &message.Body, &message.CreatedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return DirectMessage{}, ErrInvalidMessage
		}
		if err != nil {
			return DirectMessage{}, err
		}
	} else if err != nil {
		return DirectMessage{}, err
	} else {
		payload, marshalErr := json.Marshal(message)
		if marshalErr != nil {
			return DirectMessage{}, marshalErr
		}
		if _, err := tx.Exec(ctx, `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
			VALUES ('direct_message', $1, 'chat.direct-message.created', $2::jsonb)`, message.ID, payload); err != nil {
			return DirectMessage{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return DirectMessage{}, err
	}
	return message, nil
}

func (s *PostgresService) ListDirectMessages(ctx context.Context, userID, roomID, peerID string, limit int, before *time.Time) ([]DirectMessage, error) {
	if limit < 1 || limit > 100 {
		return nil, ErrInvalidMessage
	}
	user, room, peer, err := directMessageIDs(userID, roomID, peerID)
	if err != nil {
		return nil, err
	}
	active, err := s.directPeersActive(ctx, room, user, peer)
	if err != nil {
		return nil, err
	}
	if !active {
		return nil, ErrNotMember
	}
	query := `SELECT id::text, room_id::text, sender_id::text, recipient_id::text, client_message_id, body, created_at
		FROM direct_messages WHERE room_id = $1 AND ((sender_id = $2 AND recipient_id = $3) OR (sender_id = $3 AND recipient_id = $2))`
	args := []any{room, user, peer}
	if before != nil {
		query += " AND created_at < $4"
		args = append(args, *before)
	}
	query += " ORDER BY created_at DESC, id DESC LIMIT $" + strconv.Itoa(len(args)+1)
	args = append(args, limit)
	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	messages := make([]DirectMessage, 0, limit)
	for rows.Next() {
		var message DirectMessage
		if err := rows.Scan(&message.ID, &message.RoomID, &message.SenderID, &message.RecipientID, &message.ClientMessageID, &message.Body, &message.CreatedAt); err != nil {
			return nil, err
		}
		messages = append(messages, message)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for left, right := 0, len(messages)-1; left < right; left, right = left+1, right-1 {
		messages[left], messages[right] = messages[right], messages[left]
	}
	return messages, nil
}
