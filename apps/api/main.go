package main

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"chatify-realtime/api/internal/auth"
	"chatify-realtime/api/internal/observability"
	"chatify-realtime/api/internal/storage"
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/compress"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/limiter"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

func main() {
	cfg := configFromEnv()
	if err := cfg.validate(); err != nil {
		log.Fatal(err)
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)

	var authService *auth.PostgresService
	var err error
	if cfg.DatabaseURL != "" {
		authService, err = auth.NewPostgresService(cfg.DatabaseURL)
		if err != nil {
			log.Fatal(err)
		}
		defer authService.Close()
	}

	objectStore, err := storage.New(cfg.ObjectStorageEndpoint, cfg.ObjectStoragePublicEndpoint, cfg.ObjectStorageAccessKey, cfg.ObjectStorageSecretKey, cfg.ObjectStorageBucket)
	if err != nil {
		log.Fatal(err)
	}
	if err := objectStore.EnsureBucket(context.Background()); err != nil {
		log.Fatal(err)
	}
	if err := runServer(newAppWithAuth(cfg, defaultReadinessChecks(cfg), authService, authService, objectStore), cfg.HTTPAddress, signals); err != nil {
		log.Fatal(err)
	}
}

func runServer(app *fiber.App, address string, signals <-chan os.Signal) error {
	errors := make(chan error, 1)
	go func() {
		errors <- app.Listen(address)
	}()

	select {
	case err := <-errors:
		return err
	case <-signals:
		return app.Shutdown()
	}
}

type config struct {
	Environment                 string
	InternalServiceToken        string
	HTTPAddress                 string
	DatabaseURL                 string
	PostgresAddress             string
	RedisAddress                string
	RedisPassword               string
	RedpandaAddress             string
	JWTSecret                   string
	CORSOrigin                  string
	CookieSecure                bool
	ObjectStorageEndpoint       string
	ObjectStoragePublicEndpoint string
	ObjectStorageAccessKey      string
	ObjectStorageSecretKey      string
	ObjectStorageBucket         string
	MaxBodyBytes                int
	ReadinessTimeout            time.Duration
	APIRateLimitMax             int
	RateLimitExpiration         time.Duration
}

func configFromEnv() config {
	return config{
		Environment:                 envOrDefault("APP_ENV", "local"),
		InternalServiceToken:        os.Getenv("INTERNAL_SERVICE_TOKEN"),
		HTTPAddress:                 envOrDefault("HTTP_ADDRESS", ":8080"),
		DatabaseURL:                 os.Getenv("DATABASE_URL"),
		PostgresAddress:             envOrDefault("POSTGRES_ADDRESS", "postgres:5432"),
		RedisAddress:                envOrDefault("REDIS_ADDRESS", "redis:6379"),
		RedisPassword:               os.Getenv("REDIS_PASSWORD"),
		RedpandaAddress:             envOrDefault("REDPANDA_ADDRESS", "redpanda:9092"),
		JWTSecret:                   os.Getenv("JWT_SECRET"),
		CORSOrigin:                  envOrDefault("CORS_ORIGIN", "http://localhost:3000"),
		CookieSecure:                envBool("COOKIE_SECURE", false),
		ObjectStorageEndpoint:       envOrDefault("OBJECT_STORAGE_ENDPOINT", "object-storage:9000"),
		ObjectStoragePublicEndpoint: envOrDefault("OBJECT_STORAGE_PUBLIC_ENDPOINT", "http://localhost:9000"),
		ObjectStorageAccessKey:      os.Getenv("RUSTFS_ACCESS_KEY"),
		ObjectStorageSecretKey:      os.Getenv("RUSTFS_SECRET_KEY"),
		ObjectStorageBucket:         envOrDefault("RUSTFS_BUCKET", "chatify-local"),
		MaxBodyBytes:                envIntOrDefault("API_MAX_BODY_BYTES", 1_048_576),
		ReadinessTimeout:            500 * time.Millisecond,
		APIRateLimitMax:             envIntOrDefault("API_RATE_LIMIT_MAX", 300),
		RateLimitExpiration:         time.Minute,
	}
}

func (c config) validate() error {
	if !strings.EqualFold(c.Environment, "production") {
		return nil
	}
	if len(c.JWTSecret) < 32 {
		return fmt.Errorf("JWT_SECRET must contain at least 32 characters in production")
	}
	if !c.CookieSecure {
		return fmt.Errorf("COOKIE_SECURE=true is required in production")
	}
	if strings.TrimSpace(c.CORSOrigin) == "" || strings.TrimSpace(c.CORSOrigin) == "*" || strings.Contains(c.CORSOrigin, "*") {
		return fmt.Errorf("CORS_ORIGIN must be an explicit origin list in production")
	}
	if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(c.ObjectStoragePublicEndpoint)), "https://") {
		return fmt.Errorf("OBJECT_STORAGE_PUBLIC_ENDPOINT must use HTTPS in production")
	}
	if c.DatabaseURL == "" || c.ObjectStorageAccessKey == "" || c.ObjectStorageSecretKey == "" {
		return fmt.Errorf("database and object-storage credentials are required in production")
	}
	if len(c.InternalServiceToken) < 32 {
		return fmt.Errorf("INTERNAL_SERVICE_TOKEN must contain at least 32 characters in production")
	}
	return nil
}

func newApp(cfg config) *fiber.App {
	var authService *auth.PostgresService
	if cfg.DatabaseURL != "" {
		var err error
		authService, err = auth.NewPostgresService(cfg.DatabaseURL)
		if err != nil {
			return newAppWithAuth(cfg, defaultReadinessChecks(cfg), nil)
		}
	}
	return newAppWithAuth(cfg, defaultReadinessChecks(cfg), authService, authService)
}

func newAppWithReadinessChecks(cfg config, readiness readinessChecks) *fiber.App {
	return newAppWithAuth(cfg, readiness, nil)
}

type authService interface {
	Register(context.Context, auth.RegistrationInput) (auth.User, error)
	Authenticate(context.Context, auth.LoginInput) (auth.User, error)
}

type sessionService interface {
	CreateTokenPair(context.Context, auth.User, string) (auth.TokenPair, error)
	RotateTokenPair(context.Context, string, string) (auth.User, auth.TokenPair, error)
	RevokeRefreshToken(context.Context, string) error
}

type roomService interface {
	CreateRoom(context.Context, string, auth.RoomInput) (auth.Room, error)
	JoinRoom(context.Context, string, string) (auth.Room, error)
	ListRoomMembers(context.Context, string, string) ([]auth.RoomMember, error)
	ListRecentRooms(context.Context, string) ([]auth.RecentRoom, error)
	LeaveRoom(context.Context, string, string) error
	IsActiveMember(context.Context, string, string) (bool, error)
	MediaPolicy(context.Context, string, string) (auth.MediaPolicy, error)
}

type chatService interface {
	SendMessage(context.Context, string, string, auth.ChatMessageInput) (auth.ChatMessage, error)
	ListMessages(context.Context, string, string, int, *time.Time) ([]auth.ChatMessage, error)
	SendDirectMessage(context.Context, string, string, string, auth.ChatMessageInput) (auth.DirectMessage, error)
	ListDirectMessages(context.Context, string, string, string, int, *time.Time) ([]auth.DirectMessage, error)
}

type uploadService interface {
	PresignUpload(context.Context, storage.UploadRequest) (storage.PresignedUpload, error)
	PresignDownload(context.Context, string) (storage.PresignedDownload, error)
	StatObject(context.Context, string) (int64, string, error)
	DeleteObject(context.Context, string) error
}

type storageMetricsProvider interface {
	StorageStats() storage.Stats
}

type attachmentService interface {
	CreateAttachment(context.Context, string, string, string, string, int64) (auth.Attachment, error)
	GetAttachment(context.Context, string, string) (auth.Attachment, error)
	GetReadyAttachmentForMember(context.Context, string, string) (auth.Attachment, error)
	MarkAttachmentReady(context.Context, string) (auth.Attachment, error)
	RejectAttachment(context.Context, string) error
}

func newAppWithAuth(cfg config, readiness readinessChecks, service authService, dependencies ...any) *fiber.App {
	var session sessionService
	var uploads uploadService
	var storageMetrics storageMetricsProvider
	for _, dependency := range dependencies {
		if candidate, ok := dependency.(sessionService); ok && session == nil {
			session = candidate
		}
		if candidate, ok := dependency.(uploadService); ok {
			uploads = candidate
		}
		if candidate, ok := dependency.(storageMetricsProvider); ok {
			storageMetrics = candidate
		}
	}
	rooms, _ := service.(roomService)
	chat, _ := service.(chatService)
	attachments, _ := service.(attachmentService)
	metrics := observability.NewHTTPMetrics()
	if poolProvider, ok := service.(interface{ PoolStats() auth.PoolStats }); ok {
		stats := poolProvider.PoolStats()
		metrics.SetDatabasePool(observability.DatabasePoolStats{
			MaxConns: stats.MaxConns, TotalConns: stats.TotalConns, AcquiredConns: stats.AcquiredConns,
			IdleConns: stats.IdleConns, EmptyAcquireCount: stats.EmptyAcquireCount,
		})
	}
	if storageMetrics != nil {
		stats := storageMetrics.StorageStats()
		metrics.SetStorage(observability.StorageStats{Operations: stats.Operations, Errors: stats.Errors})
	}
	maxBodyBytes := cfg.MaxBodyBytes
	if maxBodyBytes < 1 {
		maxBodyBytes = 1_048_576
	}
	app := fiber.New(fiber.Config{
		DisableStartupMessage: true,
		BodyLimit:             maxBodyBytes,
	})
	app.Use(func(c *fiber.Ctx) error {
		requestID := strings.TrimSpace(c.Get("X-Request-ID"))
		if requestID == "" || len(requestID) > 128 || strings.ContainsAny(requestID, "\r\n") {
			requestID = uuid.NewString()
		}
		c.Locals("requestID", requestID)
		c.Set("X-Request-ID", requestID)
		started := time.Now()
		err := c.Next()
		metrics.Observe(c.Method(), c.Route().Path, c.Response().StatusCode(), time.Since(started).Seconds())
		return err
	})
	app.Use(func(c *fiber.Ctx) error {
		c.Set(fiber.HeaderXContentTypeOptions, "nosniff")
		c.Set(fiber.HeaderXFrameOptions, "DENY")
		c.Set("Referrer-Policy", "no-referrer")
		c.Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'")
		return c.Next()
	})
	app.Use(compress.New(compress.Config{Level: compress.LevelBestSpeed}))
	corsOrigin := cfg.CORSOrigin
	if corsOrigin == "" {
		corsOrigin = "http://localhost:3000"
	}
	app.Use(cors.New(cors.Config{
		AllowOrigins:     corsOrigin,
		AllowMethods:     "GET,POST,PUT,PATCH,DELETE,OPTIONS",
		AllowHeaders:     "Origin, Content-Type, Accept, Authorization",
		AllowCredentials: true,
	}))
	apiRateLimitMax := cfg.APIRateLimitMax
	if apiRateLimitMax < 1 {
		apiRateLimitMax = 300
	}
	if cfg.RedisAddress != "" {
		redisClient := redis.NewClient(&redis.Options{Addr: cfg.RedisAddress, Password: cfg.RedisPassword})
		app.Use("/api", redisRateLimit(redisClient, apiRateLimitMax, cfg.RateLimitExpiration))
	} else {
		app.Use("/api", limiter.New(limiter.Config{
			Max:        apiRateLimitMax,
			Expiration: cfg.RateLimitExpiration,
			KeyGenerator: func(c *fiber.Ctx) string {
				return c.IP()
			},
			LimitReached: func(c *fiber.Ctx) error {
				c.Set("Retry-After", strconv.Itoa(int(cfg.RateLimitExpiration.Seconds())))
				return writeAPIError(c, fiber.StatusTooManyRequests, "RATE_LIMITED", "too many requests")
			},
		}))
	}
	app.Get("/metrics", func(c *fiber.Ctx) error {
		if poolProvider, ok := service.(interface{ PoolStats() auth.PoolStats }); ok {
			stats := poolProvider.PoolStats()
			metrics.SetDatabasePool(observability.DatabasePoolStats{
				MaxConns: stats.MaxConns, TotalConns: stats.TotalConns, AcquiredConns: stats.AcquiredConns,
				IdleConns: stats.IdleConns, EmptyAcquireCount: stats.EmptyAcquireCount,
			})
		}
		if storageMetrics != nil {
			stats := storageMetrics.StorageStats()
			metrics.SetStorage(observability.StorageStats{Operations: stats.Operations, Errors: stats.Errors})
		}
		c.Type("text/plain; version=0.0.4")
		return c.SendString(metrics.Render())
	})
	registerSocialRoutes(app, cfg, service)

	app.Post("/api/v1/rooms", requireUser(cfg, rooms != nil), func(c *fiber.Ctx) error {
		var input auth.RoomInput
		if err := c.BodyParser(&input); err != nil {
			return writeAPIError(c, fiber.StatusUnprocessableEntity, "VALIDATION_ERROR", "invalid request body")
		}
		input, err := auth.ValidateRoomInput(input)
		if err != nil {
			return writeAPIError(c, fiber.StatusUnprocessableEntity, "VALIDATION_ERROR", "invalid room data")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		room, err := rooms.CreateRoom(ctx, c.Locals("userID").(string), input)
		if errors.Is(err, auth.ErrInvalidRoom) {
			return writeAPIError(c, fiber.StatusUnprocessableEntity, "VALIDATION_ERROR", "invalid room data")
		}
		if err != nil {
			return writeAPIError(c, fiber.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
		}
		return c.Status(fiber.StatusCreated).JSON(fiber.Map{"room": room})
	})

	app.Get("/api/v1/rooms/recent", requireUser(cfg, rooms != nil), func(c *fiber.Ctx) error {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		recent, err := rooms.ListRecentRooms(ctx, c.Locals("userID").(string))
		if err != nil {
			return writeAPIError(c, fiber.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
		}
		return c.JSON(fiber.Map{"rooms": recent})
	})

	app.Post("/api/v1/rooms/:roomID/members", requireUser(cfg, rooms != nil), func(c *fiber.Ctx) error {
		var input struct {
			Password string `json:"password"`
		}
		if len(c.Body()) > 0 && c.BodyParser(&input) != nil {
			return writeAPIError(c, fiber.StatusUnprocessableEntity, "VALIDATION_ERROR", "invalid request body")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		var room auth.Room
		var err error
		if lockedRooms, ok := service.(interface {
			JoinRoomWithPassword(context.Context, string, string, string) (auth.Room, error)
		}); ok {
			room, err = lockedRooms.JoinRoomWithPassword(ctx, c.Locals("userID").(string), c.Params("roomID"), input.Password)
		} else {
			room, err = rooms.JoinRoom(ctx, c.Locals("userID").(string), c.Params("roomID"))
		}
		switch {
		case errors.Is(err, auth.ErrRoomPassword):
			return writeAPIError(c, fiber.StatusForbidden, "ROOM_PASSWORD_REQUIRED", "Mật khẩu phòng không đúng hoặc còn thiếu")
		case errors.Is(err, auth.ErrRoomNotFound):
			return writeAPIError(c, fiber.StatusNotFound, "ROOM_NOT_FOUND", "room not found")
		case errors.Is(err, auth.ErrAlreadyMember):
			return writeAPIError(c, fiber.StatusConflict, "ALREADY_MEMBER", "already a room member")
		case errors.Is(err, auth.ErrRoomFull):
			return writeAPIError(c, fiber.StatusConflict, "ROOM_FULL", "room is full")
		case errors.Is(err, auth.ErrRoomClosed):
			return writeAPIError(c, fiber.StatusConflict, "ROOM_CLOSED", "room is closed")
		case errors.Is(err, auth.ErrMemberKicked):
			return writeAPIError(c, fiber.StatusForbidden, "MEMBER_KICKED", "member cannot rejoin this room")
		case err != nil:
			return writeAPIError(c, fiber.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
		}
		return c.Status(fiber.StatusOK).JSON(fiber.Map{"room": room})
	})

	app.Delete("/api/v1/rooms/:roomID/members/me", requireUser(cfg, rooms != nil), func(c *fiber.Ctx) error {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		err := rooms.LeaveRoom(ctx, c.Locals("userID").(string), c.Params("roomID"))
		if errors.Is(err, auth.ErrNotMember) {
			return writeAPIError(c, fiber.StatusNotFound, "NOT_MEMBER", "not an active room member")
		}
		if err != nil {
			return writeAPIError(c, fiber.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
		}
		return c.SendStatus(fiber.StatusNoContent)
	})

	app.Get("/api/v1/rooms/:roomID/members", requireUser(cfg, rooms != nil), func(c *fiber.Ctx) error {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		members, err := rooms.ListRoomMembers(ctx, c.Locals("userID").(string), c.Params("roomID"))
		if errors.Is(err, auth.ErrNotMember) {
			return writeAPIError(c, fiber.StatusForbidden, "ROOM_ACCESS_DENIED", "room membership required")
		}
		if errors.Is(err, auth.ErrRoomNotFound) {
			return writeAPIError(c, fiber.StatusNotFound, "ROOM_NOT_FOUND", "room not found")
		}
		if err != nil {
			return writeAPIError(c, fiber.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
		}
		return c.JSON(fiber.Map{"members": members})
	})

	app.Get("/api/v1/rooms/:roomID/media-policy", requireUser(cfg, rooms != nil), func(c *fiber.Ctx) error {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		policy, err := rooms.MediaPolicy(ctx, c.Locals("userID").(string), c.Params("roomID"))
		if errors.Is(err, auth.ErrRoomNotFound) {
			return writeAPIError(c, fiber.StatusForbidden, "ROOM_ACCESS_DENIED", "room membership required")
		}
		if err != nil {
			return writeAPIError(c, fiber.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
		}
		return c.JSON(policy)
	})

	app.Post("/api/v1/rooms/:roomID/messages", requireUser(cfg, chat != nil), func(c *fiber.Ctx) error {
		var input auth.ChatMessageInput
		if err := c.BodyParser(&input); err != nil {
			return writeAPIError(c, fiber.StatusUnprocessableEntity, "VALIDATION_ERROR", "invalid request body")
		}
		input, err := auth.ValidateChatMessageInput(input)
		if err != nil {
			return writeAPIError(c, fiber.StatusUnprocessableEntity, "VALIDATION_ERROR", "invalid message data")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		message, err := chat.SendMessage(ctx, c.Locals("userID").(string), c.Params("roomID"), input)
		if errors.Is(err, auth.ErrNotMember) {
			return writeAPIError(c, fiber.StatusForbidden, "ROOM_ACCESS_DENIED", "room membership required")
		}
		if err != nil {
			return writeAPIError(c, fiber.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
		}
		return c.Status(fiber.StatusCreated).JSON(fiber.Map{"message": message})
	})

	app.Get("/api/v1/rooms/:roomID/messages", requireUser(cfg, chat != nil), func(c *fiber.Ctx) error {
		limit, err := strconv.Atoi(c.Query("limit", "50"))
		if err != nil || limit < 1 || limit > 100 {
			return writeAPIError(c, fiber.StatusUnprocessableEntity, "VALIDATION_ERROR", "invalid message pagination")
		}
		var before *time.Time
		if value := strings.TrimSpace(c.Query("before")); value != "" {
			parsed, parseErr := time.Parse(time.RFC3339Nano, value)
			if parseErr != nil {
				return writeAPIError(c, fiber.StatusUnprocessableEntity, "VALIDATION_ERROR", "invalid message pagination")
			}
			before = &parsed
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		messages, err := chat.ListMessages(ctx, c.Locals("userID").(string), c.Params("roomID"), limit, before)
		if errors.Is(err, auth.ErrNotMember) {
			return writeAPIError(c, fiber.StatusForbidden, "ROOM_ACCESS_DENIED", "room membership required")
		}
		if errors.Is(err, auth.ErrInvalidMessage) {
			return writeAPIError(c, fiber.StatusUnprocessableEntity, "VALIDATION_ERROR", "invalid message pagination")
		}
		if err != nil {
			return writeAPIError(c, fiber.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
		}
		return c.Status(fiber.StatusOK).JSON(fiber.Map{"messages": messages})
	})

	app.Post("/api/v1/rooms/:roomID/direct-messages/:peerID", requireUser(cfg, chat != nil), func(c *fiber.Ctx) error {
		var input auth.ChatMessageInput
		if err := c.BodyParser(&input); err != nil {
			return writeAPIError(c, fiber.StatusUnprocessableEntity, "VALIDATION_ERROR", "invalid request body")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		message, err := chat.SendDirectMessage(ctx, c.Locals("userID").(string), c.Params("roomID"), c.Params("peerID"), input)
		if errors.Is(err, auth.ErrNotMember) {
			return writeAPIError(c, fiber.StatusForbidden, "ROOM_ACCESS_DENIED", "both users must be active room members")
		}
		if errors.Is(err, auth.ErrInvalidMessage) {
			return writeAPIError(c, fiber.StatusUnprocessableEntity, "VALIDATION_ERROR", "invalid direct message")
		}
		if err != nil {
			return writeAPIError(c, fiber.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
		}
		return c.Status(fiber.StatusCreated).JSON(fiber.Map{"message": message})
	})

	app.Get("/api/v1/rooms/:roomID/direct-messages/:peerID", requireUser(cfg, chat != nil), func(c *fiber.Ctx) error {
		limit, err := strconv.Atoi(c.Query("limit", "50"))
		if err != nil || limit < 1 || limit > 100 {
			return writeAPIError(c, fiber.StatusUnprocessableEntity, "VALIDATION_ERROR", "invalid message pagination")
		}
		var before *time.Time
		if value := strings.TrimSpace(c.Query("before")); value != "" {
			parsed, parseErr := time.Parse(time.RFC3339Nano, value)
			if parseErr != nil {
				return writeAPIError(c, fiber.StatusUnprocessableEntity, "VALIDATION_ERROR", "invalid message pagination")
			}
			before = &parsed
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		messages, err := chat.ListDirectMessages(ctx, c.Locals("userID").(string), c.Params("roomID"), c.Params("peerID"), limit, before)
		if errors.Is(err, auth.ErrNotMember) {
			return writeAPIError(c, fiber.StatusForbidden, "ROOM_ACCESS_DENIED", "both users must be active room members")
		}
		if errors.Is(err, auth.ErrInvalidMessage) {
			return writeAPIError(c, fiber.StatusUnprocessableEntity, "VALIDATION_ERROR", "invalid message pagination")
		}
		if err != nil {
			return writeAPIError(c, fiber.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
		}
		return c.JSON(fiber.Map{"messages": messages})
	})

	app.Post("/api/v1/rooms/:roomID/uploads", requireUser(cfg, uploads != nil && rooms != nil && attachments != nil), func(c *fiber.Ctx) error {
		var input struct {
			ContentType string `json:"contentType"`
			SizeBytes   int64  `json:"sizeBytes"`
		}
		if err := c.BodyParser(&input); err != nil || !auth.IsAllowedAttachmentType(input.ContentType) || input.SizeBytes < 1 || input.SizeBytes > storage.MaxUploadBytes {
			return writeAPIError(c, fiber.StatusUnprocessableEntity, "VALIDATION_ERROR", "invalid upload data")
		}
		input.ContentType = strings.ToLower(strings.TrimSpace(input.ContentType))
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		allowed, err := rooms.IsActiveMember(ctx, c.Locals("userID").(string), c.Params("roomID"))
		if err != nil {
			return writeAPIError(c, fiber.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
		}
		if !allowed {
			return writeAPIError(c, fiber.StatusForbidden, "ROOM_ACCESS_DENIED", "room membership required")
		}
		objectKey := "rooms/" + c.Params("roomID") + "/users/" + c.Locals("userID").(string) + "/" + uuid.NewString()
		attachment, err := attachments.CreateAttachment(ctx, c.Locals("userID").(string), c.Params("roomID"), objectKey, input.ContentType, input.SizeBytes)
		if errors.Is(err, auth.ErrNotMember) {
			return writeAPIError(c, fiber.StatusForbidden, "ROOM_ACCESS_DENIED", "room membership required")
		}
		if err != nil {
			return writeAPIError(c, fiber.StatusUnprocessableEntity, "VALIDATION_ERROR", "invalid attachment data")
		}
		upload, err := uploads.PresignUpload(ctx, storage.UploadRequest{RoomID: c.Params("roomID"), UserID: c.Locals("userID").(string), ObjectKey: objectKey, ContentType: input.ContentType, SizeBytes: input.SizeBytes})
		if err != nil {
			return writeAPIError(c, fiber.StatusInternalServerError, "UPLOAD_UNAVAILABLE", "upload service unavailable")
		}
		return c.Status(fiber.StatusOK).JSON(fiber.Map{"attachment": attachment, "upload": upload})
	})

	app.Post("/api/v1/uploads/:attachmentID/complete", requireUser(cfg, uploads != nil && attachments != nil), func(c *fiber.Ctx) error {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		attachment, err := attachments.GetAttachment(ctx, c.Locals("userID").(string), c.Params("attachmentID"))
		if err != nil {
			return writeAPIError(c, fiber.StatusNotFound, "ATTACHMENT_NOT_FOUND", "attachment not found")
		}
		size, contentType, err := uploads.StatObject(ctx, attachment.ObjectKey)
		if err != nil || size != attachment.SizeBytes || strings.ToLower(contentType) != strings.ToLower(attachment.ContentType) {
			_ = attachments.RejectAttachment(ctx, attachment.ID)
			if err == nil {
				_ = uploads.DeleteObject(ctx, attachment.ObjectKey)
			}
			return writeAPIError(c, fiber.StatusUnprocessableEntity, "ATTACHMENT_INVALID", "uploaded object failed validation")
		}
		ready, err := attachments.MarkAttachmentReady(ctx, attachment.ID)
		if err != nil {
			return writeAPIError(c, fiber.StatusConflict, "ATTACHMENT_NOT_PENDING", "attachment is no longer pending")
		}
		return c.Status(fiber.StatusOK).JSON(fiber.Map{"attachment": ready})
	})

	app.Get("/api/v1/uploads/:attachmentID/download", requireUser(cfg, uploads != nil && attachments != nil), func(c *fiber.Ctx) error {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		attachment, err := attachments.GetReadyAttachmentForMember(ctx, c.Locals("userID").(string), c.Params("attachmentID"))
		if errors.Is(err, auth.ErrInvalidAttachment) {
			return writeAPIError(c, fiber.StatusNotFound, "ATTACHMENT_NOT_FOUND", "attachment not found")
		}
		if err != nil {
			return writeAPIError(c, fiber.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
		}
		download, err := uploads.PresignDownload(ctx, attachment.ObjectKey)
		if err != nil {
			log.Printf("attachment download presign failed: %v", err)
			return writeAPIError(c, fiber.StatusInternalServerError, "DOWNLOAD_UNAVAILABLE", "download service unavailable")
		}
		return c.Status(fiber.StatusOK).JSON(fiber.Map{"attachment": attachment, "download": download})
	})

	app.Get("/api/v1/internal/rooms/:roomID/access", requireInternalService(cfg, rooms != nil), func(c *fiber.Ctx) error {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		allowed, err := rooms.IsActiveMember(ctx, c.Locals("userID").(string), c.Params("roomID"))
		if errors.Is(err, auth.ErrRoomNotFound) {
			return writeAPIError(c, fiber.StatusNotFound, "ROOM_NOT_FOUND", "room not found")
		}
		if err != nil {
			return writeAPIError(c, fiber.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
		}
		if !allowed {
			return writeAPIError(c, fiber.StatusForbidden, "ROOM_ACCESS_DENIED", "room membership required")
		}
		return c.SendStatus(fiber.StatusNoContent)
	})

	app.Post("/api/v1/internal/rooms/:roomID/members/:userID/disconnect", requireService(cfg, rooms != nil), func(c *fiber.Ctx) error {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		err := rooms.LeaveRoom(ctx, c.Params("userID"), c.Params("roomID"))
		if errors.Is(err, auth.ErrNotMember) {
			return c.SendStatus(fiber.StatusNoContent)
		}
		if err != nil {
			return writeAPIError(c, fiber.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
		}
		return c.SendStatus(fiber.StatusNoContent)
	})

	app.Get("/api/v1/internal/rooms/:roomID/media-policy", requireInternalService(cfg, rooms != nil), func(c *fiber.Ctx) error {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		policy, err := rooms.MediaPolicy(ctx, c.Locals("userID").(string), c.Params("roomID"))
		if errors.Is(err, auth.ErrRoomNotFound) {
			return writeAPIError(c, fiber.StatusForbidden, "ROOM_ACCESS_DENIED", "room membership required")
		}
		if err != nil {
			return writeAPIError(c, fiber.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
		}
		return c.Status(fiber.StatusOK).JSON(policy)
	})

	app.Post("/api/v1/auth/register", func(c *fiber.Ctx) error {
		if service == nil {
			return writeAPIError(c, fiber.StatusServiceUnavailable, "AUTH_UNAVAILABLE", "authentication is temporarily unavailable")
		}
		var input auth.RegistrationInput
		if err := c.BodyParser(&input); err != nil {
			return writeAPIError(c, fiber.StatusUnprocessableEntity, "VALIDATION_ERROR", "invalid request body")
		}
		input, err := auth.ValidateRegistration(input)
		if err != nil {
			return writeAPIError(c, fiber.StatusUnprocessableEntity, "VALIDATION_ERROR", "invalid registration data")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		user, err := service.Register(ctx, input)
		if errors.Is(err, auth.ErrInvalidInput) {
			return writeAPIError(c, fiber.StatusUnprocessableEntity, "VALIDATION_ERROR", "invalid registration data")
		}
		if errors.Is(err, auth.ErrEmailAlreadyUsed) {
			return writeAPIError(c, fiber.StatusConflict, "EMAIL_ALREADY_USED", "email is already registered")
		}
		if err != nil {
			return writeAPIError(c, fiber.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
		}
		return c.Status(fiber.StatusCreated).JSON(fiber.Map{"user": user.Public()})
	})

	app.Post("/api/v1/auth/login", func(c *fiber.Ctx) error {
		if service == nil {
			return writeAPIError(c, fiber.StatusServiceUnavailable, "AUTH_UNAVAILABLE", "authentication is temporarily unavailable")
		}
		var input auth.LoginInput
		if err := c.BodyParser(&input); err != nil {
			return writeAPIError(c, fiber.StatusUnprocessableEntity, "VALIDATION_ERROR", "invalid request body")
		}
		input, err := auth.ValidateLogin(input)
		if err != nil {
			return writeAPIError(c, fiber.StatusUnprocessableEntity, "VALIDATION_ERROR", "invalid login data")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		user, err := service.Authenticate(ctx, input)
		if errors.Is(err, auth.ErrInvalidCredentials) {
			return writeAPIError(c, fiber.StatusUnauthorized, "INVALID_CREDENTIALS", "invalid email or password")
		}
		if err != nil {
			return writeAPIError(c, fiber.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
		}
		response := fiber.Map{"user": user.Public()}
		if session != nil {
			tokens, err := session.CreateTokenPair(ctx, user, cfg.JWTSecret)
			if err != nil {
				return writeAPIError(c, fiber.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
			}
			setRefreshCookie(c, tokens, cfg.CookieSecure)
			response["tokens"] = tokens
		}
		return c.Status(fiber.StatusOK).JSON(response)
	})

	app.Post("/api/v1/auth/refresh", func(c *fiber.Ctx) error {
		if session == nil {
			return writeAPIError(c, fiber.StatusServiceUnavailable, "AUTH_UNAVAILABLE", "authentication is temporarily unavailable")
		}
		refreshToken := c.Cookies("chatify_refresh")
		if refreshToken == "" {
			return c.SendStatus(fiber.StatusNoContent)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		user, tokens, err := session.RotateTokenPair(ctx, refreshToken, cfg.JWTSecret)
		if errors.Is(err, auth.ErrInvalidRefreshToken) {
			return writeAPIError(c, fiber.StatusUnauthorized, "INVALID_REFRESH_TOKEN", "invalid refresh token")
		}
		if err != nil {
			return writeAPIError(c, fiber.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
		}
		setRefreshCookie(c, tokens, cfg.CookieSecure)
		return c.Status(fiber.StatusOK).JSON(fiber.Map{"user": user.Public(), "tokens": tokens})
	})

	app.Post("/api/v1/auth/logout", func(c *fiber.Ctx) error {
		if session == nil {
			return writeAPIError(c, fiber.StatusServiceUnavailable, "AUTH_UNAVAILABLE", "authentication is temporarily unavailable")
		}
		if refreshToken := c.Cookies("chatify_refresh"); refreshToken != "" {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if err := session.RevokeRefreshToken(ctx, refreshToken); err != nil {
				return writeAPIError(c, fiber.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
			}
		}
		c.Set(fiber.HeaderCacheControl, "no-store")
		c.Cookie(&fiber.Cookie{Name: "chatify_refresh", Path: "/api/v1/auth", HTTPOnly: true, Secure: cfg.CookieSecure, SameSite: "Lax", Expires: time.Unix(0, 0), MaxAge: -1})
		return c.SendStatus(fiber.StatusNoContent)
	})

	app.Get("/health/live", func(c *fiber.Ctx) error {
		return c.Status(fiber.StatusOK).JSON(fiber.Map{
			"status": "ok",
		})
	})

	app.Get("/health/ready", func(c *fiber.Ctx) error {
		ctx, cancel := context.WithTimeout(context.Background(), cfg.ReadinessTimeout)
		defer cancel()

		checks := map[string]dependencyStatus{
			"postgres": readiness.postgres(ctx),
			"redis":    readiness.redis(ctx),
			"redpanda": readiness.redpanda(ctx),
		}

		ready := true
		for _, check := range checks {
			if check.Status != "ok" {
				ready = false
				break
			}
		}

		statusCode := fiber.StatusOK
		status := "ready"
		if !ready {
			metrics.ObserveReadinessFailure()
			statusCode = fiber.StatusServiceUnavailable
			status = "not_ready"
		}

		return c.Status(statusCode).JSON(fiber.Map{
			"status": status,
			"checks": checks,
		})
	})

	return app
}

var redisRateLimitScript = redis.NewScript(`
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
return count
`)

func redisRateLimit(client *redis.Client, max int, expiration time.Duration) fiber.Handler {
	return func(c *fiber.Ctx) error {
		ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		defer cancel()
		key := "chatify:rate-limit:api:" + c.IP()
		count, err := redisRateLimitScript.Run(ctx, client, []string{key}, expiration.Milliseconds()).Int64()
		if err != nil {
			return writeAPIError(c, fiber.StatusServiceUnavailable, "RATE_LIMIT_UNAVAILABLE", "rate-limit service unavailable")
		}
		if count > int64(max) {
			c.Set("Retry-After", strconv.Itoa(int(expiration.Seconds())))
			return writeAPIError(c, fiber.StatusTooManyRequests, "RATE_LIMITED", "too many requests")
		}
		return c.Next()
	}
}

func writeAPIError(c *fiber.Ctx, status int, code, message string) error {
	return c.Status(status).JSON(fiber.Map{
		"error": fiber.Map{"code": code, "message": message},
	})
}

func requireUser(cfg config, configured bool) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if !configured {
			return writeAPIError(c, fiber.StatusServiceUnavailable, "ROOMS_UNAVAILABLE", "rooms are temporarily unavailable")
		}
		authorization := c.Get("Authorization")
		parts := strings.SplitN(authorization, " ", 2)
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
			return writeAPIError(c, fiber.StatusUnauthorized, "UNAUTHENTICATED", "authentication required")
		}
		userID, err := auth.ParseAccessToken(parts[1], cfg.JWTSecret)
		if err != nil {
			return writeAPIError(c, fiber.StatusUnauthorized, "UNAUTHENTICATED", "authentication required")
		}
		c.Locals("userID", userID)
		return c.Next()
	}
}

func requireInternalService(cfg config, configured bool) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if !configured {
			return writeAPIError(c, fiber.StatusServiceUnavailable, "ROOMS_UNAVAILABLE", "rooms are temporarily unavailable")
		}
		if !validServiceToken(c.Get("X-Internal-Service-Token"), cfg.InternalServiceToken) {
			return writeAPIError(c, fiber.StatusUnauthorized, "INTERNAL_SERVICE_UNAUTHENTICATED", "internal service authentication required")
		}
		return requireUser(cfg, configured)(c)
	}
}

func requireService(cfg config, configured bool) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if !configured {
			return writeAPIError(c, fiber.StatusServiceUnavailable, "ROOMS_UNAVAILABLE", "rooms are temporarily unavailable")
		}
		if !validServiceToken(c.Get("X-Internal-Service-Token"), cfg.InternalServiceToken) {
			return writeAPIError(c, fiber.StatusUnauthorized, "INTERNAL_SERVICE_UNAUTHENTICATED", "internal service authentication required")
		}
		return c.Next()
	}
}

func validServiceToken(supplied, expected string) bool {
	if len(expected) < 32 || len(supplied) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(supplied), []byte(expected)) == 1
}

func setRefreshCookie(c *fiber.Ctx, tokens auth.TokenPair, secure bool) {
	c.Set(fiber.HeaderCacheControl, "no-store")
	c.Set(fiber.HeaderPragma, "no-cache")
	c.Cookie(&fiber.Cookie{
		Name:     "chatify_refresh",
		Value:    tokens.RefreshToken,
		Path:     "/api/v1/auth",
		HTTPOnly: true,
		Secure:   secure,
		SameSite: "Lax",
		Expires:  tokens.RefreshExpiresAt,
	})
}

type dependencyStatus struct {
	Status string `json:"status"`
}

func envOrDefault(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func envBool(key string, fallback bool) bool {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func envIntOrDefault(key string, fallback int) int {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 1 {
		return fallback
	}
	return parsed
}
