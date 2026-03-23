package db

import (
	"testing"

	"bench/internal/model"
)

func TestCreateAndGetComment(t *testing.T) {
	d := openTestDB(t)

	c := &model.Comment{
		ID:        "c1",
		Anchor:    model.Anchor{FileID: "src/a.go", CommitID: "abc"},
		Author:    "alice",
		Text:      "looks suspicious",
		Timestamp: "2024-01-01T00:00:00Z",
		ThreadID:  "t1",
	}
	if err := d.CreateComment(c); err != nil {
		t.Fatalf("CreateComment: %v", err)
	}

	got, err := d.GetComment("c1")
	if err != nil {
		t.Fatalf("GetComment: %v", err)
	}
	if got.Author != "alice" {
		t.Errorf("author = %q, want alice", got.Author)
	}
	if got.Text != "looks suspicious" {
		t.Errorf("text = %q, want 'looks suspicious'", got.Text)
	}
	if got.ThreadID != "t1" {
		t.Errorf("threadId = %q, want t1", got.ThreadID)
	}
}

func TestCreateComment_WithLineRange(t *testing.T) {
	d := openTestDB(t)

	c := &model.Comment{
		ID:        "c1",
		Anchor:    model.Anchor{FileID: "src/a.go", CommitID: "abc", LineRange: &model.LineRange{Start: 5, End: 8}},
		Author:    "bob",
		Text:      "note",
		Timestamp: "2024-01-01T00:00:00Z",
		ThreadID:  "t1",
	}
	if err := d.CreateComment(c); err != nil {
		t.Fatalf("CreateComment: %v", err)
	}

	got, _ := d.GetComment("c1")
	if got.Anchor.LineRange == nil {
		t.Fatal("expected line range, got nil")
	}
	if got.Anchor.LineRange.Start != 5 || got.Anchor.LineRange.End != 8 {
		t.Errorf("line range = %d-%d, want 5-8", got.Anchor.LineRange.Start, got.Anchor.LineRange.End)
	}
}

func TestUpdateComment(t *testing.T) {
	d := openTestDB(t)

	c := &model.Comment{
		ID: "c1", Anchor: model.Anchor{FileID: "a", CommitID: "abc"},
		Author: "alice", Text: "original", Timestamp: "2024-01-01T00:00:00Z", ThreadID: "t1",
	}
	d.CreateComment(c)

	if err := d.UpdateComment("c1", map[string]any{"text": "updated"}); err != nil {
		t.Fatalf("UpdateComment: %v", err)
	}

	got, _ := d.GetComment("c1")
	if got.Text != "updated" {
		t.Errorf("text = %q, want 'updated'", got.Text)
	}

	// Updating nonexistent returns error
	if err := d.UpdateComment("nope", map[string]any{"text": "x"}); err == nil {
		t.Error("expected error for nonexistent comment")
	}

	// No valid fields returns error
	if err := d.UpdateComment("c1", map[string]any{"unknown": "x"}); err == nil {
		t.Error("expected error for no valid fields")
	}
}

func TestBatchCreateComments(t *testing.T) {
	d := openTestDB(t)

	comments := []model.Comment{
		{ID: "c1", Anchor: model.Anchor{FileID: "a", CommitID: "abc"}, Author: "alice", Text: "A", Timestamp: "2024-01-01T00:00:00Z", ThreadID: "t1"},
		{ID: "c2", Anchor: model.Anchor{FileID: "b", CommitID: "abc"}, Author: "bob", Text: "B", Timestamp: "2024-01-02T00:00:00Z", ThreadID: "t2"},
	}

	ids, err := d.BatchCreateComments(comments)
	if err != nil {
		t.Fatalf("BatchCreateComments: %v", err)
	}
	if len(ids) != 2 {
		t.Fatalf("expected 2 IDs, got %d", len(ids))
	}

	got, err := d.GetComment("c1")
	if err != nil {
		t.Fatalf("GetComment c1: %v", err)
	}
	if got.Author != "alice" {
		t.Errorf("author = %q, want alice", got.Author)
	}
}
