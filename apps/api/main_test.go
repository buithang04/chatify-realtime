package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"chatify-realtime/api/internal/auth"
	"github.com/gofiber/fiber/v2"
)

func TestLiveHealth(t *testing.T) {
	app := newApp(config{ReadinessTimeout: 50 * time.Millisecond})

	response, err := app.Test(httptest.NewRequest("GET", "/health/live", nil))
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != fiber.StatusOK {
		t.Fatalf("expected 200, got %d", response.StatusCode)
	}
}

func TestProductionConfigRejectsUnsafeDefaults(t *testing.T) {
	config := config{Environment: "production", JWTSecret: "01234567890123456789012345678901", CORSOrigin: "https://app.example.com", CookieSecure: false, ObjectStoragePublicEndpoint: "https://s3.example.com", DatabaseURL: "postgres://db", ObjectStorageAccessKey: "key", ObjectStorageSecretKey: "secret"}
	if err := config.validate(); err == nil {
		t.Fatal("expected insecure production config to be rejected")
	}
}

func TestProductionConfigAcceptsExplicitSecureValues(t *testing.T) {
	config := config{Environment: "production", InternalServiceToken: "01234567890123456789012345678901", JWTSecret: "01234567890123456789012345678901", CORSOrigin: "https://app.example.com", CookieSecure: true, ObjectStoragePublicEndpoint: "https://s3.example.com", DatabaseURL: "postgres://db", ObjectStorageAccessKey: "key", ObjectStorageSecretKey: "secret"}
	if err := config.validate(); err != nil {
		t.Fatalf("expected secure production config, got %v", err)
	}
}

func TestProductionConfigRequiresInternalServiceToken(t *testing.T) {
	config := config{Environment: "production", JWTSecret: "01234567890123456789012345678901", CORSOrigin: "https://app.example.com", CookieSecure: true, ObjectStoragePublicEndpoint: "https://s3.example.com", DatabaseURL: "postgres://db", ObjectStorageAccessKey: "key", ObjectStorageSecretKey: "secret"}
	if err := config.validate(); err == nil || !strings.Contains(err.Error(), "INTERNAL_SERVICE_TOKEN") {
		t.Fatalf("expected internal service token validation error, got %v", err)
	}
}

func TestRequestBodyLimitIsEnforced(t *testing.T) {
	app := newAppWithAuth(config{ReadinessTimeout: 50 * time.Millisecond, MaxBodyBytes: 32}, failingReadinessChecks(), fakeAuthService{})
	request := httptest.NewRequest("POST", "/api/v1/auth/register", strings.NewReader(`{"email":"large@example.com","displayName":"This body is intentionally too large","password":"correct horse battery staple"}`))
	request.Header.Set("Content-Type", "application/json")
	response, err := app.Test(request)
	if err != nil {
		if !strings.Contains(err.Error(), "body size exceeds the given limit") {
			t.Fatalf("expected body-limit error, got %v", err)
		}
		return
	}
	if response.StatusCode != fiber.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413, got %d", response.StatusCode)
	}
}

func TestSecurityHeadersArePresent(t *testing.T) {
	app := newApp(config{ReadinessTimeout: 50 * time.Millisecond})
	response, err := app.Test(httptest.NewRequest("GET", "/health/live", nil))
	if err != nil {
		t.Fatal(err)
	}
	checks := map[string]string{
		"X-Content-Type-Options":  "nosniff",
		"X-Frame-Options":         "DENY",
		"Referrer-Policy":         "no-referrer",
		"Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
	}
	for header, expected := range checks {
		if actual := response.Header.Get(header); actual != expected {
			t.Fatalf("expected %s=%q, got %q", header, expected, actual)
		}
	}
}

func TestResponsesAreCompressedWhenRequested(t *testing.T) {
	app := newApp(config{ReadinessTimeout: 50 * time.Millisecond})
	app.Get("/test-large-response", func(c *fiber.Ctx) error {
		return c.SendString(strings.Repeat("payload ", 600))
	})
	request := httptest.NewRequest("GET", "/test-large-response", nil)
	request.Header.Set("Accept-Encoding", "gzip")
	response, err := app.Test(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.Header.Get("Content-Encoding") != "gzip" {
		t.Fatalf("expected gzip response, got %q", response.Header.Get("Content-Encoding"))
	}
}

func TestAPIRateLimitReturns429(t *testing.T) {
	app := newAppWithAuth(config{ReadinessTimeout: 50 * time.Millisecond, APIRateLimitMax: 1, RateLimitExpiration: time.Minute}, failingReadinessChecks(), fakeAuthService{
		registerFn: func(_ context.Context, input auth.RegistrationInput) (auth.User, error) {
			return auth.User{ID: "rate-user", Email: input.Email, DisplayName: input.DisplayName, CreatedAt: time.Unix(0, 0).UTC()}, nil
		},
	})
	request := func() *http.Response {
		req := httptest.NewRequest("POST", "/api/v1/auth/register", strings.NewReader(`{"email":"rate@example.com","displayName":"Rate","password":"correct horse battery staple"}`))
		req.Header.Set("Content-Type", "application/json")
		response, err := app.Test(req)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}
	if first := request(); first.StatusCode != fiber.StatusCreated {
		t.Fatalf("expected first request 201, got %d", first.StatusCode)
	}
	second := request()
	if second.StatusCode != fiber.StatusTooManyRequests || second.Header.Get("Retry-After") == "" {
		t.Fatalf("expected rate limit 429 with Retry-After, got %d", second.StatusCode)
	}
}

type fakeSessionService struct{}

func (fakeSessionService) CreateTokenPair(context.Context, auth.User, string) (auth.TokenPair, error) {
	return auth.TokenPair{}, nil
}

func (fakeSessionService) RotateTokenPair(context.Context, string, string) (auth.User, auth.TokenPair, error) {
	return auth.User{}, auth.TokenPair{}, auth.ErrInvalidRefreshToken
}
func (fakeSessionService) RevokeRefreshToken(context.Context, string) error { return nil }

func TestRefreshWithoutCookieReturnsNoContent(t *testing.T) {
	app := newAppWithAuth(config{ReadinessTimeout: time.Millisecond}, failingReadinessChecks(), fakeAuthService{}, fakeSessionService{})
	response, err := app.Test(httptest.NewRequest("POST", "/api/v1/auth/refresh", nil))
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != fiber.StatusNoContent {
		t.Fatalf("expected 204, got %d", response.StatusCode)
	}
}

func TestReadyHealthReturnsUnavailableWhenDependencyFails(t *testing.T) {
	app := newAppWithReadinessChecks(config{ReadinessTimeout: 50 * time.Millisecond}, failingReadinessChecks())

	response, err := app.Test(httptest.NewRequest("GET", "/health/ready", nil))
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != fiber.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", response.StatusCode)
	}
}

func TestReadyHealthReturnsOKWhenDependenciesAcceptTCP(t *testing.T) {
	app := newAppWithReadinessChecks(config{ReadinessTimeout: 100 * time.Millisecond}, readinessChecks{
		postgres: func(context.Context) dependencyStatus { return dependencyStatus{Status: "ok"} },
		redis:    func(context.Context) dependencyStatus { return dependencyStatus{Status: "ok"} },
		redpanda: func(context.Context) dependencyStatus { return dependencyStatus{Status: "ok"} },
	})

	response, err := app.Test(httptest.NewRequest("GET", "/health/ready", nil))
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != fiber.StatusOK {
		t.Fatalf("expected 200, got %d", response.StatusCode)
	}

}

func failingReadinessChecks() readinessChecks {
	failed := func(context.Context) dependencyStatus { return dependencyStatus{Status: "failed"} }
	return readinessChecks{postgres: failed, redis: failed, redpanda: failed}
}

func TestRunServerShutsDownOnSignal(t *testing.T) {
	signals := make(chan os.Signal, 1)
	serverDone := make(chan error, 1)

	go func() {
		serverDone <- runServer(newApp(config{}), "127.0.0.1:0", signals)
	}()

	time.Sleep(25 * time.Millisecond)
	signals <- os.Interrupt

	select {
	case err := <-serverDone:
		if err != nil {
			t.Fatalf("expected graceful shutdown, got %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("server did not shut down after signal")
	}
}
