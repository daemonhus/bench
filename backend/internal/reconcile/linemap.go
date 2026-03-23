package reconcile

import (
	"regexp"
	"strconv"
	"strings"
)

// LineType represents the type of a line within a diff hunk.
type LineType byte

const (
	Context LineType = ' '
	Delete  LineType = '-'
	Insert  LineType = '+'
)

// DiffLine represents a single line within a diff hunk.
// For Context lines, both OldNo and NewNo are set.
// For Delete lines, only OldNo is set (NewNo is 0).
// For Insert lines, only NewNo is set (OldNo is 0).
type DiffLine struct {
	Type  LineType
	OldNo int
	NewNo int
}

// DiffHunk represents a single hunk from a unified diff.
type DiffHunk struct {
	OldStart int
	OldCount int
	NewStart int
	NewCount int
	Lines    []DiffLine
}

var hunkHeaderRe = regexp.MustCompile(`^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@`)

// ParseDiffHunks parses a unified diff string into structured hunks.
// Handles file-level headers (diff, index, ---, +++), hunk headers (@@),
// and diff content lines (+, -, space). Skips "\ No newline" markers.
func ParseDiffHunks(rawDiff string) []DiffHunk {
	if rawDiff == "" {
		return nil
	}

	lines := strings.Split(rawDiff, "\n")
	var hunks []DiffHunk
	var cur *DiffHunk
	oldLine, newLine := 0, 0

	for _, line := range lines {
		line = strings.TrimRight(line, "\r")

		// Skip file-level headers
		if strings.HasPrefix(line, "diff ") ||
			strings.HasPrefix(line, "index ") ||
			strings.HasPrefix(line, "---") ||
			strings.HasPrefix(line, "+++") {
			continue
		}

		m := hunkHeaderRe.FindStringSubmatch(line)
		if m != nil {
			if cur != nil {
				hunks = append(hunks, *cur)
			}
			oldStart := atoi(m[1])
			oldCount := 1
			if m[2] != "" {
				oldCount = atoi(m[2])
			}
			newStart := atoi(m[3])
			newCount := 1
			if m[4] != "" {
				newCount = atoi(m[4])
			}
			cur = &DiffHunk{
				OldStart: oldStart,
				OldCount: oldCount,
				NewStart: newStart,
				NewCount: newCount,
			}
			oldLine = oldStart
			newLine = newStart
			continue
		}

		if cur == nil {
			continue
		}

		switch {
		case strings.HasPrefix(line, "-"):
			cur.Lines = append(cur.Lines, DiffLine{Type: Delete, OldNo: oldLine})
			oldLine++
		case strings.HasPrefix(line, "+"):
			cur.Lines = append(cur.Lines, DiffLine{Type: Insert, NewNo: newLine})
			newLine++
		case strings.HasPrefix(line, " "):
			cur.Lines = append(cur.Lines, DiffLine{Type: Context, OldNo: oldLine, NewNo: newLine})
			oldLine++
			newLine++
			// Skip "\ No newline at end of file", empty trailing lines, etc.
		}
	}

	if cur != nil {
		hunks = append(hunks, *cur)
	}
	return hunks
}

// MapLineRange maps a line range from the old file version to the new file
// version using the provided diff hunks. Lines are 1-based.
//
// Returns the new range and true if all lines in the range survived the diff
// (are context lines or fall outside all hunks). Returns (0, 0, false) if any
// line in the range was deleted or modified.
func MapLineRange(oldStart, oldEnd int, hunks []DiffHunk) (newStart, newEnd int, ok bool) {
	if len(hunks) == 0 {
		return oldStart, oldEnd, true
	}
	if oldStart > oldEnd || oldStart < 1 {
		return 0, 0, false
	}

	// Map every line in the range to verify all survive
	for line := oldStart; line <= oldEnd; line++ {
		mapped, lineOk := mapLine(line, hunks)
		if !lineOk {
			return 0, 0, false
		}
		if line == oldStart {
			newStart = mapped
		}
		if line == oldEnd {
			newEnd = mapped
		}
	}
	return newStart, newEnd, true
}

// mapLine maps a single old line number through the diff hunks.
// Returns the new line number and true if the line survived,
// or (0, false) if the line was deleted.
func mapLine(oldLineNo int, hunks []DiffHunk) (int, bool) {
	offset := 0
	for _, h := range hunks {
		hunkOldEnd := h.OldStart + h.OldCount

		if oldLineNo < h.OldStart {
			// Before this hunk: unchanged, apply accumulated offset
			return oldLineNo + offset, true
		}

		if oldLineNo < hunkOldEnd {
			// Within this hunk: check individual lines
			for _, dl := range h.Lines {
				if dl.OldNo == oldLineNo {
					switch dl.Type {
					case Context:
						return dl.NewNo, true
					case Delete:
						return 0, false
					}
				}
			}
			// Old line in hunk range but not found in parsed lines.
			// This shouldn't happen with well-formed diffs; treat as deleted.
			return 0, false
		}

		// Past this hunk: accumulate offset
		offset += h.NewCount - h.OldCount
	}

	// Past all hunks: apply total offset
	return oldLineNo + offset, true
}

func atoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}
