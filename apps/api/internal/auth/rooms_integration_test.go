package auth

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestRoomMembershipCapacityIsRaceSafe(t *testing.T) {
	if os.Getenv("CHATIFY_INTEGRATION") != "1" {
		t.Skip("set CHATIFY_INTEGRATION=1 to run against PostgreSQL")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	service, err := NewPostgresService(os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()

	ownerID := createIntegrationUser(t, ctx, service)
	room, err := service.CreateRoom(ctx, ownerID, RoomInput{Name: "race-capacity-" + uuid.NewString(), MaxParticipants: 2})
	if err != nil {
		t.Fatal(err)
	}

	const contenderCount = 8
	users := make([]string, contenderCount)
	for i := range users {
		users[i] = createIntegrationUser(t, ctx, service)
	}

	var waitGroup sync.WaitGroup
	results := make(chan error, contenderCount)
	for _, userID := range users {
		waitGroup.Add(1)
		go func(userID string) {
			defer waitGroup.Done()
			_, joinErr := service.JoinRoom(ctx, userID, room.ID)
			results <- joinErr
		}(userID)
	}
	waitGroup.Wait()
	close(results)

	joined, full := 0, 0
	for joinErr := range results {
		switch {
		case joinErr == nil:
			joined++
		case errors.Is(joinErr, ErrRoomFull):
			full++
		default:
			t.Fatalf("unexpected concurrent join error: %v", joinErr)
		}
	}
	if joined != 1 || full != contenderCount-1 {
		t.Fatalf("expected one successful join and %d full responses; got joined=%d full=%d", contenderCount-1, joined, full)
	}
}

func TestLeavingMembershipIsIdempotentUnderConcurrentRequests(t *testing.T) {
	if os.Getenv("CHATIFY_INTEGRATION") != "1" {
		t.Skip("set CHATIFY_INTEGRATION=1 to run against PostgreSQL")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	service, err := NewPostgresService(os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()

	ownerID := createIntegrationUser(t, ctx, service)
	memberID := createIntegrationUser(t, ctx, service)
	room, err := service.CreateRoom(ctx, ownerID, RoomInput{Name: "race-leave-" + uuid.NewString(), MaxParticipants: 4})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.JoinRoom(ctx, memberID, room.ID); err != nil {
		t.Fatal(err)
	}

	var waitGroup sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			results <- service.LeaveRoom(ctx, memberID, room.ID)
		}()
	}
	waitGroup.Wait()
	close(results)

	succeeded, notMember := 0, 0
	for leaveErr := range results {
		switch {
		case leaveErr == nil:
			succeeded++
		case errors.Is(leaveErr, ErrNotMember):
			notMember++
		default:
			t.Fatalf("unexpected concurrent leave error: %v", leaveErr)
		}
	}
	if succeeded != 1 || notMember != 1 {
		t.Fatalf("expected one successful leave and one not-member response; got succeeded=%d notMember=%d", succeeded, notMember)
	}
}

func TestOwnerLeaveTransfersRoleAndOldOwnerRejoinsAsParticipant(t *testing.T) {
	if os.Getenv("CHATIFY_INTEGRATION") != "1" {
		t.Skip("set CHATIFY_INTEGRATION=1 to run against PostgreSQL")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	service, err := NewPostgresService(os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()

	ownerID := createIntegrationUser(t, ctx, service)
	guestID := createIntegrationUser(t, ctx, service)
	room, err := service.CreateRoom(ctx, ownerID, RoomInput{Name: "resume-" + uuid.NewString(), MaxParticipants: 2})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.JoinRoom(ctx, guestID, room.ID); err != nil {
		t.Fatal(err)
	}
	for _, userID := range []string{ownerID, guestID} {
		resumed, err := service.JoinRoom(ctx, userID, room.ID)
		if err != nil || resumed.ID != room.ID {
			t.Fatalf("active member %s cannot resume: room=%+v err=%v", userID, resumed, err)
		}
	}
	if err := service.LeaveRoom(ctx, ownerID, room.ID); err != nil {
		t.Fatal(err)
	}
	guestPolicy, err := service.MediaPolicy(ctx, guestID, room.ID)
	if err != nil || guestPolicy.Role != "owner" || !guestPolicy.CanModerate {
		t.Fatalf("remaining member was not promoted: policy=%+v err=%v", guestPolicy, err)
	}
	if _, err := service.JoinRoom(ctx, ownerID, room.ID); err != nil {
		t.Fatal(err)
	}
	policy, err := service.MediaPolicy(ctx, ownerID, room.ID)
	if err != nil || policy.Role != "participant" || policy.CanModerate {
		t.Fatalf("departed owner regained role after rejoin: policy=%+v err=%v", policy, err)
	}
}

func TestOwnerLeavePrefersModeratorOverEarlierParticipant(t *testing.T) {
	if os.Getenv("CHATIFY_INTEGRATION") != "1" {
		t.Skip("set CHATIFY_INTEGRATION=1 to run against PostgreSQL")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	service, err := NewPostgresService(os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	ownerID := createIntegrationUser(t, ctx, service)
	earlyID := createIntegrationUser(t, ctx, service)
	moderatorID := createIntegrationUser(t, ctx, service)
	room, err := service.CreateRoom(ctx, ownerID, RoomInput{Name: "moderator-handoff-" + uuid.NewString(), MaxParticipants: 4})
	if err != nil {
		t.Fatal(err)
	}
	for _, userID := range []string{earlyID, moderatorID} {
		if _, err := service.JoinRoom(ctx, userID, room.ID); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := service.pool.Exec(ctx, `UPDATE room_members SET role = 'moderator' WHERE room_id = $1 AND user_id = $2`, room.ID, moderatorID); err != nil {
		t.Fatal(err)
	}
	if err := service.LeaveRoom(ctx, ownerID, room.ID); err != nil {
		t.Fatal(err)
	}
	policy, err := service.MediaPolicy(ctx, moderatorID, room.ID)
	if err != nil || policy.Role != "owner" {
		t.Fatalf("moderator was not promoted: policy=%+v err=%v", policy, err)
	}
	policy, err = service.MediaPolicy(ctx, earlyID, room.ID)
	if err != nil || policy.Role != "participant" {
		t.Fatalf("earlier participant changed role: policy=%+v err=%v", policy, err)
	}
}

func TestRecentRoomsOnlyIncludeRoomsWithActiveMembers(t *testing.T) {
	if os.Getenv("CHATIFY_INTEGRATION") != "1" {
		t.Skip("set CHATIFY_INTEGRATION=1 to run against PostgreSQL")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	service, err := NewPostgresService(os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	ownerID := createIntegrationUser(t, ctx, service)
	guestID := createIntegrationUser(t, ctx, service)
	room, err := service.CreateRoom(ctx, ownerID, RoomInput{Name: "recent-" + uuid.NewString(), MaxParticipants: 2})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.JoinRoom(ctx, guestID, room.ID); err != nil {
		t.Fatal(err)
	}
	if err := service.LeaveRoom(ctx, guestID, room.ID); err != nil {
		t.Fatal(err)
	}
	recent, err := service.ListRecentRooms(ctx, guestID)
	if err != nil || len(recent) != 1 || recent[0].ID != room.ID || recent[0].ActiveMemberCount != 1 {
		t.Fatalf("active room should remain in recent list: rooms=%+v err=%v", recent, err)
	}
	if err := service.LeaveRoom(ctx, ownerID, room.ID); err != nil {
		t.Fatal(err)
	}
	recent, err = service.ListRecentRooms(ctx, guestID)
	if err != nil || len(recent) != 0 {
		t.Fatalf("empty room remained in recent list: rooms=%+v err=%v", recent, err)
	}
}

func TestLogoutRevokesRefreshToken(t *testing.T) {
	if os.Getenv("CHATIFY_INTEGRATION") != "1" {
		t.Skip("set CHATIFY_INTEGRATION=1 to run against PostgreSQL")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	service, err := NewPostgresService(os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	id := createIntegrationUser(t, ctx, service)
	user := User{ID: id}
	secret := "test-only-secret-at-least-32-characters-long"
	tokens, err := service.CreateTokenPair(ctx, user, secret)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.RevokeRefreshToken(ctx, tokens.RefreshToken); err != nil {
		t.Fatal(err)
	}
	if _, _, err := service.RotateTokenPair(ctx, tokens.RefreshToken, secret); !errors.Is(err, ErrInvalidRefreshToken) {
		t.Fatalf("revoked refresh token must not rotate: %v", err)
	}
}

func TestRoomMemberListRequiresMembershipAndShowsNames(t *testing.T) {
	if os.Getenv("CHATIFY_INTEGRATION") != "1" {
		t.Skip("set CHATIFY_INTEGRATION=1 to run against PostgreSQL")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	service, err := NewPostgresService(os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	ownerID := createIntegrationUser(t, ctx, service)
	guestID := createIntegrationUser(t, ctx, service)
	room, err := service.CreateRoom(ctx, ownerID, RoomInput{Name: "members-" + uuid.NewString(), MaxParticipants: 2})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.ListRoomMembers(ctx, guestID, room.ID); !errors.Is(err, ErrNotMember) {
		t.Fatalf("non-member got roster: %v", err)
	}
	if _, err := service.JoinRoom(ctx, guestID, room.ID); err != nil {
		t.Fatal(err)
	}
	members, err := service.ListRoomMembers(ctx, ownerID, room.ID)
	if err != nil || len(members) != 2 || members[0].UserID != ownerID || members[0].DisplayName != "Integration User" || members[0].Role != "owner" {
		t.Fatalf("unexpected room roster: members=%+v err=%v", members, err)
	}
	if err := service.LeaveRoom(ctx, guestID, room.ID); err != nil {
		t.Fatal(err)
	}
	members, err = service.ListRoomMembers(ctx, ownerID, room.ID)
	if err != nil || len(members) != 1 {
		t.Fatalf("leaving member still listed: members=%+v err=%v", members, err)
	}
}

func createIntegrationUser(t *testing.T, ctx context.Context, service *PostgresService) string {
	t.Helper()
	id := uuid.NewString()
	email := fmt.Sprintf("integration-%s@example.com", id)
	if _, err := service.pool.Exec(ctx, `
		INSERT INTO users (id, email, display_name, password_hash)
		VALUES ($1, $2, 'Integration User', 'integration-test-hash')`, id, email); err != nil {
		t.Fatal(err)
	}
	return id
}
