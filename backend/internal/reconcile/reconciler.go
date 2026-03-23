package reconcile

import (
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"bench/internal/model"

	"github.com/google/uuid"
)

// GitOps abstracts git operations for testability.
type GitOps interface {
	Head() (string, error)
	ResolveRef(ref string) (string, error)
	RevList(from, to string) ([]string, error)
	IsAncestor(ancestor, descendant string) (bool, error)
	MergeBase(a, b string) (string, error)
	DiffRaw(from, to, path string) (string, error)
	Show(commitish, path string) (string, error)
	// DetectRename checks if path was renamed between from and to.
	// Returns the new path if renamed, empty string if not.
	DetectRename(from, to, path string) (string, error)
}

// PositionStore persists annotation position data.
type PositionStore interface {
	InsertPosition(p *model.AnnotationPosition) error
	GetPositions(annotationID, annotationType string) ([]model.AnnotationPosition, error)
	DeletePositions(annotationID, annotationType string, commitIDs []string) error
}

// ReconcileStore persists per-file reconciliation progress.
type ReconcileStore interface {
	GetReconciliationState(fileID string) (lastCommitID string, err error)
	SetReconciliationState(fileID, commitID string) error
	ListAnnotatedFiles() ([]string, error)
}

// AnnotationReader fetches annotations for a file.
type AnnotationReader interface {
	ListFindings(fileID string, limit, offset int) ([]model.Finding, int, error)
	ListComments(fileID, findingID string, limit, offset int, featureID ...string) ([]model.Comment, int, error)
	ListFeatures(fileID string, limit, offset int) ([]model.Feature, int, error)
}

// AnnotationResolver resolves findings and creates comments.
// Used by the reconciler to auto-close orphaned findings.
type AnnotationResolver interface {
	BatchResolveFindings(items []struct{ ID, Commit string }) (int, error)
	CreateComment(c *model.Comment) error
	BatchOrphanFeatures(ids []string, orphanCommit string) error
}

// Reconciler manages async reconciliation jobs and position lookups.
type Reconciler struct {
	git  GitOps
	pos  PositionStore
	rec  ReconcileStore
	ann  AnnotationReader
	res  AnnotationResolver // nil = no auto-resolution
	mu   sync.Mutex
	jobs map[string]*Job
}

func NewReconciler(git GitOps, pos PositionStore, rec ReconcileStore, ann AnnotationReader, opts ...Option) *Reconciler {
	r := &Reconciler{
		git:  git,
		pos:  pos,
		rec:  rec,
		ann:  ann,
		jobs: make(map[string]*Job),
	}
	for _, o := range opts {
		o(r)
	}
	return r
}

// Option configures the Reconciler.
type Option func(*Reconciler)

// WithResolver enables auto-resolution of orphaned findings.
func WithResolver(res AnnotationResolver) Option {
	return func(r *Reconciler) { r.res = res }
}

// StartJob creates a reconciliation job and runs it in a background goroutine.
// Returns the job ID immediately. Resolves targetCommit to its full hash.
func (r *Reconciler) StartJob(targetCommit string, filePaths []string) string {
	// Resolve to full hash so stored state always uses canonical 40-char hashes
	if resolved, err := r.git.ResolveRef(targetCommit); err == nil {
		targetCommit = resolved
	}
	job := newJob(targetCommit, filePaths)
	r.mu.Lock()
	r.jobs[job.ID] = job
	r.mu.Unlock()
	go r.runJob(job)
	return job.ID
}

// GetJob returns a snapshot of a job's current state.
func (r *Reconciler) GetJob(jobID string) *JobSnapshot {
	r.mu.Lock()
	job, ok := r.jobs[jobID]
	r.mu.Unlock()
	if !ok {
		return nil
	}
	s := job.Snapshot()
	return &s
}

// GetFileStatus checks whether a file has been reconciled to a specific commit.
func (r *Reconciler) GetFileStatus(fileID, commitID string) (*model.ReconcileFileStatus, error) {
	lastCommit, err := r.rec.GetReconciliationState(fileID)
	if err != nil {
		return nil, err
	}

	status := &model.ReconcileFileStatus{
		FileID:               fileID,
		RequestedCommit:      commitID,
		LastReconciledCommit: lastCommit,
	}

	if lastCommit == "" {
		// Never reconciled
		return status, nil
	}

	if lastCommit == commitID || strings.HasPrefix(commitID, lastCommit) || strings.HasPrefix(lastCommit, commitID) {
		status.IsReconciled = true
		return status, nil
	}

	// Check if lastCommit is an ancestor of the target
	isAnc, err := r.git.IsAncestor(lastCommit, commitID)
	if err != nil {
		return nil, err
	}

	if isAnc {
		commits, err := r.git.RevList(lastCommit, commitID)
		if err != nil {
			return nil, err
		}
		status.CommitsAhead = len(commits)
	} else {
		status.NeedsRebase = true
	}

	return status, nil
}

// GetReconciledHead computes the project-wide reconciled HEAD.
func (r *Reconciler) GetReconciledHead() (*model.ReconciledHead, error) {
	head, err := r.git.Head()
	if err != nil {
		return nil, err
	}

	files, err := r.rec.ListAnnotatedFiles()
	if err != nil {
		return nil, err
	}

	result := &model.ReconciledHead{
		GitHead: head,
	}

	if len(files) == 0 {
		// No annotations — fully reconciled by definition
		result.IsFullyReconciled = true
		return result, nil
	}

	var minCommit string
	allReconciled := true

	for _, f := range files {
		lastCommit, err := r.rec.GetReconciliationState(f)
		if err != nil {
			return nil, err
		}

		if lastCommit == "" {
			allReconciled = false
			result.Unreconciled = append(result.Unreconciled, model.UnreconciledFile{
				FileID: f,
			})
			continue
		}

		// Match full hash or short-hash prefix (legacy data may have short hashes)
		if lastCommit == head || strings.HasPrefix(head, lastCommit) || strings.HasPrefix(lastCommit, head) {
			if minCommit == "" {
				minCommit = head
			}
			// Upgrade short hash to full hash in the DB
			if lastCommit != head {
				_ = r.rec.SetReconciliationState(f, head)
			}
			continue
		}

		// Check if this file's lastCommit is an ancestor of HEAD
		isAnc, err := r.git.IsAncestor(lastCommit, head)
		if err != nil {
			return nil, err
		}

		if !isAnc {
			// Rebase happened — this file needs re-reconciliation
			allReconciled = false
			result.Unreconciled = append(result.Unreconciled, model.UnreconciledFile{
				FileID:               f,
				LastReconciledCommit: lastCommit,
			})
			continue
		}

		allReconciled = false
		commitsAhead := 0
		if commits, err := r.git.RevList(lastCommit, head); err == nil {
			commitsAhead = len(commits)
		}
		result.Unreconciled = append(result.Unreconciled, model.UnreconciledFile{
			FileID:               f,
			LastReconciledCommit: lastCommit,
			CommitsAhead:         commitsAhead,
		})

		// Track the minimum for reconciled head
		if minCommit == "" {
			minCommit = lastCommit
		} else {
			// Compare: is lastCommit an ancestor of minCommit?
			isAnc, _ := r.git.IsAncestor(lastCommit, minCommit)
			if isAnc {
				minCommit = lastCommit
			}
		}
	}

	if allReconciled {
		result.IsFullyReconciled = true
		result.ReconciledHead = &head
	} else if minCommit != "" {
		result.ReconciledHead = &minCommit
	}

	return result, nil
}

// GetEffectivePositions returns the best known positions for all annotations
// on a file at a given commit. Used by GET /api/findings and /api/comments.
func (r *Reconciler) GetEffectivePositions(fileID, commitID string) (map[string]model.AnnotationPosition, error) {
	// Get all findings, comments, and features for this file
	findings, _, err := r.ann.ListFindings(fileID, 0, 0)
	if err != nil {
		return nil, err
	}
	comments, _, err := r.ann.ListComments(fileID, "", 0, 0)
	if err != nil {
		return nil, err
	}
	features, _, err := r.ann.ListFeatures(fileID, 0, 0)
	if err != nil {
		return nil, err
	}

	result := make(map[string]model.AnnotationPosition)

	// For each annotation, find the best position at or before commitID
	type annRef struct {
		id  string
		typ string
	}
	var refs []annRef
	for _, f := range findings {
		refs = append(refs, annRef{f.ID, "finding"})
	}
	for _, c := range comments {
		refs = append(refs, annRef{c.ID, "comment"})
	}
	for _, feat := range features {
		refs = append(refs, annRef{feat.ID, "feature"})
	}

	for _, ref := range refs {
		positions, err := r.pos.GetPositions(ref.id, ref.typ)
		if err != nil {
			continue
		}
		// Find the best position: the most recent one whose commit is
		// an ancestor of (or equal to) the target commit.
		// Walk backwards since positions are ordered by created_at ASC.
		for i := len(positions) - 1; i >= 0; i-- {
			p := positions[i]
			if p.CommitID == commitID {
				result[ref.id] = p
				break
			}
			isAnc, err := r.git.IsAncestor(p.CommitID, commitID)
			if err == nil && isAnc {
				result[ref.id] = p
				break
			}
		}
	}

	return result, nil
}

// runJob executes the reconciliation in the current goroutine.
func (r *Reconciler) runJob(job *Job) {
	log.Printf("[reconcile] job %s: running (target=%s)", job.ID, job.TargetCommit)
	job.setStatus("running")
	start := time.Now()

	files := job.FilePaths
	if len(files) == 0 {
		var err error
		files, err = r.rec.ListAnnotatedFiles()
		if err != nil {
			log.Printf("[reconcile] job %s: FAILED listing annotated files: %v", job.ID, err)
			job.fail(fmt.Sprintf("list annotated files: %v", err))
			return
		}
	}

	log.Printf("[reconcile] job %s: %d files to reconcile", job.ID, len(files))
	job.setProgress(JobProgress{FilesTotal: len(files)})

	summary := ReconcileSummary{}
	totalCommits := 0

	for i, fileID := range files {
		commitsWalked, fileSummary, err := r.reconcileFile(job, fileID, job.TargetCommit)
		if err != nil {
			log.Printf("[reconcile] job %s: FAILED on file %s: %v", job.ID, fileID, err)
			job.fail(fmt.Sprintf("reconcile %s: %v", fileID, err))
			return
		}
		log.Printf("[reconcile] job %s: file %d/%d %s — %d commits, %d annotations (exact=%d moved=%d orphaned=%d resolved=%d)",
			job.ID, i+1, len(files), fileID, commitsWalked,
			fileSummary.Total, fileSummary.Exact, fileSummary.Moved, fileSummary.Orphaned, fileSummary.Resolved)
		totalCommits += commitsWalked
		summary.Total += fileSummary.Total
		summary.Exact += fileSummary.Exact
		summary.Moved += fileSummary.Moved
		summary.Orphaned += fileSummary.Orphaned
		summary.Resolved += fileSummary.Resolved

		job.setProgress(JobProgress{
			FilesTotal:   len(files),
			FilesDone:    i + 1,
			CommitsTotal: totalCommits,
			CommitsDone:  totalCommits,
		})
	}

	dur := time.Since(start)
	log.Printf("[reconcile] job %s: DONE in %s — %d files, %d commits, %d annotations",
		job.ID, dur, len(files), totalCommits, summary.Total)
	job.complete(&ReconcileResult{
		FilesReconciled: len(files),
		CommitsWalked:   totalCommits,
		Annotations:     summary,
		DurationMs:      dur.Milliseconds(),
	})
}

// annotationInfo holds the working state for an annotation during reconciliation.
type annotationInfo struct {
	id              string
	typ             string // "finding" or "comment"
	lineStart       int
	lineEnd         int
	rangeSize       int // original line count (preserved through orphaning)
	lineHash        string
	confidence      string // current confidence
	alreadyResolved bool   // true if the finding already has a resolvedCommit
}

// reconcileFile walks commits for a single file, mapping all its annotations.
func (r *Reconciler) reconcileFile(job *Job, fileID, targetCommit string) (int, ReconcileSummary, error) {
	// Get the last reconciled commit for this file
	lastCommit, err := r.rec.GetReconciliationState(fileID)
	if err != nil {
		return 0, ReconcileSummary{}, err
	}

	// Gather annotations for this file
	findings, _, err := r.ann.ListFindings(fileID, 0, 0)
	if err != nil {
		return 0, ReconcileSummary{}, err
	}
	comments, _, err := r.ann.ListComments(fileID, "", 0, 0)
	if err != nil {
		return 0, ReconcileSummary{}, err
	}
	features, _, err := r.ann.ListFeatures(fileID, 0, 0)
	if err != nil {
		return 0, ReconcileSummary{}, err
	}

	if len(findings) == 0 && len(comments) == 0 && len(features) == 0 {
		return 0, ReconcileSummary{}, nil
	}

	// Build working annotation list with current positions
	var anns []annotationInfo
	for _, f := range findings {
		a := annotationInfo{id: f.ID, typ: "finding", lineHash: f.LineHash, confidence: "exact"}
		if f.Anchor.LineRange != nil {
			a.lineStart = f.Anchor.LineRange.Start
			a.lineEnd = f.Anchor.LineRange.End
			a.rangeSize = f.Anchor.LineRange.End - f.Anchor.LineRange.Start + 1
		}
		a.alreadyResolved = f.ResolvedCommit != nil
		anns = append(anns, a)
	}
	for _, c := range comments {
		a := annotationInfo{id: c.ID, typ: "comment", lineHash: c.LineHash, confidence: "exact"}
		if c.Anchor.LineRange != nil {
			a.lineStart = c.Anchor.LineRange.Start
			a.lineEnd = c.Anchor.LineRange.End
			a.rangeSize = c.Anchor.LineRange.End - c.Anchor.LineRange.Start + 1
		}
		anns = append(anns, a)
	}
	for _, feat := range features {
		a := annotationInfo{id: feat.ID, typ: "feature", lineHash: feat.LineHash, confidence: "exact"}
		if feat.Anchor.LineRange != nil {
			a.lineStart = feat.Anchor.LineRange.Start
			a.lineEnd = feat.Anchor.LineRange.End
			a.rangeSize = feat.Anchor.LineRange.End - feat.Anchor.LineRange.Start + 1
		}
		a.alreadyResolved = feat.ResolvedCommit != nil
		anns = append(anns, a)
	}

	// If we have stored positions, use those as starting points
	for i := range anns {
		positions, err := r.pos.GetPositions(anns[i].id, anns[i].typ)
		if err != nil || len(positions) == 0 {
			continue
		}
		latest := positions[len(positions)-1]
		if latest.LineStart != nil {
			anns[i].lineStart = *latest.LineStart
		}
		if latest.LineEnd != nil {
			anns[i].lineEnd = *latest.LineEnd
		}
		anns[i].confidence = latest.Confidence
	}

	// Determine the starting commit
	fromCommit := lastCommit
	if fromCommit == "" {
		// No previous reconciliation — use the anchor commit
		// Since all annotations for this file share the same anchor fileID,
		// we use the first annotation's anchor commit as the starting point.
		if len(findings) > 0 {
			fromCommit = findings[0].Anchor.CommitID
		} else if len(comments) > 0 {
			fromCommit = comments[0].Anchor.CommitID
		} else {
			fromCommit = features[0].Anchor.CommitID
		}
	}

	if fromCommit == targetCommit {
		// Already at target — no diff walking needed, but record the state
		// so GetReconciledHead knows this file is reconciled.
		if err := r.rec.SetReconciliationState(fileID, targetCommit); err != nil {
			return 0, ReconcileSummary{}, fmt.Errorf("update reconciliation state: %w", err)
		}
		return 0, countSummary(anns), nil
	}

	// Check ancestry (rebase detection)
	isAnc, err := r.git.IsAncestor(fromCommit, targetCommit)
	if err != nil {
		return 0, ReconcileSummary{}, fmt.Errorf("ancestry check: %w", err)
	}

	if !isAnc {
		// Rebase detected — find merge base and reset
		mergeBase, err := r.git.MergeBase(fromCommit, targetCommit)
		if err != nil {
			return 0, ReconcileSummary{}, fmt.Errorf("merge-base: %w", err)
		}

		// Invalidate positions after merge base:
		// Get commits from mergeBase to fromCommit (the old branch)
		oldCommits, err := r.git.RevList(mergeBase, fromCommit)
		if err != nil {
			return 0, ReconcileSummary{}, fmt.Errorf("rev-list old branch: %w", err)
		}
		if len(oldCommits) > 0 {
			for i := range anns {
				_ = r.pos.DeletePositions(anns[i].id, anns[i].typ, oldCommits)
			}
		}

		fromCommit = mergeBase

		// Re-load positions from merge base
		for i := range anns {
			positions, err := r.pos.GetPositions(anns[i].id, anns[i].typ)
			if err != nil || len(positions) == 0 {
				// Fall back to anchor position
				continue
			}
			latest := positions[len(positions)-1]
			if latest.LineStart != nil {
				anns[i].lineStart = *latest.LineStart
			}
			if latest.LineEnd != nil {
				anns[i].lineEnd = *latest.LineEnd
			}
			anns[i].confidence = latest.Confidence
		}
	}

	// Get the commit path
	commits, err := r.git.RevList(fromCommit, targetCommit)
	if err != nil {
		return 0, ReconcileSummary{}, fmt.Errorf("rev-list: %w", err)
	}

	if len(commits) == 0 {
		return 0, countSummary(anns), nil
	}

	// Walk commits sequentially, tracking the current file path through renames.
	currentPath := fileID
	prev := fromCommit
	for _, commit := range commits {
		rawDiff, err := r.git.DiffRaw(prev, commit, currentPath)
		if err != nil {
			return 0, ReconcileSummary{}, fmt.Errorf("diff %s..%s %s: %w", prev, commit, currentPath, err)
		}

		if rawDiff != "" {
			hunks := ParseDiffHunks(rawDiff)
			if len(hunks) > 0 {
				r.mapAnnotations(anns, hunks, commit, currentPath)
			}
		}

		// Check for file rename. If the file was renamed, update the working
		// path so that subsequent diffs and content matching use the new name.
		if newPath, rErr := r.git.DetectRename(prev, commit, currentPath); rErr == nil && newPath != "" {
			log.Printf("[reconcile] rename detected: %s → %s at %s", currentPath, newPath, commit)
			currentPath = newPath
			// Re-attempt content match for annotations orphaned in this step
			for i := range anns {
				if anns[i].confidence == "orphaned" && anns[i].lineHash != "" {
					r.contentMatch(&anns[i], commit, currentPath)
				}
			}
			// Mark surviving exact annotations as "moved" (file path changed)
			for i := range anns {
				if anns[i].confidence == "exact" {
					anns[i].confidence = "moved"
				}
			}
		}

		prev = commit
	}

	// Verify the file still exists at the target commit. Catches phantom
	// positions where the reconciler saw an empty diff but the file was
	// actually renamed or deleted.
	if _, err := r.git.Show(targetCommit, currentPath); err != nil {
		for i := range anns {
			if anns[i].confidence == "exact" || anns[i].confidence == "moved" {
				anns[i].confidence = "orphaned"
				anns[i].lineStart = 0
				anns[i].lineEnd = 0
			}
		}
	}

	// Store final positions (only deltas — where position or confidence changed)
	for i := range anns {
		fileIDPtr := &currentPath
		if anns[i].confidence == "orphaned" && anns[i].lineStart == 0 {
			fileIDPtr = nil
		}
		err := r.pos.InsertPosition(&model.AnnotationPosition{
			AnnotationID:   anns[i].id,
			AnnotationType: anns[i].typ,
			CommitID:       targetCommit,
			FileID:         fileIDPtr,
			LineStart:      intPtr(anns[i].lineStart),
			LineEnd:        intPtr(anns[i].lineEnd),
			Confidence:     anns[i].confidence,
		})
		if err != nil {
			return 0, ReconcileSummary{}, fmt.Errorf("insert position for %s: %w", anns[i].id, err)
		}
	}

	// Auto-resolve orphaned findings: set status=closed, resolvedCommit,
	// and add a system comment so the change surfaces in baseline deltas.
	resolved := 0
	if r.res != nil {
		var resolveItems []struct{ ID, Commit string }
		for _, a := range anns {
			if a.typ == "finding" && a.confidence == "orphaned" && !a.alreadyResolved {
				resolveItems = append(resolveItems, struct{ ID, Commit string }{a.id, targetCommit})
			}
		}
		if len(resolveItems) > 0 {
			if n, err := r.res.BatchResolveFindings(resolveItems); err != nil {
				log.Printf("[reconcile] warning: auto-resolve findings: %v", err)
			} else {
				resolved = n
				log.Printf("[reconcile] auto-resolved %d orphaned findings at %s", n, targetCommit)
				// Add a system comment to each resolved finding
				now := time.Now().UTC().Format(time.RFC3339)
				for _, item := range resolveItems {
					findingID := item.ID
					_ = r.res.CreateComment(&model.Comment{
						ID: uuid.New().String(),
						Anchor: model.Anchor{
							FileID:   fileID,
							CommitID: targetCommit,
						},
						Author:      "system",
						Text:        fmt.Sprintf("Automatically closed: annotated code was removed in commit %.12s. The original code is no longer present in the repository at this revision.", targetCommit),
						CommentType: "system",
						Timestamp:   now,
						ThreadID:    uuid.New().String(),
						FindingID:   &findingID,
					})
				}
			}
		}
	}

	// Auto-orphan orphaned features
	if r.res != nil {
		var orphanIDs []string
		for _, a := range anns {
			if a.typ == "feature" && a.confidence == "orphaned" && !a.alreadyResolved {
				orphanIDs = append(orphanIDs, a.id)
			}
		}
		if len(orphanIDs) > 0 {
			if err := r.res.BatchOrphanFeatures(orphanIDs, targetCommit); err != nil {
				log.Printf("[reconcile] warning: orphan features: %v", err)
			} else {
				log.Printf("[reconcile] orphaned %d features at %s", len(orphanIDs), targetCommit)
			}
		}
	}

	// Update reconciliation log for the current path
	if err := r.rec.SetReconciliationState(currentPath, targetCommit); err != nil {
		return 0, ReconcileSummary{}, fmt.Errorf("update reconciliation state: %w", err)
	}
	// If path changed, also mark the old path as reconciled so it doesn't
	// get re-queued on the next run.
	if currentPath != fileID {
		_ = r.rec.SetReconciliationState(fileID, targetCommit)
	}

	summary := countSummary(anns)
	summary.Resolved = resolved
	return len(commits), summary, nil
}

// mapAnnotations maps all annotations through a set of diff hunks for a single commit step.
func (r *Reconciler) mapAnnotations(anns []annotationInfo, hunks []DiffHunk, commit, fileID string) {
	for i := range anns {
		if anns[i].confidence == "orphaned" {
			continue // once orphaned, stays orphaned
		}
		if anns[i].lineStart == 0 || anns[i].lineEnd == 0 {
			continue // no line range to map
		}

		newStart, newEnd, ok := MapLineRange(anns[i].lineStart, anns[i].lineEnd, hunks)
		if ok {
			anns[i].lineStart = newStart
			anns[i].lineEnd = newEnd
			anns[i].confidence = "exact"
		} else {
			// Diff mapping failed — try content hash fallback
			matched := r.contentMatch(&anns[i], commit, fileID)
			if !matched {
				anns[i].confidence = "orphaned"
				anns[i].lineStart = 0
				anns[i].lineEnd = 0
			}
		}
	}
}

// contentMatch attempts to find the annotation's content at a new position
// in the file at the given commit using the stored line hash.
func (r *Reconciler) contentMatch(ann *annotationInfo, commit, fileID string) bool {
	if ann.lineHash == "" {
		return false
	}

	rangeSize := ann.rangeSize
	if rangeSize <= 0 {
		return false
	}

	content, err := r.git.Show(commit, fileID)
	if err != nil {
		return false // file might be deleted
	}

	lines := strings.Split(content, "\n")
	if len(lines) < rangeSize {
		return false
	}

	// Slide a window over the file and check hashes
	for i := 0; i <= len(lines)-rangeSize; i++ {
		window := lines[i : i+rangeSize]
		if LineHash(window) == ann.lineHash {
			ann.lineStart = i + 1 // 1-based
			ann.lineEnd = i + rangeSize
			ann.confidence = "moved"
			return true
		}
	}

	return false
}

func countSummary(anns []annotationInfo) ReconcileSummary {
	s := ReconcileSummary{Total: len(anns)}
	for _, a := range anns {
		switch a.confidence {
		case "exact":
			s.Exact++
		case "moved":
			s.Moved++
		case "orphaned":
			s.Orphaned++
		}
	}
	return s
}

func intPtr(n int) *int {
	if n == 0 {
		return nil
	}
	return &n
}
