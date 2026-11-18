package observability

import (
	"strings"
	"sync"
	"testing"
)

func TestRenderUsesBoundedLabelsAndHistogram(t *testing.T) {
	metrics := NewHTTPMetrics()
	metrics.Observe("GET", "/api/v1/rooms/:roomID/messages", 200, 0.02)
	metrics.Observe("GET", "/api/v1/rooms/:roomID/messages", 500, 0.4)
	metrics.ObserveReadinessFailure()
	metrics.SetDatabasePool(DatabasePoolStats{MaxConns: 10, TotalConns: 3, AcquiredConns: 2, IdleConns: 1, EmptyAcquireCount: 4})
	metrics.SetStorage(StorageStats{Operations: 8, Errors: 1})

	output := metrics.Render()
	for _, expected := range []string{
		"chatify_http_requests_total",
		"status_class=\"2xx\"",
		"status_class=\"5xx\"",
		"chatify_http_request_duration_seconds_bucket",
		"chatify_readiness_failures_total 1",
		"chatify_db_pool_acquired_conns 2",
		"chatify_object_storage_errors_total 1",
	} {
		if !strings.Contains(output, expected) {
			t.Fatalf("metrics output missing %q:\n%s", expected, output)
		}
	}
}

func TestConcurrentObserveAndRender(t *testing.T) {
	metrics := NewHTTPMetrics()
	var group sync.WaitGroup
	for worker := 0; worker < 8; worker++ {
		group.Add(1)
		go func() {
			defer group.Done()
			for attempt := 0; attempt < 100; attempt++ {
				metrics.Observe("GET", "/health/live", 200, 0.001)
				_ = metrics.Render()
			}
		}()
	}
	group.Wait()
}
