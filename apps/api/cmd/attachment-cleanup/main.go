package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"chatify-realtime/api/internal/auth"
	"chatify-realtime/api/internal/storage"
)

func main() {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		log.Fatal("DATABASE_URL is required")
	}
	service, err := auth.NewPostgresService(databaseURL)
	if err != nil {
		log.Fatal(err)
	}
	defer service.Close()

	objectStore, err := storage.New(
		os.Getenv("OBJECT_STORAGE_ENDPOINT"),
		os.Getenv("OBJECT_STORAGE_PUBLIC_ENDPOINT"),
		os.Getenv("RUSTFS_ACCESS_KEY"),
		os.Getenv("RUSTFS_SECRET_KEY"),
		os.Getenv("RUSTFS_BUCKET"),
	)
	if err != nil {
		log.Fatal(err)
	}

	retention := durationFromEnv("ATTACHMENT_PENDING_RETENTION", 24*time.Hour)
	interval := durationFromEnv("ATTACHMENT_CLEANUP_INTERVAL", 15*time.Minute)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cleanup := func() {
		cutoff := time.Now().UTC().Add(-retention)
		attachments, err := service.ListPendingAttachmentsBefore(ctx, cutoff)
		if err != nil {
			log.Printf("attachment cleanup query failed: %v", err)
			return
		}
		for _, attachment := range attachments {
			if err := objectStore.DeleteObject(ctx, attachment.ObjectKey); err != nil {
				log.Printf("attachment cleanup object delete failed id=%s: %v", attachment.ID, err)
				continue
			}
			if err := service.RejectAttachment(ctx, attachment.ID); err != nil {
				log.Printf("attachment cleanup record update failed id=%s: %v", attachment.ID, err)
				continue
			}
			log.Printf("attachment cleanup rejected id=%s", attachment.ID)
		}
	}

	cleanup()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cleanup()
		}
	}
}

func durationFromEnv(name string, fallback time.Duration) time.Duration {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil || parsed <= 0 {
		if seconds, numberErr := strconv.Atoi(value); numberErr == nil && seconds > 0 {
			return time.Duration(seconds) * time.Second
		}
		return fallback
	}
	return parsed
}
