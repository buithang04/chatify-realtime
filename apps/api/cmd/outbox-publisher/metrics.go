package main

import (
	"context"
	"fmt"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type publisherMetrics struct {
	db            *pgxpool.Pool
	published     atomic.Uint64
	errors        atomic.Uint64
	lastSuccessAt atomic.Int64
}

func newPublisherMetrics(db *pgxpool.Pool) *publisherMetrics {
	metrics := &publisherMetrics{db: db}
	metrics.lastSuccessAt.Store(time.Now().Unix())
	return metrics
}

func (m *publisherMetrics) recordPublished(count int) {
	if count > 0 {
		m.published.Add(uint64(count))
	}
	m.lastSuccessAt.Store(time.Now().Unix())
}

func (m *publisherMetrics) recordError() { m.errors.Add(1) }

func (m *publisherMetrics) handler(response http.ResponseWriter, request *http.Request) {
	if request.URL.Path == "/health" {
		ctx, cancel := context.WithTimeout(request.Context(), 500*time.Millisecond)
		defer cancel()
		if err := m.db.Ping(ctx); err != nil {
			writeMetricsJSON(response, http.StatusServiceUnavailable, `{"status":"not_ready"}`)
			return
		}
		writeMetricsJSON(response, http.StatusOK, `{"status":"ok"}`)
		return
	}
	if request.URL.Path != "/metrics" {
		writeMetricsJSON(response, http.StatusNotFound, `{"error":"NOT_FOUND"}`)
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 500*time.Millisecond)
	defer cancel()
	var pending int64
	if err := m.db.QueryRow(ctx, "SELECT count(*) FROM outbox_events WHERE published_at IS NULL").Scan(&pending); err != nil {
		writeMetricsJSON(response, http.StatusServiceUnavailable, `{"status":"not_ready"}`)
		return
	}
	response.Header().Set("content-type", "text/plain; version=0.0.4")
	response.WriteHeader(http.StatusOK)
	fmt.Fprintf(response, "# HELP chatify_outbox_up Outbox publisher process health.\n# TYPE chatify_outbox_up gauge\nchatify_outbox_up 1\n")
	fmt.Fprintf(response, "# HELP chatify_outbox_pending_events Unpublished outbox events.\n# TYPE chatify_outbox_pending_events gauge\nchatify_outbox_pending_events %d\n", pending)
	fmt.Fprintf(response, "# HELP chatify_outbox_published_total Outbox events published successfully.\n# TYPE chatify_outbox_published_total counter\nchatify_outbox_published_total %d\n", m.published.Load())
	fmt.Fprintf(response, "# HELP chatify_outbox_publish_errors_total Outbox publish cycle errors.\n# TYPE chatify_outbox_publish_errors_total counter\nchatify_outbox_publish_errors_total %d\n", m.errors.Load())
	fmt.Fprintf(response, "# HELP chatify_outbox_last_success_timestamp_seconds Unix timestamp of the last successful publish cycle.\n# TYPE chatify_outbox_last_success_timestamp_seconds gauge\nchatify_outbox_last_success_timestamp_seconds %d\n", m.lastSuccessAt.Load())
}

func writeMetricsJSON(response http.ResponseWriter, status int, body string) {
	response.Header().Set("content-type", "application/json")
	response.WriteHeader(status)
	_, _ = response.Write([]byte(body))
}
