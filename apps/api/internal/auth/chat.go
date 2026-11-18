package auth

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var ErrInvalidMessage = errors.New("invalid chat message")

type ChatMessageInput struct {
	ClientMessageID string `json:"clientMessageId"`
	Body            string `json:"body"`
}

type ChatMessage struct {
	ID              string    `json:"id"`
	RoomID          string    `json:"roomId"`
	SenderID        string    `json:"senderId"`
	ClientMessageID string    `json:"clientMessageId"`
	Body            string    `json:"body"`
	CreatedAt       time.Time `json:"createdAt"`
}

func ValidateChatMessageInput(input ChatMessageInput) (ChatMessageInput, error) {
	input.ClientMessageID = strings.TrimSpace(input.ClientMessageID)
	input.Body = strings.TrimSpace(input.Body)
	if input.ClientMessageID == "" || len([]rune(input.ClientMessageID)) > 128 {
		return ChatMessageInput{}, ErrInvalidMessage
	}
	if input.Body == "" || len([]rune(input.Body)) > 4000 {
		return ChatMessageInput{}, ErrInvalidMessage
	}
	return input, nil
}

func (s *PostgresService) SendMessage(ctx context.Context, userID, roomID string, input ChatMessageInput) (ChatMessage, error) {
	input, err := ValidateChatMessageInput(input)
	if err != nil {
		return ChatMessage{}, err
	}
	userUUID, err := uuid.Parse(userID)
	if err != nil {
		return ChatMessage{}, ErrNotMember
	}
	roomUUID, err := uuid.Parse(roomID)
	if err != nil {
		return ChatMessage{}, ErrNotMember
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ChatMessage{}, err
	}
	defer tx.Rollback(ctx)
	var message ChatMessage
	err = tx.QueryRow(ctx, `
		INSERT INTO chat_messages (room_id, sender_id, client_message_id, body)
		SELECT $1, $2, $3, $4
		WHERE EXISTS (
			SELECT 1 FROM room_members
			WHERE room_id = $1 AND user_id = $2 AND status = 'active'
		)
		ON CONFLICT (room_id, sender_id, client_message_id) DO NOTHING
		RETURNING id::text, room_id::text, sender_id::text, client_message_id, body, created_at`,
		roomUUID, userUUID, input.ClientMessageID, input.Body).
		Scan(&message.ID, &message.RoomID, &message.SenderID, &message.ClientMessageID, &message.Body, &message.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(ctx, `
			SELECT id::text, room_id::text, sender_id::text, client_message_id, body, created_at
			FROM chat_messages WHERE room_id = $1 AND sender_id = $2 AND client_message_id = $3`,
			roomUUID, userUUID, input.ClientMessageID).
			Scan(&message.ID, &message.RoomID, &message.SenderID, &message.ClientMessageID, &message.Body, &message.CreatedAt)
		if err != nil {
			return ChatMessage{}, err
		}
	} else if err != nil {
		return ChatMessage{}, err
	} else {
		payload, marshalErr := json.Marshal(message)
		if marshalErr != nil {
			return ChatMessage{}, marshalErr
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
			VALUES ('chat_message', $1, 'chat.message.created', $2::jsonb)`, message.ID, payload); err != nil {
			return ChatMessage{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return ChatMessage{}, err
	}
	return message, nil
}

func (s *PostgresService) ListMessages(ctx context.Context, userID, roomID string, limit int, before *time.Time) ([]ChatMessage, error) {
	if limit < 1 || limit > 100 {
		return nil, ErrInvalidMessage
	}
	userUUID, err := uuid.Parse(userID)
	if err != nil {
		return nil, ErrNotMember
	}
	roomUUID, err := uuid.Parse(roomID)
	if err != nil {
		return nil, ErrNotMember
	}
	var member bool
	if err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2 AND status = 'active')`, roomUUID, userUUID).Scan(&member); err != nil {
		return nil, err
	}
	if !member {
		return nil, ErrNotMember
	}
	query := `
		SELECT cm.id::text, cm.room_id::text, cm.sender_id::text, cm.client_message_id, cm.body, cm.created_at
		FROM chat_messages cm
		WHERE cm.room_id = $1`
	args := []any{roomUUID}
	if before != nil {
		query += " AND cm.created_at < $2"
		args = append(args, *before)
	}
	query += " ORDER BY cm.created_at DESC, cm.id DESC LIMIT $" + strconv.Itoa(len(args)+1)
	args = append(args, limit)
	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	messages := make([]ChatMessage, 0, limit)
	for rows.Next() {
		var message ChatMessage
		if err := rows.Scan(&message.ID, &message.RoomID, &message.SenderID, &message.ClientMessageID, &message.Body, &message.CreatedAt); err != nil {
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
