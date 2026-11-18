package main

import (
	"context"
	"errors"
	"time"

	"chatify-realtime/api/internal/auth"
	"github.com/gofiber/fiber/v2"
)

type socialService interface {
	GetProfile(context.Context, string) (auth.PublicUser, error)
	UpdateProfile(context.Context, string, auth.ProfileInput) (auth.PublicUser, error)
	ListFriends(context.Context, string) ([]auth.Friend, error)
	RequestFriend(context.Context, string, string) error
	RespondFriend(context.Context, string, string, bool) error
	RemoveFriend(context.Context, string, string) error
	ListSuggestedRooms(context.Context, string) ([]auth.SuggestedRoom, error)
	SendFriendMessage(context.Context, string, string, auth.ChatMessageInput) (auth.FriendMessage, error)
	ListFriendMessages(context.Context, string, string) ([]auth.FriendMessage, error)
}

func registerSocialRoutes(app *fiber.App, cfg config, service authService) {
	social, ok := service.(socialService)
	guard := requireUser(cfg, ok)
	app.Get("/api/v1/profile", guard, func(c *fiber.Ctx) error {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		user, err := social.GetProfile(ctx, c.Locals("userID").(string))
		if err != nil {
			return writeAPIError(c, 500, "INTERNAL_ERROR", "Không tải được hồ sơ")
		}
		return c.JSON(fiber.Map{"user": user})
	})
	app.Patch("/api/v1/profile", guard, func(c *fiber.Ctx) error {
		var input auth.ProfileInput
		if c.BodyParser(&input) != nil {
			return writeAPIError(c, 422, "VALIDATION_ERROR", "Dữ liệu hồ sơ không hợp lệ")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		user, err := social.UpdateProfile(ctx, c.Locals("userID").(string), input)
		if errors.Is(err, auth.ErrInvalidInput) {
			return writeAPIError(c, 422, "VALIDATION_ERROR", "Tên hoặc ảnh đại diện không hợp lệ")
		}
		if err != nil {
			return writeAPIError(c, 500, "INTERNAL_ERROR", "Không lưu được hồ sơ")
		}
		return c.JSON(fiber.Map{"user": user})
	})
	app.Get("/api/v1/friends", guard, func(c *fiber.Ctx) error {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		friends, err := social.ListFriends(ctx, c.Locals("userID").(string))
		if err != nil {
			return writeAPIError(c, 500, "INTERNAL_ERROR", "Không tải được bạn bè")
		}
		return c.JSON(fiber.Map{"friends": friends})
	})
	app.Post("/api/v1/friends", guard, func(c *fiber.Ctx) error {
		var input struct {
			Email string `json:"email"`
		}
		if c.BodyParser(&input) != nil {
			return writeAPIError(c, 422, "VALIDATION_ERROR", "Email không hợp lệ")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		err := social.RequestFriend(ctx, c.Locals("userID").(string), input.Email)
		if errors.Is(err, auth.ErrFriendNotFound) {
			return writeAPIError(c, 404, "USER_NOT_FOUND", "Không tìm thấy tài khoản")
		}
		if errors.Is(err, auth.ErrInvalidInput) {
			return writeAPIError(c, 422, "VALIDATION_ERROR", "Email không hợp lệ")
		}
		if err != nil {
			return writeAPIError(c, 500, "INTERNAL_ERROR", "Không gửi được lời mời")
		}
		return c.Status(201).JSON(fiber.Map{"ok": true})
	})
	app.Post("/api/v1/friends/:peerID/respond", guard, func(c *fiber.Ctx) error {
		var input struct {
			Accept bool `json:"accept"`
		}
		if c.BodyParser(&input) != nil {
			return writeAPIError(c, 422, "VALIDATION_ERROR", "Yêu cầu không hợp lệ")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		err := social.RespondFriend(ctx, c.Locals("userID").(string), c.Params("peerID"), input.Accept)
		if errors.Is(err, auth.ErrFriendRequest) {
			return writeAPIError(c, 404, "FRIEND_REQUEST_NOT_FOUND", "Không còn lời mời này")
		}
		if errors.Is(err, auth.ErrInvalidInput) {
			return writeAPIError(c, 422, "VALIDATION_ERROR", "Yêu cầu không hợp lệ")
		}
		if err != nil {
			return writeAPIError(c, 500, "INTERNAL_ERROR", "Không xử lý được lời mời")
		}
		return c.JSON(fiber.Map{"ok": true})
	})
	app.Delete("/api/v1/friends/:peerID", guard, func(c *fiber.Ctx) error {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		err := social.RemoveFriend(ctx, c.Locals("userID").(string), c.Params("peerID"))
		if errors.Is(err, auth.ErrFriendNotFound) {
			return writeAPIError(c, 404, "FRIEND_NOT_FOUND", "Không tìm thấy bạn bè")
		}
		if errors.Is(err, auth.ErrInvalidInput) {
			return writeAPIError(c, 422, "VALIDATION_ERROR", "Yêu cầu không hợp lệ")
		}
		if err != nil {
			return writeAPIError(c, 500, "INTERNAL_ERROR", "Không thể hủy kết bạn")
		}
		return c.SendStatus(204)
	})
	app.Get("/api/v1/rooms/friends", guard, func(c *fiber.Ctx) error {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		rooms, err := social.ListSuggestedRooms(ctx, c.Locals("userID").(string))
		if err != nil {
			return writeAPIError(c, 500, "INTERNAL_ERROR", "Không tải được phòng bạn bè")
		}
		return c.JSON(fiber.Map{"rooms": rooms})
	})
	app.Put("/api/v1/rooms/:roomID/password", requireUser(cfg, service != nil), func(c *fiber.Ctx) error {
		locker, ok := service.(interface {
			SetRoomPassword(context.Context, string, string, string) (bool, error)
		})
		if !ok {
			return writeAPIError(c, 503, "SERVICE_UNAVAILABLE", "Chưa thể đổi khóa phòng")
		}
		var input struct {
			Password string `json:"password"`
		}
		if c.BodyParser(&input) != nil {
			return writeAPIError(c, 422, "VALIDATION_ERROR", "Mật khẩu không hợp lệ")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		locked, err := locker.SetRoomPassword(ctx, c.Locals("userID").(string), c.Params("roomID"), input.Password)
		if errors.Is(err, auth.ErrNotRoomOwner) {
			return writeAPIError(c, 403, "NOT_ROOM_OWNER", "Chỉ chủ phòng được đổi khóa")
		}
		if errors.Is(err, auth.ErrRoomNotFound) {
			return writeAPIError(c, 404, "ROOM_NOT_FOUND", "Không tìm thấy phòng")
		}
		if errors.Is(err, auth.ErrInvalidRoom) {
			return writeAPIError(c, 422, "VALIDATION_ERROR", "Mật khẩu cần 6–72 ký tự")
		}
		if err != nil {
			return writeAPIError(c, 500, "INTERNAL_ERROR", "Không đổi được khóa phòng")
		}
		return c.JSON(fiber.Map{"isLocked": locked})
	})
	app.Get("/api/v1/friends/:peerID/messages", guard, func(c *fiber.Ctx) error {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		messages, err := social.ListFriendMessages(ctx, c.Locals("userID").(string), c.Params("peerID"))
		if errors.Is(err, auth.ErrFriendNotFound) {
			return writeAPIError(c, 403, "FRIEND_REQUIRED", "Cần kết bạn để xem tin nhắn")
		}
		if errors.Is(err, auth.ErrInvalidInput) {
			return writeAPIError(c, 422, "VALIDATION_ERROR", "Yêu cầu không hợp lệ")
		}
		if err != nil {
			return writeAPIError(c, 500, "INTERNAL_ERROR", "Không tải được tin nhắn")
		}
		return c.JSON(fiber.Map{"messages": messages})
	})
	app.Post("/api/v1/friends/:peerID/messages", guard, func(c *fiber.Ctx) error {
		var input auth.ChatMessageInput
		if c.BodyParser(&input) != nil {
			return writeAPIError(c, 422, "VALIDATION_ERROR", "Tin nhắn không hợp lệ")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		message, err := social.SendFriendMessage(ctx, c.Locals("userID").(string), c.Params("peerID"), input)
		if errors.Is(err, auth.ErrFriendNotFound) {
			return writeAPIError(c, 403, "FRIEND_REQUIRED", "Cần kết bạn để nhắn tin")
		}
		if errors.Is(err, auth.ErrInvalidMessage) || errors.Is(err, auth.ErrInvalidInput) {
			return writeAPIError(c, 422, "VALIDATION_ERROR", "Tin nhắn không hợp lệ")
		}
		if err != nil {
			return writeAPIError(c, 500, "INTERNAL_ERROR", "Không gửi được tin nhắn")
		}
		return c.Status(201).JSON(fiber.Map{"message": message})
	})
}
