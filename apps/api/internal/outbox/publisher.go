package outbox

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/segmentio/kafka-go"
)

const batchSize = 50

type Publisher struct {
	DB          *pgxpool.Pool
	Writer      *kafka.Writer
	Worker      uuid.UUID
	OnError     func(error)
	OnPublished func(int)
}

type event struct {
	ID          uuid.UUID
	AggregateID uuid.UUID
	EventType   string
	Payload     json.RawMessage
	ClaimedBy   uuid.UUID
}

func NewPublisher(db *pgxpool.Pool, broker, topic string) *Publisher {
	return &Publisher{
		DB: db,
		Writer: &kafka.Writer{
			Addr:                   kafka.TCP(broker),
			Topic:                  topic,
			Balancer:               &kafka.Hash{},
			RequiredAcks:           kafka.RequireOne,
			AllowAutoTopicCreation: true,
		},
		Worker: uuid.New(),
	}
}

func (p *Publisher) Close() error {
	return p.Writer.Close()
}

func (p *Publisher) Run(ctx context.Context, interval time.Duration) error {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		published, err := p.PublishOnce(ctx)
		if err != nil && !errors.Is(err, context.Canceled) {
			if p.OnError != nil {
				p.OnError(err)
			}
		} else if err == nil && p.OnPublished != nil {
			p.OnPublished(published)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (p *Publisher) PublishOnce(ctx context.Context) (int, error) {
	claimed, err := p.claim(ctx)
	if err != nil {
		return 0, err
	}
	published := 0
	for _, item := range claimed {
		if err := p.Writer.WriteMessages(ctx, kafka.Message{
			Key:   []byte(item.AggregateID.String()),
			Value: item.Payload,
			Headers: []kafka.Header{
				{Key: "event-id", Value: []byte(item.ID.String())},
				{Key: "event-type", Value: []byte(item.EventType)},
			},
		}); err != nil {
			_ = p.release(ctx, item, err.Error())
			continue
		}
		if err := p.markPublished(ctx, item); err != nil {
			return published, err
		}
		published++
	}
	return published, nil
}

func (p *Publisher) claim(ctx context.Context) ([]event, error) {
	tx, err := p.DB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `
		SELECT id, aggregate_id, event_type, payload
		FROM outbox_events
		WHERE published_at IS NULL
		  AND (locked_until IS NULL OR locked_until < now())
		ORDER BY occurred_at
		LIMIT $1
		FOR UPDATE SKIP LOCKED`, batchSize)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	claimed := make([]event, 0, batchSize)
	for rows.Next() {
		var item event
		if err := rows.Scan(&item.ID, &item.AggregateID, &item.EventType, &item.Payload); err != nil {
			return nil, err
		}
		item.ClaimedBy = p.Worker
		claimed = append(claimed, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, item := range claimed {
		if _, err := tx.Exec(ctx, `
			UPDATE outbox_events
			SET locked_by = $2, locked_until = now() + interval '30 seconds', attempts = attempts + 1
			WHERE id = $1`, item.ID, p.Worker); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return claimed, nil
}

func (p *Publisher) markPublished(ctx context.Context, item event) error {
	_, err := p.DB.Exec(ctx, `
		UPDATE outbox_events
		SET published_at = now(), locked_by = NULL, locked_until = NULL, last_error = NULL
		WHERE id = $1 AND locked_by = $2`, item.ID, item.ClaimedBy)
	return err
}

func (p *Publisher) release(ctx context.Context, item event, message string) error {
	_, err := p.DB.Exec(ctx, `
		UPDATE outbox_events
		SET locked_by = NULL, locked_until = NULL, last_error = $3
		WHERE id = $1 AND locked_by = $2`, item.ID, item.ClaimedBy, message)
	return err
}
