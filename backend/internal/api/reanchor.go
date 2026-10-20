package api

import (
	"fmt"
	"strings"

	"bench/internal/db"
	"bench/internal/git"
	"bench/internal/model"
	"bench/internal/reconcile"
)

// lineHashAt hashes the anchored lines at the anchor's commit: what the
// reconciler matches on to follow the code. Empty when the lines can't be read.
func lineHashAt(repo *git.Repo, a model.Anchor) string {
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

// recordMove brings an annotation's tracking up to date after an update moved
// its anchor, as create sets it up: the hash of the lines it now points at
// (replacing the old lines' hash) and an exact position at its anchor commit.
// Without the position, the reconciler kept reporting the old lines.
func recordMove(repo *git.Repo, database *db.DB, kind, id string, a model.Anchor) error {
	if a.LineRange == nil || a.CommitID == "" {
		return nil
	}
	hash := map[string]any{"line_hash": lineHashAt(repo, a)}
	var err error
	switch kind {
	case "finding":
		_, err = database.UpdateFinding(id, hash)
	case "feature":
		_, err = database.UpdateFeature(id, hash)
	case "comment":
		err = database.UpdateComment(id, hash)
	default:
		return fmt.Errorf("recordMove: unknown kind %q", kind)
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
