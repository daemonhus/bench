package reconcile

import (
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

// Job tracks the lifecycle of an async reconciliation run.
// All fields are accessed under mu except Status reads via atomic.
type Job struct {
	mu           sync.Mutex
	ID           string
	Status       string // "pending", "running", "done", "failed"
	TargetCommit string
	FilePaths    []string // nil = all annotated files
	Progress     JobProgress
	Result       *ReconcileResult
	Error        string
	CreatedAt    time.Time
	CompletedAt  *time.Time
	statusAtomic atomic.Value // for lock-free status reads
}

type JobProgress struct {
	CurrentFile  string `json:"currentFile"`
	FilesTotal   int    `json:"filesTotal"`
	FilesDone    int    `json:"filesDone"`
	CommitsTotal int    `json:"commitsTotal"`
	CommitsDone  int    `json:"commitsDone"`
}

type ReconcileResult struct {
	FilesReconciled int              `json:"filesReconciled"`
	CommitsWalked   int              `json:"commitsWalked"`
	Annotations     ReconcileSummary `json:"annotations"`
	DurationMs      int64            `json:"durationMs"`
}

type ReconcileSummary struct {
	Total    int `json:"total"`
	Exact    int `json:"exact"`
	Moved    int `json:"moved"`
	Orphaned int `json:"orphaned"`
	Resolved int `json:"resolved,omitempty"` // orphaned findings auto-closed
}

var jobCounter atomic.Int64

func newJob(targetCommit string, filePaths []string) *Job {
	id := fmt.Sprintf("rec-%d", jobCounter.Add(1))
	j := &Job{
		ID:           id,
		Status:       "pending",
		TargetCommit: targetCommit,
		FilePaths:    filePaths,
		CreatedAt:    time.Now(),
	}
	j.statusAtomic.Store("pending")
	return j
}

func (j *Job) setStatus(s string) {
	j.mu.Lock()
	j.Status = s
	j.statusAtomic.Store(s)
	j.mu.Unlock()
}

func (j *Job) setProgress(p JobProgress) {
	j.mu.Lock()
	j.Progress = p
	j.mu.Unlock()
}

func (j *Job) complete(result *ReconcileResult) {
	now := time.Now()
	j.mu.Lock()
	j.Status = "done"
	j.statusAtomic.Store("done")
	j.Result = result
	j.CompletedAt = &now
	j.mu.Unlock()
}

func (j *Job) fail(err string) {
	now := time.Now()
	j.mu.Lock()
	j.Status = "failed"
	j.statusAtomic.Store("failed")
	j.Error = err
	j.CompletedAt = &now
	j.mu.Unlock()
}

// Snapshot returns a copy safe for serialization.
func (j *Job) Snapshot() JobSnapshot {
	j.mu.Lock()
	defer j.mu.Unlock()
	s := JobSnapshot{
		JobID:        j.ID,
		Status:       j.Status,
		TargetCommit: j.TargetCommit,
		Progress:     j.Progress,
		Result:       j.Result,
		Error:        j.Error,
	}
	return s
}

// JobSnapshot is a point-in-time copy of a Job, safe for JSON serialization.
type JobSnapshot struct {
	JobID        string           `json:"jobId"`
	Status       string           `json:"status"`
	TargetCommit string           `json:"targetCommit"`
	Progress     JobProgress      `json:"progress,omitempty"`
	Result       *ReconcileResult `json:"result,omitempty"`
	Error        string           `json:"error,omitempty"`
}
