package main

import (
	"context"
	"database/sql"
	"log"
	"os"
	"time"

	"chatify-realtime/api/internal/migration"
	_ "github.com/jackc/pgx/v5/stdlib"
)

func main() {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatal("DATABASE_URL is required")
	}

	db, err := sql.Open("pgx", dsn)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		log.Fatal(err)
	}
	if err := migration.Run(ctx, db); err != nil {
		log.Fatal(err)
	}
	log.Println("migrations applied")
}
