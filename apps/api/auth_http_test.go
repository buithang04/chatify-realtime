package main

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"chatify-realtime/api/internal/auth"
	"github.com/gofiber/fiber/v2"
)

type fakeAuthService struct {
	registerFn func(context.Context, auth.RegistrationInput) (auth.User, error)
	loginFn    func(context.Context, auth.LoginInput) (auth.User, error)
}

func (f fakeAuthService) Register(ctx context.Context, input auth.RegistrationInput) (auth.User, error) {
	return f.registerFn(ctx, input)
}

func (f fakeAuthService) Authenticate(ctx context.Context, input auth.LoginInput) (auth.User, error) {
	return f.loginFn(ctx, input)
}

func TestRegisterReturnsCreatedPublicUser(t *testing.T) {
	service := fakeAuthService{
		registerFn: func(_ context.Context, input auth.RegistrationInput) (auth.User, error) {
			if input.Email != "alice@example.com" {
				t.Fatalf("expected normalized email, got %q", input.Email)
			}
			return auth.User{ID: "user-1", Email: input.Email, DisplayName: input.DisplayName, CreatedAt: time.Unix(0, 0).UTC()}, nil
		},
	}
	app := newAppWithAuth(config{ReadinessTimeout: time.Millisecond}, failingReadinessChecks(), service)
	request := httptest.NewRequest("POST", "/api/v1/auth/register", strings.NewReader(`{"email":" Alice@Example.com ","displayName":"Alice","password":"correct horse battery staple"}`))
	request.Header.Set("Content-Type", "application/json")

	response, err := app.Test(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != fiber.StatusCreated {
		t.Fatalf("expected 201, got %d", response.StatusCode)
	}
	var body struct {
		User auth.PublicUser `json:"user"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.User.Email != "alice@example.com" || body.User.ID != "user-1" {
		t.Fatalf("unexpected response: %+v", body.User)
	}
}

func TestLoginReturnsUnauthorizedWithoutLeakingCredentialDetails(t *testing.T) {
	service := fakeAuthService{
		loginFn: func(context.Context, auth.LoginInput) (auth.User, error) {
			return auth.User{}, auth.ErrInvalidCredentials
		},
	}
	app := newAppWithAuth(config{ReadinessTimeout: time.Millisecond}, failingReadinessChecks(), service)
	request := httptest.NewRequest("POST", "/api/v1/auth/login", strings.NewReader(`{"email":"alice@example.com","password":"wrong password"}`))
	request.Header.Set("Content-Type", "application/json")

	response, err := app.Test(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != fiber.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", response.StatusCode)
	}
	var body map[string]any
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if stringBody, _ := json.Marshal(body); string(stringBody) != `{"error":{"code":"INVALID_CREDENTIALS","message":"invalid email or password"}}` {
		t.Fatalf("unexpected generic error response: %s", stringBody)
	}
}

func TestRegisterRejectsInvalidPayload(t *testing.T) {
	app := newAppWithAuth(config{ReadinessTimeout: time.Millisecond}, failingReadinessChecks(), fakeAuthService{})
	request := httptest.NewRequest("POST", "/api/v1/auth/register", strings.NewReader(`{"email":"bad","displayName":"","password":"short"}`))
	request.Header.Set("Content-Type", "application/json")

	response, err := app.Test(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != fiber.StatusUnprocessableEntity {
		t.Fatalf("expected 422, got %d", response.StatusCode)
	}
}
