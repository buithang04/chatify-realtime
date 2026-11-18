package auth

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestFriendsLockedRoomProfileAndPrivateMessages(t *testing.T) {
	if os.Getenv("CHATIFY_INTEGRATION") != "1" {
		t.Skip("set CHATIFY_INTEGRATION=1")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	s, err := NewPostgresService(os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	owner := createIntegrationUser(t, ctx, s)
	friend := createIntegrationUser(t, ctx, s)
	stranger := createIntegrationUser(t, ctx, s)
	defer func() {
		_, _ = s.pool.Exec(context.Background(), `DELETE FROM rooms WHERE owner_id IN ($1,$2,$3)`, owner, friend, stranger)
		for _, id := range []string{owner, friend, stranger} {
			_, _ = s.pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, id)
		}
	}()
	var email string
	if err := s.pool.QueryRow(ctx, `SELECT email FROM users WHERE id = $1`, friend).Scan(&email); err != nil {
		t.Fatal(err)
	}
	if err := s.RequestFriend(ctx, owner, email); err != nil {
		t.Fatal(err)
	}
	if err := s.RespondFriend(ctx, owner, friend, true); !errors.Is(err, ErrFriendRequest) {
		t.Fatalf("sender accepted own request: %v", err)
	}
	if err := s.RespondFriend(ctx, friend, owner, true); err != nil {
		t.Fatal(err)
	}
	friends, err := s.ListFriends(ctx, owner)
	if err != nil || len(friends) != 1 || friends[0].Status != "accepted" {
		t.Fatalf("friends=%+v err=%v", friends, err)
	}
	room, err := s.CreateRoom(ctx, owner, RoomInput{Name: "locked-test-" + uuid.NewString(), MaxParticipants: 4, Password: "secret12"})
	if err != nil || !room.IsLocked {
		t.Fatalf("room=%+v err=%v", room, err)
	}
	if _, err := s.JoinRoom(ctx, friend, room.ID); !errors.Is(err, ErrRoomPassword) {
		t.Fatalf("joined without password: %v", err)
	}
	if _, err := s.JoinRoomWithPassword(ctx, friend, room.ID, "wrong12"); !errors.Is(err, ErrRoomPassword) {
		t.Fatalf("joined with wrong password: %v", err)
	}
	if _, err := s.JoinRoomWithPassword(ctx, friend, room.ID, "secret12"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetRoomPassword(ctx, stranger, room.ID, "another12"); !errors.Is(err, ErrNotRoomOwner) {
		t.Fatalf("non-owner changed password: %v", err)
	}
	if locked, err := s.SetRoomPassword(ctx, owner, room.ID, "newsecret"); err != nil || !locked {
		t.Fatalf("lock=%v err=%v", locked, err)
	}
	if _, err := s.JoinRoomWithPassword(ctx, stranger, room.ID, "secret12"); !errors.Is(err, ErrRoomPassword) {
		t.Fatalf("old password worked: %v", err)
	}
	if _, err := s.JoinRoomWithPassword(ctx, stranger, room.ID, "newsecret"); err != nil {
		t.Fatal(err)
	}
	profile, err := s.UpdateProfile(ctx, friend, ProfileInput{DisplayName: "Friend New", AvatarData: ""})
	if err != nil || profile.DisplayName != "Friend New" {
		t.Fatalf("profile=%+v err=%v", profile, err)
	}
	if _, err := s.UpdateProfile(ctx, friend, ProfileInput{DisplayName: "Bad", AvatarData: "data:image/svg+xml;base64,PHN2Zz4="}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("accepted unsafe avatar: %v", err)
	}
	suggestions, err := s.ListSuggestedRooms(ctx, friend)
	if err != nil {
		t.Fatal(err)
	}
	for _, suggested := range suggestions {
		if suggested.ID == room.ID {
			t.Fatal("suggested a room already joined")
		}
	}
	second, err := s.CreateRoom(ctx, owner, RoomInput{Name: "friend-room-" + uuid.NewString(), MaxParticipants: 4, Password: "secret12"})
	if err != nil {
		t.Fatal(err)
	}
	suggestions, err = s.ListSuggestedRooms(ctx, friend)
	if err != nil || len(suggestions) != 1 || suggestions[0].ID != second.ID || !suggestions[0].IsLocked {
		t.Fatalf("suggestions=%+v err=%v", suggestions, err)
	}
	input := ChatMessageInput{ClientMessageID: uuid.NewString(), Body: "hello friend"}
	message, err := s.SendFriendMessage(ctx, owner, friend, input)
	if err != nil {
		t.Fatal(err)
	}
	retry, err := s.SendFriendMessage(ctx, owner, friend, input)
	if err != nil || retry.ID != message.ID {
		t.Fatalf("idempotency failed: %+v %v", retry, err)
	}
	messages, err := s.ListFriendMessages(ctx, friend, owner)
	if err != nil || len(messages) != 1 || messages[0].Body != input.Body {
		t.Fatalf("messages=%+v err=%v", messages, err)
	}
	if _, err := s.ListFriendMessages(ctx, stranger, owner); !errors.Is(err, ErrFriendNotFound) {
		t.Fatalf("stranger read messages: %v", err)
	}
	if err := s.RemoveFriend(ctx, owner, friend); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SendFriendMessage(ctx, owner, friend, ChatMessageInput{ClientMessageID: uuid.NewString(), Body: "blocked"}); !errors.Is(err, ErrFriendNotFound) {
		t.Fatalf("sent after removal: %v", err)
	}
	if err := s.LeaveRoom(ctx, owner, room.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetRoomPassword(ctx, owner, room.ID, "oldowner"); !errors.Is(err, ErrNotRoomOwner) {
		t.Fatalf("former owner changed lock: %v", err)
	}
	if locked, err := s.SetRoomPassword(ctx, friend, room.ID, "newowner"); err != nil || !locked {
		t.Fatalf("new owner cannot change lock: locked=%v err=%v", locked, err)
	}
}
