package observability

import (
	"fmt"
	"sort"
	"strings"
	"sync"
)

var latencyBuckets = [...]float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10}

type metricKey struct {
	method      string
	route       string
	statusClass string
}

type histogram struct {
	buckets [len(latencyBuckets) + 1]uint64
	count   uint64
	sum     float64
}

// HTTPMetrics stores bounded RED metrics. Labels are method, route template,
// and status class; raw URLs and user data never become metric cardinality.
type HTTPMetrics struct {
	mu           sync.Mutex
	requests     map[metricKey]uint64
	durations    map[metricKey]histogram
	readyFailure uint64
	databasePool DatabasePoolStats
	storage      StorageStats
}

type DatabasePoolStats struct {
	MaxConns          int32
	TotalConns        int32
	AcquiredConns     int32
	IdleConns         int32
	EmptyAcquireCount int64
}

type StorageStats struct {
	Operations uint64
	Errors     uint64
}

func NewHTTPMetrics() *HTTPMetrics {
	return &HTTPMetrics{requests: make(map[metricKey]uint64), durations: make(map[metricKey]histogram)}
}

func (m *HTTPMetrics) Observe(method, route string, status int, seconds float64) {
	if route == "" || len(route) > 128 {
		route = "unmatched"
	}
	key := metricKey{method: method, route: route, statusClass: fmt.Sprintf("%dxx", status/100)}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.requests[key]++
	hist := m.durations[key]
	hist.count++
	hist.sum += seconds
	for index, bucket := range latencyBuckets {
		if seconds <= bucket {
			hist.buckets[index]++
			m.durations[key] = hist
			return
		}
	}
	hist.buckets[len(latencyBuckets)]++
	m.durations[key] = hist
}

func (m *HTTPMetrics) ObserveReadinessFailure() {
	m.mu.Lock()
	m.readyFailure++
	m.mu.Unlock()
}

func (m *HTTPMetrics) SetDatabasePool(stats DatabasePoolStats) {
	m.mu.Lock()
	m.databasePool = stats
	m.mu.Unlock()
}

func (m *HTTPMetrics) SetStorage(stats StorageStats) {
	m.mu.Lock()
	m.storage = stats
	m.mu.Unlock()
}

func (m *HTTPMetrics) Render() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	keys := make([]metricKey, 0, len(m.requests))
	for key := range m.requests {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].method != keys[j].method {
			return keys[i].method < keys[j].method
		}
		if keys[i].route != keys[j].route {
			return keys[i].route < keys[j].route
		}
		return keys[i].statusClass < keys[j].statusClass
	})

	var out strings.Builder
	out.WriteString("# HELP chatify_http_requests_total HTTP requests handled by the API.\n")
	out.WriteString("# TYPE chatify_http_requests_total counter\n")
	out.WriteString("# HELP chatify_http_request_duration_seconds HTTP request duration histogram.\n")
	out.WriteString("# TYPE chatify_http_request_duration_seconds histogram\n")
	for _, key := range keys {
		labels := fmt.Sprintf(`method="%s",route="%s",status_class="%s"`, escape(key.method), escape(key.route), escape(key.statusClass))
		out.WriteString(fmt.Sprintf("chatify_http_requests_total{%s} %d\n", labels, m.requests[key]))
		hist := m.durations[key]
		cumulative := uint64(0)
		for index, bucket := range latencyBuckets {
			cumulative += hist.buckets[index]
			out.WriteString(fmt.Sprintf("chatify_http_request_duration_seconds_bucket{%s,le=\"%g\"} %d\n", labels, bucket, cumulative))
		}
		cumulative += hist.buckets[len(latencyBuckets)]
		out.WriteString(fmt.Sprintf("chatify_http_request_duration_seconds_bucket{%s,le=\"+Inf\"} %d\n", labels, cumulative))
		out.WriteString(fmt.Sprintf("chatify_http_request_duration_seconds_sum{%s} %g\n", labels, hist.sum))
		out.WriteString(fmt.Sprintf("chatify_http_request_duration_seconds_count{%s} %d\n", labels, hist.count))
	}
	out.WriteString("# HELP chatify_readiness_failures_total Readiness checks that failed.\n")
	out.WriteString("# TYPE chatify_readiness_failures_total counter\n")
	out.WriteString(fmt.Sprintf("chatify_readiness_failures_total %d\n", m.readyFailure))
	out.WriteString("# HELP chatify_db_pool_max_conns Configured PostgreSQL pool maximum connections.\n# TYPE chatify_db_pool_max_conns gauge\n")
	out.WriteString(fmt.Sprintf("chatify_db_pool_max_conns %d\n", m.databasePool.MaxConns))
	out.WriteString("# HELP chatify_db_pool_total_conns Current PostgreSQL pool connections.\n# TYPE chatify_db_pool_total_conns gauge\n")
	out.WriteString(fmt.Sprintf("chatify_db_pool_total_conns %d\n", m.databasePool.TotalConns))
	out.WriteString("# HELP chatify_db_pool_acquired_conns Current PostgreSQL pool acquired connections.\n# TYPE chatify_db_pool_acquired_conns gauge\n")
	out.WriteString(fmt.Sprintf("chatify_db_pool_acquired_conns %d\n", m.databasePool.AcquiredConns))
	out.WriteString("# HELP chatify_db_pool_idle_conns Current PostgreSQL pool idle connections.\n# TYPE chatify_db_pool_idle_conns gauge\n")
	out.WriteString(fmt.Sprintf("chatify_db_pool_idle_conns %d\n", m.databasePool.IdleConns))
	out.WriteString("# HELP chatify_db_pool_empty_acquire_total PostgreSQL pool acquisitions that waited for a connection.\n# TYPE chatify_db_pool_empty_acquire_total counter\n")
	out.WriteString(fmt.Sprintf("chatify_db_pool_empty_acquire_total %d\n", m.databasePool.EmptyAcquireCount))
	out.WriteString("# HELP chatify_object_storage_operations_total Object-storage operations attempted by the API.\n# TYPE chatify_object_storage_operations_total counter\n")
	out.WriteString(fmt.Sprintf("chatify_object_storage_operations_total %d\n", m.storage.Operations))
	out.WriteString("# HELP chatify_object_storage_errors_total Object-storage operation errors observed by the API.\n# TYPE chatify_object_storage_errors_total counter\n")
	out.WriteString(fmt.Sprintf("chatify_object_storage_errors_total %d\n", m.storage.Errors))
	return out.String()
}

func escape(value string) string {
	return strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`).Replace(value)
}
