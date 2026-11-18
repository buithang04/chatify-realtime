FROM golang:1.24-alpine AS build

WORKDIR /src
COPY apps/api/go.mod apps/api/go.sum ./apps/api/
WORKDIR /src/apps/api
RUN go mod download

COPY apps/api/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/api . \
    && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/migrate ./cmd/migrate \
    && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/outbox-publisher ./cmd/outbox-publisher \
    && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/attachment-cleanup ./cmd/attachment-cleanup

FROM alpine:3.21

RUN addgroup -S chatify && adduser -S -G chatify chatify
COPY --from=build /out/api /usr/local/bin/chatify-api
COPY --from=build /out/migrate /usr/local/bin/chatify-migrate
COPY --from=build /out/outbox-publisher /usr/local/bin/chatify-outbox-publisher
COPY --from=build /out/attachment-cleanup /usr/local/bin/chatify-attachment-cleanup
USER chatify
EXPOSE 8080 8083
ENTRYPOINT ["/usr/local/bin/chatify-api"]
