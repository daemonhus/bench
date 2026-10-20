package db

import (
	"database/sql"
	"fmt"
	"math"

	"bench/internal/model"
)

// Anchors are checked here, at the one layer every create and update goes
// through (REST, MCP and the CLI alike): line ranges with model.ParseLineRange's
// rule, and commits pinned to a commit id.

// checkAnchors validates and normalises each anchor before it is stored: the
// line range by model.ParseLineRange (naming the item when there is more than
// one), and the commit pinned to a commit id.
func (d *DB) checkAnchors(anchors ...*model.Anchor) error {
	for i, a := range anchors {
		if err := a.NormalizeLineRange(); err != nil {
			if len(anchors) > 1 {
				return fmt.Errorf("item %d: %w", i+1, err)
			}
			return err
		}
		a.CommitID = d.pinCommit(a.CommitID)
	}
	return nil
}

// pinCommitUpdate pins a commit given in an update map, under any of its keys.
func (d *DB) pinCommitUpdate(updates map[string]any) {
	for _, k := range []string{"commit", "commit_id"} {
		if ref, ok := updates[k].(string); ok {
			updates[k] = d.pinCommit(ref)
		}
	}
}

// mergeLineRangeUpdate resolves line_start / line_end in an update map against
// the stored range, so the range that ends up stored is always valid. A new
// start alone keeps the stored end unless the start moves past it, when the
// range becomes that one line; a new end alone keeps the stored start.
func (d *DB) mergeLineRangeUpdate(table, id string, updates map[string]any) error {
	rawStart, hasStart := updates["line_start"]
	rawEnd, hasEnd := updates["line_end"]
	if !hasStart && !hasEnd {
		return nil
	}
	var curStart, curEnd sql.NullInt64
	err := d.conn.QueryRow(
		fmt.Sprintf("SELECT anchor_line_start, anchor_line_end FROM %s WHERE project_id = ? AND id = ?", table),
		d.projectID, id,
	).Scan(&curStart, &curEnd)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	start, end := int(curStart.Int64), int(curEnd.Int64)
	if hasStart {
		n, ok := lineNumber(rawStart)
		if !ok {
			return fmt.Errorf("%w: line_start must be a whole number, got %v", model.ErrInvalidLineRange, rawStart)
		}
		start = n
		if !hasEnd && end < start {
			end = 0 // moved past the stored end: just the new start line
		}
	}
	if hasEnd {
		n, ok := lineNumber(rawEnd)
		if !ok {
			return fmt.Errorf("%w: line_end must be a whole number, got %v", model.ErrInvalidLineRange, rawEnd)
		}
		end = n
	}
	lr, err := model.ParseLineRange(start, end)
	if err != nil {
		return err
	}
	if lr == nil {
		updates["line_start"], updates["line_end"] = nil, nil
	} else {
		updates["line_start"], updates["line_end"] = lr.Start, lr.End
	}
	return nil
}

// lineNumber reads a line number from an update map value: an int from Go
// callers, a float64 from decoded JSON.
func lineNumber(v any) (int, bool) {
	switch n := v.(type) {
	case int:
		return n, true
	case int64:
		return int(n), true
	case float64:
		if n != math.Trunc(n) {
			return 0, false
		}
		return int(n), true
	}
	return 0, false
}
