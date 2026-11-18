package auth

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestDirectMessagesStayBetweenActivePeers(t *testing.T) {
	if os.Getenv("CHATIFY_INTEGRATION") != "1" { t.Skip("set CHATIFY_INTEGRATION=1") }
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	service, err := NewPostgresService(os.Getenv("DATABASE_URL"))
	if err != nil { t.Fatal(err) }
	defer service.Close()
	a := createIntegrationUser(t, ctx, service)
	b := createIntegrationUser(t, ctx, service)
	c := createIntegrationUser(t, ctx, service)
	room, err := service.CreateRoom(ctx, a, RoomInput{Name: "dm-" + uuid.NewString(), MaxParticipants: 3})
	if err != nil { t.Fatal(err) }
	for _, id := range []string{b, c} { if _, err := service.JoinRoom(ctx, id, room.ID); err != nil { t.Fatal(err) } }
	input := ChatMessageInput{ClientMessageID: uuid.NewString(), Body: "private-test-value"}
	message, err := service.SendDirectMessage(ctx, a, room.ID, b, input)
	if err != nil || message.RecipientID != b { t.Fatalf("send: %+v %v", message, err) }
	duplicate, err := service.SendDirectMessage(ctx, a, room.ID, b, input)
	if err != nil || duplicate.ID != message.ID { t.Fatalf("idempotency: %+v %v", duplicate, err) }
	for _, id := range []string{a, b} {
		found, err := service.ListDirectMessages(ctx, id, room.ID, map[string]string{a:b, b:a}[id], 50, nil)
		if err != nil || len(found) != 1 || found[0].Body != input.Body { t.Fatalf("peer history: %+v %v", found, err) }
	}
	other, err := service.ListDirectMessages(ctx, c, room.ID, a, 50, nil)
	if err != nil || len(other) != 0 { t.Fatalf("third party saw private message: %+v %v", other, err) }
	if err := service.LeaveRoom(ctx, b, room.ID); err != nil { t.Fatal(err) }
	if _, err := service.SendDirectMessage(ctx, a, room.ID, b, ChatMessageInput{ClientMessageID: uuid.NewString(), Body: "after leave"}); !errors.Is(err, ErrNotMember) { t.Fatalf("sent to departed peer: %v", err) }
	if _, err := service.ListDirectMessages(ctx, a, room.ID, b, 50, nil); !errors.Is(err, ErrNotMember) { t.Fatalf("read departed peer history: %v", err) }
}
