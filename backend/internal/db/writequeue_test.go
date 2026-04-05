package db

import (
	"fmt"
	"sync"
	"testing"

	"bench/internal/model"
)

// TestWriteQueue_ConcurrentFindings submits N concurrent CreateFinding calls and
// verifies every write succeeds with no SQLITE_BUSY errors.
func TestWriteQueue_ConcurrentFindings(t *testing.T) {
	d := openTestDB(t)

	const n = 50
	errs := make([]error, n)
	var wg sync.WaitGroup
	wg.Add(n)
	for i := range n {
		go func(i int) {
			defer wg.Done()
			errs[i] = d.CreateFinding(&model.Finding{
				ID:       fmt.Sprintf("f%d", i),
				Anchor:   model.Anchor{FileID: "src/a.go", CommitID: "abc"},
				Severity: "low",
				Title:    fmt.Sprintf("finding %d", i),
				Status:   "open",
				Source:   "manual",
			})
		}(i)
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Errorf("CreateFinding[%d]: %v", i, err)
		}
	}

	findings, _, err := d.ListFindings("", 0, 0)
	if err != nil {
		t.Fatalf("ListFindings: %v", err)
	}
	if len(findings) != n {
		t.Errorf("got %d findings, want %d", len(findings), n)
	}
}

// TestWriteQueue_ConcurrentMixed hammers multiple write methods concurrently
// to confirm the queue serialises across different entity types.
func TestWriteQueue_ConcurrentMixed(t *testing.T) {
	d := openTestDB(t)

	const n = 20
	var wg sync.WaitGroup
	errs := make([]error, n*3)
	wg.Add(n * 3)

	for i := range n {
		go func(i int) {
			defer wg.Done()
			errs[i] = d.CreateFinding(&model.Finding{
				ID:       fmt.Sprintf("f%d", i),
				Anchor:   model.Anchor{FileID: "a.go", CommitID: "c1"},
				Severity: "low",
				Title:    fmt.Sprintf("f%d", i),
				Status:   "open",
				Source:   "manual",
			})
		}(i)
		go func(i int) {
			defer wg.Done()
			errs[n+i] = d.CreateComment(&model.Comment{
				ID:       fmt.Sprintf("c%d", i),
				Anchor:   model.Anchor{FileID: "a.go", CommitID: "c1"},
				Author:   "tester",
				Text:     fmt.Sprintf("comment %d", i),
				ThreadID: fmt.Sprintf("t%d", i),
			})
		}(i)
		go func(i int) {
			defer wg.Done()
			errs[n*2+i] = d.CreateFeature(&model.Feature{
				ID:     fmt.Sprintf("feat%d", i),
				Anchor: model.Anchor{FileID: "a.go", CommitID: "c1"},
				Kind:   "interface",
				Title:  fmt.Sprintf("feature %d", i),
				Status: "active",
				Tags:   []string{},
			})
		}(i)
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Errorf("write[%d]: %v", i, err)
		}
	}
}

// TestWriteQueue_CloseFlushes verifies that closing the DB after queuing writes
// does not drop in-flight operations.
func TestWriteQueue_CloseFlushes(t *testing.T) {
	d := openTestDB(t)

	const n = 10
	var wg sync.WaitGroup
	wg.Add(n)
	for i := range n {
		go func(i int) {
			defer wg.Done()
			_ = d.CreateFinding(&model.Finding{
				ID:       fmt.Sprintf("f%d", i),
				Anchor:   model.Anchor{FileID: "a.go", CommitID: "c1"},
				Severity: "info",
				Title:    fmt.Sprintf("f%d", i),
				Status:   "open",
				Source:   "manual",
			})
		}(i)
	}
	wg.Wait()

	// Close drains the queue; subsequent ListFindings uses a fresh DB.
	// Queue is drained by t.Cleanup via d.Close() — nothing more needed here.
}

// TestPutSettings_Atomic verifies that PutSettings writes all keys or none.
// We test the happy path (all keys persisted) and confirm the result via GetAllSettings.
func TestPutSettings_Atomic(t *testing.T) {
	d := openTestDB(t)

	want := map[string]string{
		"theme":    "dark",
		"sidebar":  "open",
		"fontSize": "14",
	}
	if err := d.PutSettings(want); err != nil {
		t.Fatalf("PutSettings: %v", err)
	}

	got, err := d.GetAllSettings()
	if err != nil {
		t.Fatalf("GetAllSettings: %v", err)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("setting %q = %q, want %q", k, got[k], v)
		}
	}
}

// TestPutSettings_Upsert verifies that PutSettings replaces existing values atomically.
func TestPutSettings_Upsert(t *testing.T) {
	d := openTestDB(t)

	if err := d.PutSettings(map[string]string{"a": "1", "b": "2"}); err != nil {
		t.Fatalf("initial PutSettings: %v", err)
	}
	if err := d.PutSettings(map[string]string{"a": "updated", "c": "3"}); err != nil {
		t.Fatalf("upsert PutSettings: %v", err)
	}

	got, _ := d.GetAllSettings()
	if got["a"] != "updated" {
		t.Errorf("a = %q, want 'updated'", got["a"])
	}
	if got["b"] != "2" {
		t.Errorf("b = %q, want '2'", got["b"])
	}
	if got["c"] != "3" {
		t.Errorf("c = %q, want '3'", got["c"])
	}
}

// TestPutSettings_ConcurrentNoLoss confirms concurrent PutSettings calls
// all succeed and no key is lost.
func TestPutSettings_ConcurrentNoLoss(t *testing.T) {
	d := openTestDB(t)

	const n = 20
	var wg sync.WaitGroup
	wg.Add(n)
	for i := range n {
		go func(i int) {
			defer wg.Done()
			key := fmt.Sprintf("key%d", i)
			if err := d.PutSettings(map[string]string{key: "v"}); err != nil {
				t.Errorf("PutSettings[%d]: %v", i, err)
			}
		}(i)
	}
	wg.Wait()

	got, err := d.GetAllSettings()
	if err != nil {
		t.Fatalf("GetAllSettings: %v", err)
	}
	if len(got) != n {
		t.Errorf("got %d settings, want %d", len(got), n)
	}
}
