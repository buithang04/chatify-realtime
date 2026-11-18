package auth

import (
	"testing"

	"golang.org/x/crypto/bcrypt"
)

func TestNormalizeAndValidateRegistration(t *testing.T) {
	input, err := ValidateRegistration(RegistrationInput{
		Email:       "  Alice@Example.COM ",
		DisplayName: " Alice ",
		Password:    "correct horse battery staple",
	})
	if err != nil {
		t.Fatal(err)
	}
	if input.Email != "alice@example.com" || input.DisplayName != "Alice" {
		t.Fatalf("unexpected normalized input: %+v", input)
	}
}

func TestValidateRegistrationRejectsWeakPassword(t *testing.T) {
	_, err := ValidateRegistration(RegistrationInput{
		Email:       "alice@example.com",
		DisplayName: "Alice",
		Password:    "short",
	})
	if err != ErrInvalidInput {
		t.Fatalf("expected ErrInvalidInput, got %v", err)
	}
}

func TestPasswordHashDoesNotStorePlaintextAndVerifies(t *testing.T) {
	password := "correct horse battery staple"
	hash, err := HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	if hash == password {
		t.Fatal("password hash contains plaintext")
	}
	cost, err := bcrypt.Cost([]byte(hash))
	if err != nil || cost < 12 {
		t.Fatalf("expected bcrypt cost >= 12, got %d (err=%v)", cost, err)
	}
	if !VerifyPassword(hash, password) || VerifyPassword(hash, "wrong password") {
		t.Fatal("password verification result is incorrect")
	}
}
