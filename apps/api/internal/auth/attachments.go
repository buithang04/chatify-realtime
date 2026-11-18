package auth

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var ErrInvalidAttachment = errors.New("invalid attachment")

type Attachment struct {
	ID          string     `json:"id"`
	RoomID      string     `json:"roomId"`
	UploaderID  string     `json:"uploaderId"`
	ObjectKey   string     `json:"objectKey"`
	ContentType string     `json:"contentType"`
	SizeBytes   int64      `json:"sizeBytes"`
	Status      string     `json:"status"`
	CreatedAt   time.Time  `json:"createdAt"`
	VerifiedAt  *time.Time `json:"verifiedAt,omitempty"`
}

type PendingAttachment struct {
	ID        string
	ObjectKey string
}

func IsAllowedAttachmentType(contentType string) bool {
	switch strings.ToLower(strings.TrimSpace(contentType)) {
	case "image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf", "text/plain":
		return true
	default:
		return false
	}
}

func (s *PostgresService) CreateAttachment(ctx context.Context, userID, roomID, objectKey, contentType string, sizeBytes int64) (Attachment, error) {
	if !IsAllowedAttachmentType(contentType) || sizeBytes < 1 || sizeBytes > 25*1024*1024 || objectKey == "" {
		return Attachment{}, ErrInvalidAttachment
	}
	userUUID, err := uuid.Parse(userID)
	if err != nil {
		return Attachment{}, ErrNotMember
	}
	roomUUID, err := uuid.Parse(roomID)
	if err != nil {
		return Attachment{}, ErrNotMember
	}
	var attachment Attachment
	err = s.pool.QueryRow(ctx, `
		INSERT INTO attachments (room_id, uploader_id, object_key, content_type, size_bytes)
		SELECT $1, $2, $3, $4, $5
		WHERE EXISTS (SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2 AND status = 'active')
		RETURNING id::text, room_id::text, uploader_id::text, object_key, content_type, size_bytes, status, created_at, verified_at`,
		roomUUID, userUUID, objectKey, strings.ToLower(strings.TrimSpace(contentType)), sizeBytes).
		Scan(&attachment.ID, &attachment.RoomID, &attachment.UploaderID, &attachment.ObjectKey, &attachment.ContentType, &attachment.SizeBytes, &attachment.Status, &attachment.CreatedAt, &attachment.VerifiedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Attachment{}, ErrNotMember
	}
	return attachment, err
}

func (s *PostgresService) GetAttachment(ctx context.Context, userID, attachmentID string) (Attachment, error) {
	userUUID, err := uuid.Parse(userID)
	if err != nil {
		return Attachment{}, ErrInvalidAttachment
	}
	attachmentUUID, err := uuid.Parse(attachmentID)
	if err != nil {
		return Attachment{}, ErrInvalidAttachment
	}
	var attachment Attachment
	err = s.pool.QueryRow(ctx, `
		SELECT id::text, room_id::text, uploader_id::text, object_key, content_type, size_bytes, status, created_at, verified_at
		FROM attachments WHERE id = $1 AND uploader_id = $2`, attachmentUUID, userUUID).
		Scan(&attachment.ID, &attachment.RoomID, &attachment.UploaderID, &attachment.ObjectKey, &attachment.ContentType, &attachment.SizeBytes, &attachment.Status, &attachment.CreatedAt, &attachment.VerifiedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Attachment{}, ErrInvalidAttachment
	}
	return attachment, err
}

// GetReadyAttachmentForMember returns an attachment only when the caller is
// an active member of the owning room and the object passed verification.
// Keeping this authorization in the query prevents a caller from using an
// attachment ID to probe or download objects from rooms they left.
func (s *PostgresService) GetReadyAttachmentForMember(ctx context.Context, userID, attachmentID string) (Attachment, error) {
	userUUID, err := uuid.Parse(userID)
	if err != nil {
		return Attachment{}, ErrInvalidAttachment
	}
	attachmentUUID, err := uuid.Parse(attachmentID)
	if err != nil {
		return Attachment{}, ErrInvalidAttachment
	}
	var attachment Attachment
	err = s.pool.QueryRow(ctx, `
		SELECT a.id::text, a.room_id::text, a.uploader_id::text, a.object_key, a.content_type, a.size_bytes, a.status, a.created_at, a.verified_at
		FROM attachments a
		JOIN room_members m ON m.room_id = a.room_id AND m.user_id = $2 AND m.status = 'active'
		WHERE a.id = $1 AND a.status = 'ready'`, attachmentUUID, userUUID).
		Scan(&attachment.ID, &attachment.RoomID, &attachment.UploaderID, &attachment.ObjectKey, &attachment.ContentType, &attachment.SizeBytes, &attachment.Status, &attachment.CreatedAt, &attachment.VerifiedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Attachment{}, ErrInvalidAttachment
	}
	return attachment, err
}

func (s *PostgresService) MarkAttachmentReady(ctx context.Context, attachmentID string) (Attachment, error) {
	attachmentUUID, err := uuid.Parse(attachmentID)
	if err != nil {
		return Attachment{}, ErrInvalidAttachment
	}
	var attachment Attachment
	err = s.pool.QueryRow(ctx, `
		UPDATE attachments SET status = 'ready', verified_at = now()
		WHERE id = $1 AND status = 'pending'
		RETURNING id::text, room_id::text, uploader_id::text, object_key, content_type, size_bytes, status, created_at, verified_at`, attachmentUUID).
		Scan(&attachment.ID, &attachment.RoomID, &attachment.UploaderID, &attachment.ObjectKey, &attachment.ContentType, &attachment.SizeBytes, &attachment.Status, &attachment.CreatedAt, &attachment.VerifiedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Attachment{}, ErrInvalidAttachment
	}
	return attachment, err
}

func (s *PostgresService) RejectAttachment(ctx context.Context, attachmentID string) error {
	attachmentUUID, err := uuid.Parse(attachmentID)
	if err != nil {
		return ErrInvalidAttachment
	}
	_, err = s.pool.Exec(ctx, `UPDATE attachments SET status = 'rejected', verified_at = now() WHERE id = $1 AND status = 'pending'`, attachmentUUID)
	return err
}

func (s *PostgresService) ListPendingAttachmentsBefore(ctx context.Context, cutoff time.Time) ([]PendingAttachment, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, object_key
		FROM attachments
		WHERE status = 'pending' AND created_at < $1
		ORDER BY created_at ASC
		LIMIT 500`, cutoff)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	attachments := make([]PendingAttachment, 0)
	for rows.Next() {
		var attachment PendingAttachment
		if err := rows.Scan(&attachment.ID, &attachment.ObjectKey); err != nil {
			return nil, err
		}
		attachments = append(attachments, attachment)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return attachments, nil
}
