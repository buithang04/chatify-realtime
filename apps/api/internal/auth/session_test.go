package auth

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestRefreshTokenContainsSessionIDAndIsNotReusableAsAccessToken(t *testing.T) {
	id := "00000000-0000-0000-0000-000000000001"
	token, err := newRefreshToken(id)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(token, id+".") {
		t.Fatalf("refresh token does not carry session id prefix: %q", token)
	}
	if len(tokenHash(token)) == 0 || bytes.Equal(tokenHash(token), []byte(token)) {
		t.Fatal("refresh token hash is invalid")
	}
}

func TestParseAccessTokenRequiresIssuerAndReturnsSubject(t *testing.T) {
	secret := "01234567890123456789012345678901"
	now := time.Now().UTC()
	token, err := signAccessToken("user-1", "session-1", now, now.Add(time.Minute), secret)
	if err != nil {
		t.Fatal(err)
	}
	userID, err := ParseAccessToken(token, secret)
	if err != nil || userID != "user-1" {
		t.Fatalf("unexpected parsed subject %q, err=%v", userID, err)
	}
	if _, err := ParseAccessToken(token, "wrong-secret-that-is-long-enough-123"); err != ErrInvalidAccessToken {
		t.Fatalf("expected invalid access token, got %v", err)
	}
}
