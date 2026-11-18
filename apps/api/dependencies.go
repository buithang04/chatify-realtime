package main

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

type readinessChecks struct {
	postgres func(context.Context) dependencyStatus
	redis    func(context.Context) dependencyStatus
	redpanda func(context.Context) dependencyStatus
}

func defaultReadinessChecks(cfg config) readinessChecks {
	return readinessChecks{
		postgres: func(ctx context.Context) dependencyStatus {
			if cfg.DatabaseURL == "" {
				return dependencyStatus{Status: "failed"}
			}
			pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
			if err != nil {
				return dependencyStatus{Status: "failed"}
			}
			defer pool.Close()
			if err := pool.Ping(ctx); err != nil {
				return dependencyStatus{Status: "failed"}
			}
			return dependencyStatus{Status: "ok"}
		},
		redis: func(ctx context.Context) dependencyStatus {
			client := redis.NewClient(&redis.Options{Addr: cfg.RedisAddress, Password: cfg.RedisPassword})
			defer client.Close()
			if err := client.Ping(ctx).Err(); err != nil {
				return dependencyStatus{Status: "failed"}
			}
			return dependencyStatus{Status: "ok"}
		},
		redpanda: func(ctx context.Context) dependencyStatus {
			dialer := kafka.Dialer{Timeout: 250 * time.Millisecond}
			conn, err := dialer.DialContext(ctx, "tcp", cfg.RedpandaAddress)
			if err != nil {
				return dependencyStatus{Status: "failed"}
			}
			_ = conn.Close()
			return dependencyStatus{Status: "ok"}
		},
	}
}
