// Package anchor keeps an annotation's tracking in step with its anchor, for every
// surface that writes annotations (the REST handlers and the MCP tools), so they
// follow the code the same way.
package anchor

import (
	"fmt"
	"strings"
	"time"

	"bench/internal/db"
	"bench/internal/git"
	"bench/internal/model"
	"bench/internal/reconcile"
)

// LineHash hashes the anchored lines at the anchor's commit: what the reconciler
// matches on to follow the code. Empty when the lines can't be read.
func LineHash(repo *git.Repo, a model.Anchor) string {
	if repo == nil || a.LineRange == nil || a.CommitID == "" {
		return ""
	}
	content, err := repo.Show(a.CommitID, a.FileID)
	if err != nil {
		return ""
	}
	lines := strings.Split(content, "\n")
	start, end := a.LineRange.Start-1, a.LineRange.End
	if start < 0 || start >= end || end > len(lines) {
		return ""
	}
	return reconcile.LineHash(lines[start:end])
}

// RecordMove brings an annotation's tracking up to date after an update moved its
// anchor, as create sets it up: the hash of the lines it now points at, when it
// moved, and an exact position at its anchor commit. The position is at the
// anchor commit because that is the commit its lines describe; the reconciler
// takes the most recently recorded position, so it supersedes the old ones.
func RecordMove(repo *git.Repo, database *db.DB, kind, id string, a model.Anchor) error {
	if a.LineRange == nil || a.CommitID == "" {
		return nil
	}
	tracking := map[string]any{
		"line_hash":         LineHash(repo, a),
		"anchor_updated_at": time.Now().UTC().Format(time.RFC3339),
	}
	var err error
	switch kind {
	case "finding":
		_, err = database.UpdateFinding(id, tracking)
	case "feature":
		_, err = database.UpdateFeature(id, tracking)
	case "comment":
		err = database.UpdateComment(id, tracking)
	default:
		return fmt.Errorf("anchor.RecordMove: unknown kind %q", kind)
	}
	if err != nil {
		return err
	}
	fileID := a.FileID
	return database.InsertPosition(&model.AnnotationPosition{
		AnnotationID:   id,
		AnnotationType: kind,
		CommitID:       a.CommitID,
		FileID:         &fileID,
		LineStart:      &a.LineRange.Start,
		LineEnd:        &a.LineRange.End,
		Confidence:     "exact",
	})
}
