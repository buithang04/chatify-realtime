package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"chatify-realtime/api/internal/outbox"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		log.Fatal("DATABASE_URL is required")
	}
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()

	broker := envOrDefault("REDPANDA_ADDRESS", "redpanda:9092")
	topic := envOrDefault("OUTBOX_TOPIC", "room-events")
	publisher := outbox.NewPublisher(pool, broker, topic)
	metrics := newPublisherMetrics(pool)
	publisher.OnError = func(err error) { metrics.recordError(); log.Printf("outbox publish cycle failed: %v", err) }
	publisher.OnPublished = metrics.recordPublished
	defer publisher.Close()
	metricsServer := &http.Server{Addr: ":" + envOrDefault("OUTBOX_METRICS_PORT", "8083"), Handler: http.HandlerFunc(metrics.handler)}
	go func() {
		if err := metricsServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("outbox metrics server failed: %v", err)
		}
	}()
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = metricsServer.Shutdown(shutdownCtx)
	}()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := publisher.Run(ctx, 500*time.Millisecond); err != nil && err != context.Canceled {
		log.Fatal(err)
	}
}

func envOrDefault(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
