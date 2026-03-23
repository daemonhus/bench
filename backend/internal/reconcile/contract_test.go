package reconcile

import (
	"encoding/json"
	"testing"
)

// These tests verify the JSON wire format of reconciliation types.
// If you change a json tag in job.go, these tests break — update
// the corresponding TypeScript types in src/core/types.ts to match.

func TestJobSnapshotJSON_FieldNames(t *testing.T) {
	s := JobSnapshot{
		JobID:        "rec-1",
		Status:       "done",
		TargetCommit: "abc123",
		Progress: JobProgress{
			CurrentFile:  "src/auth.py",
			FilesTotal:   5,
			FilesDone:    3,
			CommitsTotal: 10,
			CommitsDone:  7,
		},
		Result: &ReconcileResult{
			FilesReconciled: 5,
			CommitsWalked:   10,
			Annotations: ReconcileSummary{
				Total:    20,
				Exact:    15,
				Moved:    3,
				Orphaned: 2,
			},
			DurationMs: 1234,
		},
		Error: "some error",
	}

	data, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}

	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}

	// Top-level fields — must match TypeScript JobSnapshot interface
	assertJSONField(t, m, "jobId", "rec-1")
	assertJSONField(t, m, "status", "done")
	assertJSONField(t, m, "targetCommit", "abc123")
	assertJSONField(t, m, "error", "some error")

	// Progress — must match TypeScript JobProgress interface
	prog, ok := m["progress"].(map[string]any)
	if !ok {
		t.Fatal("expected 'progress' to be an object")
	}
	assertJSONField(t, prog, "filesTotal", float64(5))
	assertJSONField(t, prog, "filesDone", float64(3))
	assertJSONField(t, prog, "commitsTotal", float64(10))
	assertJSONField(t, prog, "commitsDone", float64(7))
	assertJSONField(t, prog, "currentFile", "src/auth.py")

	// Result — must match TypeScript ReconcileResult interface
	res, ok := m["result"].(map[string]any)
	if !ok {
		t.Fatal("expected 'result' to be an object")
	}
	assertJSONField(t, res, "filesReconciled", float64(5))
	assertJSONField(t, res, "commitsWalked", float64(10))
	assertJSONField(t, res, "durationMs", float64(1234))

	// Annotations — must match TypeScript ReconcileSummary interface
	ann, ok := res["annotations"].(map[string]any)
	if !ok {
		t.Fatal("expected 'result.annotations' to be an object")
	}
	assertJSONField(t, ann, "total", float64(20))
	assertJSONField(t, ann, "exact", float64(15))
	assertJSONField(t, ann, "moved", float64(3))
	assertJSONField(t, ann, "orphaned", float64(2))
}

func TestJobSnapshotJSON_StatusValues(t *testing.T) {
	// These must match the TypeScript union: 'pending' | 'running' | 'done' | 'failed'
	for _, status := range []string{"pending", "running", "done", "failed"} {
		s := JobSnapshot{Status: status}
		data, _ := json.Marshal(s)
		var m map[string]any
		json.Unmarshal(data, &m)
		if m["status"] != status {
			t.Errorf("status %q did not round-trip, got %v", status, m["status"])
		}
	}
}

func TestJobSnapshotJSON_OmitEmptyBehavior(t *testing.T) {
	// Pending job: no result, no error
	s := JobSnapshot{
		JobID:  "rec-1",
		Status: "pending",
	}

	data, _ := json.Marshal(s)
	var m map[string]any
	json.Unmarshal(data, &m)

	// "result" should be absent (omitempty on nil pointer)
	if _, ok := m["result"]; ok {
		t.Error("pending job should not have 'result' in JSON")
	}

	// "error" should be absent (omitempty on empty string)
	if v, ok := m["error"]; ok && v != "" {
		t.Errorf("pending job should not have non-empty 'error', got %v", v)
	}

	// "progress" is present even when zero — Go's omitempty doesn't omit zero structs.
	// The TS side must handle receiving a zero-value progress object.
	if _, ok := m["progress"]; !ok {
		t.Error("expected 'progress' to be present (Go omitempty doesn't omit zero structs)")
	}
}

func assertJSONField(t *testing.T, m map[string]any, key string, expected any) {
	t.Helper()
	v, ok := m[key]
	if !ok {
		t.Errorf("missing expected JSON field %q (available: %v)", key, jsonKeys(m))
		return
	}
	if v != expected {
		t.Errorf("field %q: expected %v (%T), got %v (%T)", key, expected, expected, v, v)
	}
}

func jsonKeys(m map[string]any) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	return ks
}
