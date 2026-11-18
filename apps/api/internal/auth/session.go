package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	accessTokenTTL  = 15 * time.Minute
	refreshTokenTTL = 30 * 24 * time.Hour
)

type TokenPair struct {
	AccessToken      string    `json:"accessToken"`
	RefreshToken     string    `json:"-"`
	AccessExpiresAt  time.Time `json:"accessExpiresAt"`
	RefreshExpiresAt time.Time `json:"refreshExpiresAt"`
}

var ErrInvalidRefreshToken = errors.New("invalid refresh token")
var ErrInvalidAccessToken = errors.New("invalid access token")

func newRefreshToken(sessionID string) (string, error) {
	randomBytes := make([]byte, 32)
	if _, err := rand.Read(randomBytes); err != nil {
		return "", err
	}
	return sessionID + "." + base64.RawURLEncoding.EncodeToString(randomBytes), nil
}

func tokenHash(token string) []byte {
	hash := sha256.Sum256([]byte(token))
	return hash[:]
}

func (s *PostgresService) CreateTokenPair(ctx context.Context, user User, jwtSecret string) (TokenPair, error) {
	if len(jwtSecret) < 32 {
		return TokenPair{}, errors.New("jwt secret is too short")
	}
	sessionID := uuid.NewString()
	refreshToken, err := newRefreshToken(sessionID)
	if err != nil {
		return TokenPair{}, err
	}
	now := time.Now().UTC()
	refreshExpiresAt := now.Add(refreshTokenTTL)
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at)
		VALUES ($1, $2, $3, $4)`, sessionID, user.ID, tokenHash(refreshToken), refreshExpiresAt); err != nil {
		return TokenPair{}, err
	}
	accessExpiresAt := now.Add(accessTokenTTL)
	accessToken, err := signAccessToken(user.ID, sessionID, now, accessExpiresAt, jwtSecret)
	if err != nil {
		return TokenPair{}, err
	}
	return TokenPair{AccessToken: accessToken, RefreshToken: refreshToken, AccessExpiresAt: accessExpiresAt, RefreshExpiresAt: refreshExpiresAt}, nil
}

func signAccessToken(userID, sessionID string, now, expiresAt time.Time, secret string) (string, error) {
	claims := jwt.RegisteredClaims{
		Subject:   userID,
		ID:        sessionID,
		Issuer:    "chatify-api",
		IssuedAt:  jwt.NewNumericDate(now),
		ExpiresAt: jwt.NewNumericDate(expiresAt),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString([]byte(secret))
}

func ParseAccessToken(tokenString, secret string) (string, error) {
	if len(secret) < 32 || tokenString == "" {
		return "", ErrInvalidAccessToken
	}
	claims := jwt.RegisteredClaims{}
	token, err := jwt.ParseWithClaims(tokenString, &claims, func(token *jwt.Token) (any, error) {
		if token.Method != jwt.SigningMethodHS256 {
			return nil, ErrInvalidAccessToken
		}
		return []byte(secret), nil
	}, jwt.WithIssuer("chatify-api"))
	if err != nil || !token.Valid || claims.Subject == "" || claims.ID == "" {
		return "", ErrInvalidAccessToken
	}
	return claims.Subject, nil
}

func (s *PostgresService) RotateTokenPair(ctx context.Context, refreshToken, jwtSecret string) (User, TokenPair, error) {
	if len(jwtSecret) < 32 {
		return User{}, TokenPair{}, ErrInvalidRefreshToken
	}
	parts := strings.SplitN(refreshToken, ".", 2)
	if len(parts) != 2 || len(parts[0]) != 36 {
		return User{}, TokenPair{}, ErrInvalidRefreshToken
	}
	sessionID, err := uuid.Parse(parts[0])
	if err != nil {
		return User{}, TokenPair{}, ErrInvalidRefreshToken
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return User{}, TokenPair{}, err
	}
	defer tx.Rollback(ctx)

	var userID string
	var storedHash []byte
	var expiresAt time.Time
	var revokedAt *time.Time
	err = tx.QueryRow(ctx, `
		SELECT user_id::text, refresh_token_hash, expires_at, revoked_at
		FROM sessions WHERE id = $1 FOR UPDATE`, sessionID).
		Scan(&userID, &storedHash, &expiresAt, &revokedAt)
	if errors.Is(err, pgx.ErrNoRows) || err != nil {
		return User{}, TokenPair{}, ErrInvalidRefreshToken
	}
	if revokedAt != nil || time.Now().UTC().After(expiresAt) || !equalBytes(storedHash, tokenHash(refreshToken)) {
		return User{}, TokenPair{}, ErrInvalidRefreshToken
	}

	newSessionID := uuid.NewString()
	newRefresh, err := newRefreshToken(newSessionID)
	if err != nil {
		return User{}, TokenPair{}, err
	}
	now := time.Now().UTC()
	newRefreshExpiresAt := now.Add(refreshTokenTTL)
	if _, err := tx.Exec(ctx, `
		INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at)
		VALUES ($1, $2, $3, $4)`, newSessionID, userID, tokenHash(newRefresh), newRefreshExpiresAt); err != nil {
		return User{}, TokenPair{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE sessions SET revoked_at = $2, replaced_by = $3, last_used_at = $2 WHERE id = $1`, sessionID, now, newSessionID); err != nil {
		return User{}, TokenPair{}, err
	}
	var user User
	err = tx.QueryRow(ctx, `SELECT id::text, email, display_name, avatar_data, created_at FROM users WHERE id = $1`, userID).
		Scan(&user.ID, &user.Email, &user.DisplayName, &user.AvatarData, &user.CreatedAt)
	if err != nil {
		return User{}, TokenPair{}, ErrInvalidRefreshToken
	}
	if err := tx.Commit(ctx); err != nil {
		return User{}, TokenPair{}, err
	}
	accessExpiresAt := now.Add(accessTokenTTL)
	accessToken, err := signAccessToken(user.ID, newSessionID, now, accessExpiresAt, jwtSecret)
	if err != nil {
		return User{}, TokenPair{}, err
	}
	return user, TokenPair{AccessToken: accessToken, RefreshToken: newRefresh, AccessExpiresAt: accessExpiresAt, RefreshExpiresAt: newRefreshExpiresAt}, nil
}

func (s *PostgresService) RevokeRefreshToken(ctx context.Context, refreshToken string) error {
	parts := strings.SplitN(refreshToken, ".", 2)
	if len(parts) != 2 {
		return nil
	}
	sessionID, err := uuid.Parse(parts[0])
	if err != nil {
		return nil
	}
	_, err = s.pool.Exec(ctx, `
		UPDATE sessions SET revoked_at = now()
		WHERE id = $1 AND refresh_token_hash = $2 AND revoked_at IS NULL`, sessionID, tokenHash(refreshToken))
	return err
}

func equalBytes(left, right []byte) bool {
	if len(left) != len(right) {
		return false
	}
	var value byte
	for i := range left {
		value |= left[i] ^ right[i]
	}
	return value == 0
}
