package auth

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type FriendMessage struct {
	ID              string    `json:"id"`
	SenderID        string    `json:"senderId"`
	RecipientID     string    `json:"recipientId"`
	ClientMessageID string    `json:"clientMessageId"`
	Body            string    `json:"body"`
	CreatedAt       time.Time `json:"createdAt"`
}

func (s *PostgresService) acceptedFriends(ctx context.Context, userID, peerID string) (bool, error) {
	user, userErr := uuid.Parse(userID)
	peer, peerErr := uuid.Parse(peerID)
	if userErr != nil || peerErr != nil || user == peer {
		return false, ErrInvalidInput
	}
	var accepted bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM friendships WHERE status = 'accepted'
		AND ((user_low = $1 AND user_high = $2) OR (user_low = $2 AND user_high = $1)))`, user, peer).Scan(&accepted)
	return accepted, err
}

func (s *PostgresService) SendFriendMessage(ctx context.Context, userID, peerID string, input ChatMessageInput) (FriendMessage, error) {
	input, err := ValidateChatMessageInput(input)
	if err != nil {
		return FriendMessage{}, err
	}
	accepted, err := s.acceptedFriends(ctx, userID, peerID)
	if err != nil {
		return FriendMessage{}, err
	}
	if !accepted {
		return FriendMessage{}, ErrFriendNotFound
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return FriendMessage{}, err
	}
	defer tx.Rollback(ctx)
	// Hold a row lock until message and outbox commit; removing a friend waits,
	// so no message can be committed after friendship revocation completes.
	var held int
	err = tx.QueryRow(ctx, `SELECT 1 FROM friendships WHERE status = 'accepted'
		AND ((user_low = $1 AND user_high = $2) OR (user_low = $2 AND user_high = $1)) FOR SHARE`, userID, peerID).Scan(&held)
	if errors.Is(err, pgx.ErrNoRows) {
		return FriendMessage{}, ErrFriendNotFound
	}
	if err != nil {
		return FriendMessage{}, err
	}
	var message FriendMessage
	// The INSERT stays inside the same transaction as the friendship lock.
	err = tx.QueryRow(ctx, `INSERT INTO friend_messages (sender_id,recipient_id,client_message_id,body)
		SELECT $1,$2,$3,$4 WHERE EXISTS (SELECT 1 FROM friendships WHERE status = 'accepted'
		AND ((user_low = $1 AND user_high = $2) OR (user_low = $2 AND user_high = $1)))
		ON CONFLICT (sender_id,client_message_id) DO NOTHING
		RETURNING id::text,sender_id::text,recipient_id::text,client_message_id,body,created_at`, userID, peerID, input.ClientMessageID, input.Body).
		Scan(&message.ID, &message.SenderID, &message.RecipientID, &message.ClientMessageID, &message.Body, &message.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(ctx, `SELECT id::text,sender_id::text,recipient_id::text,client_message_id,body,created_at
			FROM friend_messages WHERE sender_id = $1 AND recipient_id = $2 AND client_message_id = $3`, userID, peerID, input.ClientMessageID).
			Scan(&message.ID, &message.SenderID, &message.RecipientID, &message.ClientMessageID, &message.Body, &message.CreatedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return FriendMessage{}, ErrFriendNotFound
		}
		if err != nil {
			return FriendMessage{}, err
		}
	} else if err != nil {
		return FriendMessage{}, err
	} else {
		payload, err := json.Marshal(message)
		if err != nil {
			return FriendMessage{}, err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO outbox_events (aggregate_type,aggregate_id,event_type,payload)
			VALUES ('friend_message',$1,'chat.friend-message.created',$2::jsonb)`, message.ID, payload); err != nil {
			return FriendMessage{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return FriendMessage{}, err
	}
	return message, nil
}

func (s *PostgresService) ListFriendMessages(ctx context.Context, userID, peerID string) ([]FriendMessage, error) {
	accepted, err := s.acceptedFriends(ctx, userID, peerID)
	if err != nil {
		return nil, err
	}
	if !accepted {
		return nil, ErrFriendNotFound
	}
	rows, err := s.pool.Query(ctx, `SELECT id::text,sender_id::text,recipient_id::text,client_message_id,body,created_at
		FROM (SELECT * FROM friend_messages WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)
		ORDER BY created_at DESC,id DESC LIMIT 100) recent ORDER BY created_at ASC,id ASC`, userID, peerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	messages := make([]FriendMessage, 0)
	for rows.Next() {
		var message FriendMessage
		if err := rows.Scan(&message.ID, &message.SenderID, &message.RecipientID, &message.ClientMessageID, &message.Body, &message.CreatedAt); err != nil {
			return nil, err
		}
		messages = append(messages, message)
	}
	return messages, rows.Err()
}
