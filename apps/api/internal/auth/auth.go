package auth

import (
	"context"
	"errors"
	"net/mail"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

var (
	ErrInvalidInput       = errors.New("invalid input")
	ErrInvalidCredentials = errors.New("invalid credentials")
	ErrEmailAlreadyUsed   = errors.New("email already used")
)

type RegistrationInput struct {
	Email       string `json:"email"`
	DisplayName string `json:"displayName"`
	Password    string `json:"password"`
}

type LoginInput struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type User struct {
	ID          string
	Email       string
	DisplayName string
	AvatarData  string
	CreatedAt   time.Time
}

type PublicUser struct {
	ID          string    `json:"id"`
	Email       string    `json:"email"`
	DisplayName string    `json:"displayName"`
	AvatarData  string    `json:"avatarData"`
	CreatedAt   time.Time `json:"createdAt"`
}

func (u User) Public() PublicUser {
	return PublicUser{ID: u.ID, Email: u.Email, DisplayName: u.DisplayName, AvatarData: u.AvatarData, CreatedAt: u.CreatedAt}
}

func ValidateRegistration(input RegistrationInput) (RegistrationInput, error) {
	input.Email = normalizeEmail(input.Email)
	input.DisplayName = strings.TrimSpace(input.DisplayName)
	if !validEmail(input.Email) || input.DisplayName == "" || utf8.RuneCountInString(input.DisplayName) > 80 {
		return RegistrationInput{}, ErrInvalidInput
	}
	if utf8.RuneCountInString(input.Password) < 12 || utf8.RuneCountInString(input.Password) > 128 {
		return RegistrationInput{}, ErrInvalidInput
	}
	return input, nil
}

func ValidateLogin(input LoginInput) (LoginInput, error) {
	input.Email = normalizeEmail(input.Email)
	if !validEmail(input.Email) || input.Password == "" || utf8.RuneCountInString(input.Password) > 128 {
		return LoginInput{}, ErrInvalidInput
	}
	return input, nil
}

func normalizeEmail(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func validEmail(value string) bool {
	parsed, err := mail.ParseAddress(value)
	return err == nil && parsed.Address == value && strings.Contains(value, "@") && len(value) <= 254
}

func HashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), 12)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

func VerifyPassword(hash, password string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}

type PostgresService struct {
	pool *pgxpool.Pool
}

type PoolStats struct {
	MaxConns          int32
	TotalConns        int32
	AcquiredConns     int32
	IdleConns         int32
	EmptyAcquireCount int64
}

func NewPostgresService(databaseURL string) (*PostgresService, error) {
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		return nil, err
	}
	return &PostgresService{pool: pool}, nil
}

func (s *PostgresService) Close() {
	if s != nil && s.pool != nil {
		s.pool.Close()
	}
}

func (s *PostgresService) PoolStats() PoolStats {
	if s == nil || s.pool == nil {
		return PoolStats{}
	}
	stats := s.pool.Stat()
	return PoolStats{
		MaxConns:          stats.MaxConns(),
		TotalConns:        stats.TotalConns(),
		AcquiredConns:     stats.AcquiredConns(),
		IdleConns:         stats.IdleConns(),
		EmptyAcquireCount: stats.EmptyAcquireCount(),
	}
}

func (s *PostgresService) Register(ctx context.Context, input RegistrationInput) (User, error) {
	input, err := ValidateRegistration(input)
	if err != nil {
		return User{}, err
	}
	hash, err := HashPassword(input.Password)
	if err != nil {
		return User{}, err
	}
	var user User
	err = s.pool.QueryRow(ctx, `
		INSERT INTO users (email, display_name, password_hash)
		VALUES ($1, $2, $3)
		RETURNING id::text, email, display_name, avatar_data, created_at`, input.Email, input.DisplayName, hash).
		Scan(&user.ID, &user.Email, &user.DisplayName, &user.AvatarData, &user.CreatedAt)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return User{}, ErrEmailAlreadyUsed
		}
		return User{}, err
	}
	return user, nil
}

func (s *PostgresService) Authenticate(ctx context.Context, input LoginInput) (User, error) {
	input, err := ValidateLogin(input)
	if err != nil {
		return User{}, ErrInvalidCredentials
	}
	var user User
	var hash string
	err = s.pool.QueryRow(ctx, `
		SELECT id::text, email, display_name, avatar_data, password_hash, created_at
		FROM users WHERE email = $1`, input.Email).
		Scan(&user.ID, &user.Email, &user.DisplayName, &user.AvatarData, &hash, &user.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) || err != nil && !errors.Is(err, pgx.ErrNoRows) {
		if err != nil {
			return User{}, ErrInvalidCredentials
		}
	}
	if !VerifyPassword(hash, input.Password) {
		return User{}, ErrInvalidCredentials
	}
	return user, nil
}
