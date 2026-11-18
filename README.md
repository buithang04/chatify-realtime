# Chatify Realtime

Ứng dụng gọi video, chia sẻ màn hình và trò chuyện theo thời gian thực. Dự án hiện được thiết kế để chạy trên máy cá nhân bằng Docker Compose; cấu hình triển khai công khai cần được chuẩn bị và kiểm thử riêng.

## Tính năng

- Tạo phòng gọi nhóm, gọi 1-1 hoặc livestream; tham gia bằng mã phòng.
- Đặt, đổi và gỡ mật khẩu phòng. Phòng có khóa yêu cầu người mới nhập đúng mật khẩu.
- Camera, micrô, chia sẻ màn hình, chọn thiết bị âm thanh và tắt/bật âm thanh nhận về.
- Chat trong phòng, nhắn tin riêng, thông báo tin chưa đọc và danh sách người đang kết nối.
- Kết bạn, gợi ý phòng của bạn bè, chỉnh tên hiển thị và ảnh đại diện.
- Chuyển quyền chủ phòng khi chủ phòng rời; khôi phục phiên phòng sau khi tải lại trang.

## Kiến trúc

| Thành phần | Công nghệ | Vai trò |
| --- | --- | --- |
| Web | React, TypeScript, Vite | Giao diện người dùng |
| API | Go, Fiber | Xác thực, phòng, bạn bè, tin nhắn và tệp đính kèm |
| Cơ sở dữ liệu | PostgreSQL | Dữ liệu lâu dài |
| Cache và trạng thái tạm | Redis | Presence và giới hạn tốc độ |
| Signaling | Node.js, Socket.IO | Đồng bộ trạng thái và điều phối kết nối |
| Media | WebRTC, mediasoup, coturn | Âm thanh, video, chia sẻ màn hình và STUN/TURN |
| Sự kiện | Redpanda | Hàng đợi sự kiện và outbox |
| Lưu trữ đối tượng | RustFS | Tệp đính kèm tương thích S3 |
| Quan sát | Prometheus | Chỉ số và cảnh báo local |

Luồng âm thanh/video đi qua WebRTC và media worker; API và cơ sở dữ liệu không chuyển tiếp media.

## Chạy trên máy cá nhân

Yêu cầu: Docker Desktop với Linux containers và WSL2. Để chạy bài kiểm thử trình duyệt, cần thêm Node.js, Chrome và Edge.

Tại thư mục gốc của dự án, chạy trong **PowerShell**:

```powershell
Copy-Item .env.example .env.local
docker compose --project-name chatify-realtime-local --env-file .env.local -f infra/docker/compose.yaml up -d --build
docker compose --project-name chatify-realtime-local --env-file .env.local -f infra/docker/compose.yaml ps
```

Trước khi dùng dữ liệu thật, hãy sửa các mật khẩu và khóa mẫu trong `.env.local`. Tệp này được Git bỏ qua. Khi các dịch vụ báo `healthy`, mở `http://localhost:3000/` trên **chính máy chạy Docker**. Địa chỉ `localhost` không truy cập được từ thiết bị ở xa.

Các địa chỉ local thường dùng:

| Dịch vụ | Địa chỉ |
| --- | --- |
| Web | `http://localhost:3000` |
| API | `http://localhost:8080` |
| Signaling | `http://localhost:3001` |
| Media worker | `http://localhost:3002` |
| PostgreSQL | `localhost:5433` |
| Redis | `localhost:6380` |
| Redpanda Console | `http://localhost:8081` |
| RustFS API / Console | `http://localhost:9000` / `http://localhost:9001` |
| Prometheus | `http://localhost:9090` |

Dừng hệ thống mà vẫn giữ dữ liệu:

```powershell
docker compose --project-name chatify-realtime-local --env-file .env.local -f infra/docker/compose.yaml stop
```

Không dùng `down -v` nếu cần giữ các volume PostgreSQL, Redis, Redpanda và RustFS.

## Kiểm thử

Cài thư viện kiểm thử từ thư mục gốc:

```powershell
npm --prefix harness ci
npm --prefix harness run browser-e2e
npm --prefix harness run cross-browser-e2e
npm --prefix harness run social-e2e
```

Bài kiểm thử dùng Chrome/Edge đã cài trên máy và tạo tài khoản, phòng thử nghiệm trong cơ sở dữ liệu local. Chỉ chạy khi stack Docker đã hoạt động.

Để chạy cổng kiểm tra local đầy đủ ở bất kỳ đường dẫn clone nào:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-local.ps1 -EnvFile (Resolve-Path .\.env.local).Path -ComposeFile (Resolve-Path .\infra\docker\compose.yaml).Path
```

Script này còn kiểm tra API, signaling, media, TURN và monitoring. Xem thêm [hướng dẫn vận hành](docs/OPERATIONS.md), [danh sách trước khi ra mắt](docs/LAUNCH_CHECKLIST.md) và [phương án rollback](docs/ROLLBACK.md).

## Triển khai và bảo mật

`.env.example` chỉ chứa giá trị mẫu cho môi trường local. Không commit `.env.local`, dữ liệu, bản sao lưu, token hay khóa riêng. Trước khi triển khai ra Internet, dùng secret manager, HTTPS, tên miền thật, CORS/CSP phù hợp, TURN credential an toàn và kiểm tra các mục trong `docs/LAUNCH_CHECKLIST.md`. Có thể chạy kiểm tra cấu hình mà không thay đổi hệ thống:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-production-config.ps1 -EnvFile .\.env.production
```

Repository công khai mã nguồn, **không** tự động công khai ứng dụng đang chạy trên máy cá nhân.
