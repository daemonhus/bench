package model

import (
	"net/url"
	"strings"
)

// InferProvider returns a provider string inferred from the URL hostname.
// Falls back to "url" for unknown domains.
func InferProvider(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return "url"
	}
	host := strings.ToLower(u.Hostname())
	switch {
	case strings.Contains(host, "github.com"):
		return "github"
	case strings.Contains(host, "gitlab.com"):
		return "gitlab"
	case strings.Contains(host, "atlassian.net") || strings.HasPrefix(host, "jira."):
		return "jira"
	case strings.HasPrefix(host, "confluence."):
		return "confluence"
	case strings.Contains(host, "linear.app"):
		return "linear"
	case strings.Contains(host, "notion.so") || strings.Contains(host, "notion.site"):
		return "notion"
	case strings.Contains(host, "slack.com"):
		return "slack"
	default:
		return "url"
	}
}

// Anchor locates a finding or comment within a file at a specific commit.
type Anchor struct {
	FileID    string     `json:"fileId"`
	CommitID  string     `json:"commitId"`
	LineRange *LineRange `json:"lineRange,omitempty"`
}

type LineRange struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

// Ref is an external reference linked to an annotation (finding, feature, or comment).
type Ref struct {
	ID         string `json:"id"`
	EntityType string `json:"entityType"`
	EntityID   string `json:"entityId"`
	Provider   string `json:"provider"`
	URL        string `json:"url"`
	Title      string `json:"title,omitempty"`
	CreatedAt  string `json:"createdAt"`
}

type Finding struct {
	ID              string   `json:"id"`
	ExternalID      string   `json:"externalId,omitempty"`
	Anchor          Anchor   `json:"anchor"`
	Severity        string   `json:"severity"`
	Title           string   `json:"title"`
	Description     string   `json:"description"`
	CWE             string   `json:"cwe"`
	CVE             string   `json:"cve"`
	Vector          string   `json:"vector"`
	Score           float64  `json:"score"`
	Status          string   `json:"status"`
	Source          string   `json:"source"`
	Category        string   `json:"category"`
	CreatedAt       string   `json:"createdAt"`
	ResolvedCommit  *string  `json:"resolvedCommit,omitempty"`
	LineHash        string   `json:"lineHash,omitempty"`
	AnchorUpdatedAt *string  `json:"anchorUpdatedAt,omitempty"`
	CommentCount    int      `json:"commentCount,omitempty"`
	FeatureIDs      []string `json:"features,omitempty"`
	Refs            []Ref    `json:"refs,omitempty"`
}

type Comment struct {
	ID              string  `json:"id"`
	Anchor          Anchor  `json:"anchor"`
	Author          string  `json:"author"`
	Text            string  `json:"text"`
	CommentType     string  `json:"commentType,omitempty"`
	Timestamp       string  `json:"timestamp"`
	ThreadID        string  `json:"threadId"`
	ParentID        *string `json:"parentId,omitempty"`
	FindingID       *string `json:"findingId,omitempty"`
	FeatureID       *string `json:"featureId,omitempty"`
	ResolvedCommit  *string `json:"resolvedCommit,omitempty"`
	LineHash        string  `json:"lineHash,omitempty"`
	AnchorUpdatedAt *string `json:"anchorUpdatedAt,omitempty"`
	Refs            []Ref   `json:"refs,omitempty"`
}

// AnnotationPosition records where an annotation is at a specific commit.
// Only stored when position or confidence changes (delta storage).
type AnnotationPosition struct {
	AnnotationID   string  `json:"annotationId"`
	AnnotationType string  `json:"annotationType"` // "finding" or "comment"
	CommitID       string  `json:"commitId"`
	FileID         *string `json:"fileId,omitempty"`
	LineStart      *int    `json:"lineStart,omitempty"`
	LineEnd        *int    `json:"lineEnd,omitempty"`
	Confidence     string  `json:"confidence"` // "exact", "moved", "orphaned"
	CreatedAt      string  `json:"createdAt"`
}

type FindingWithPosition struct {
	Finding
	EffectiveAnchor *Anchor `json:"effectiveAnchor,omitempty"`
	Confidence      string  `json:"confidence,omitempty"`
}

type CommentWithPosition struct {
	Comment
	EffectiveAnchor *Anchor `json:"effectiveAnchor,omitempty"`
	Confidence      string  `json:"confidence,omitempty"`
}

// FeatureParameter is a structured input/output descriptor attached to a Feature.
type FeatureParameter struct {
	ID          string `json:"id"`
	FeatureID   string `json:"featureId"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Type        string `json:"type,omitempty"`
	Pattern     string `json:"pattern,omitempty"`
	Required    bool   `json:"required"`
	CreatedAt   string `json:"createdAt"`
}

type Feature struct {
	ID              string             `json:"id"`
	Anchor          Anchor             `json:"anchor"`
	Kind            string             `json:"kind"` // interface|source|sink|dependency|externality
	Title           string             `json:"title"`
	Description     string             `json:"description,omitempty"`
	Operation       string             `json:"operation,omitempty"` // HTTP method, gRPC method, GraphQL operation type, etc.
	Direction       string             `json:"direction,omitempty"` // in|out
	Protocol        string             `json:"protocol,omitempty"`
	Status          string             `json:"status"` // draft|active|deprecated|removed|orphaned
	Tags            []string           `json:"tags"`
	Source          string             `json:"source,omitempty"`
	CreatedAt       string             `json:"createdAt"`
	ResolvedCommit  *string            `json:"resolvedCommit,omitempty"`
	LineHash        string             `json:"lineHash,omitempty"`
	AnchorUpdatedAt *string            `json:"anchorUpdatedAt,omitempty"`
	Refs            []Ref              `json:"refs,omitempty"`
	Parameters      []FeatureParameter `json:"parameters"`
}

type FeatureWithPosition struct {
	Feature
	EffectiveAnchor *Anchor `json:"effectiveAnchor,omitempty"`
	Confidence      string  `json:"confidence,omitempty"`
}

type ReconcileFileStatus struct {
	FileID               string `json:"fileId"`
	RequestedCommit      string `json:"requestedCommit"`
	LastReconciledCommit string `json:"lastReconciledCommit,omitempty"`
	IsReconciled         bool   `json:"isReconciled"`
	CommitsAhead         int    `json:"commitsAhead"`
	NeedsRebase          bool   `json:"needsRebase"`
}

type ReconciledHead struct {
	ReconciledHead    *string            `json:"reconciledHead"`
	GitHead           string             `json:"gitHead"`
	IsFullyReconciled bool               `json:"isFullyReconciled"`
	Unreconciled      []UnreconciledFile `json:"unreconciled,omitempty"`
}

type UnreconciledFile struct {
	FileID               string `json:"fileId"`
	LastReconciledCommit string `json:"lastReconciledCommit"`
	CommitsAhead         int    `json:"commitsAhead"`
}

type CommitInfo struct {
	Hash      string `json:"hash"`
	ShortHash string `json:"shortHash"`
	Author    string `json:"author"`
	Date      string `json:"date"`
	Subject   string `json:"subject"`
}

type BranchInfo struct {
	Name      string `json:"name"`
	Head      string `json:"head"`
	IsCurrent bool   `json:"isCurrent"`
	IsRemote  bool   `json:"isRemote"`
}

type GraphCommit struct {
	Hash      string   `json:"hash"`
	ShortHash string   `json:"shortHash"`
	Author    string   `json:"author"`
	Date      string   `json:"date"`
	Subject   string   `json:"subject"`
	Parents   []string `json:"parents"`
	Refs      []string `json:"refs"`
}

type FileEntry struct {
	Path string `json:"path"`
	Type string `json:"type"`
}

type DiffResult struct {
	Raw         string `json:"raw"`
	FullContent string `json:"fullContent"`
}

// GrepMatch is a single search hit from git grep.
type GrepMatch struct {
	File string `json:"file"`
	Line int    `json:"line"`
	Text string `json:"text"`
}

// BlameLine is a single line from git blame output.
type BlameLine struct {
	CommitHash string `json:"commit"`
	Author     string `json:"author"`
	AuthorDate string `json:"date"`
	Line       int    `json:"line"`
	Text       string `json:"text"`
}

// ReviewProgress tracks that a file was reviewed.
type ReviewProgress struct {
	FileID     string `json:"fileId"`
	CommitID   string `json:"commitId"`
	Reviewer   string `json:"reviewer"`
	Note       string `json:"note,omitempty"`
	ReviewedAt string `json:"reviewedAt"`
}

// ReviewCoverage summarizes review state for a set of files.
type ReviewCoverage struct {
	TotalFiles  int                `json:"totalFiles"`
	Reviewed    int                `json:"reviewed"`
	Unreviewed  int                `json:"unreviewed"`
	Stale       int                `json:"stale"`
	CoveragePct float64            `json:"coveragePct"`
	Files       []ReviewFileStatus `json:"files,omitempty"`
}

// ReviewFileStatus is the review state of a single file.
type ReviewFileStatus struct {
	Path       string `json:"path"`
	Status     string `json:"status"` // "reviewed", "stale", "unreviewed"
	ReviewedAt string `json:"reviewedAt,omitempty"`
	Reviewer   string `json:"reviewer,omitempty"`
	Note       string `json:"note,omitempty"`
}

// FindingSummaryRow is an aggregate count for review summary.
type FindingSummaryRow struct {
	Severity string `json:"severity"`
	Status   string `json:"status"`
	Count    int    `json:"count"`
}

// ProjectStats is the summary data the platform needs for dashboards.
type ProjectStats struct {
	FindingsTotal  int            `json:"findingsTotal"`
	FindingsOpen   int            `json:"findingsOpen"`
	BySeverity     map[string]int `json:"bySeverity"`
	BySeverityOpen map[string]int `json:"bySeverityOpen"`
	ByStatus       map[string]int `json:"byStatus"`
	ByCategory     map[string]int `json:"byCategory"`
	CommentsTotal  int            `json:"commentsTotal"`
	CommentsOpen   int            `json:"commentsOpen"`
	FeaturesTotal  int            `json:"featuresTotal"`
	FeaturesActive int            `json:"featuresActive"`
	ByKind         map[string]int `json:"byKind"`
}

// Baseline is an atomic snapshot of the project's state at a specific commit.
type Baseline struct {
	ID             string         `json:"id"`
	Seq            int            `json:"seq"`
	CommitID       string         `json:"commitId"`
	Reviewer       string         `json:"reviewer"`
	Summary        string         `json:"summary"`
	CreatedAt      string         `json:"createdAt"`
	FindingsTotal  int            `json:"findingsTotal"`
	FindingsOpen   int            `json:"findingsOpen"`
	BySeverity     map[string]int `json:"bySeverity"`
	ByStatus       map[string]int `json:"byStatus"`
	ByCategory     map[string]int `json:"byCategory"`
	CommentsTotal  int            `json:"commentsTotal"`
	CommentsOpen   int            `json:"commentsOpen"`
	FindingIDs     []string       `json:"findings"`
	FeaturesTotal  int            `json:"featuresTotal"`
	FeaturesActive int            `json:"featuresActive"`
	ByKind         map[string]int `json:"byKind"`
	FeatureIDs     []string       `json:"features"`
}

// FileStat describes line-level change stats for a single file.
type FileStat struct {
	Path    string `json:"path"`
	Added   int    `json:"added"`
	Deleted int    `json:"deleted"`
}

// BaselineDelta describes changes since a previous baseline.
type BaselineDelta struct {
	SinceBaseline     *Baseline    `json:"sinceBaseline"`
	HeadCommit        string       `json:"headCommit"`
	NewFindings       []Finding    `json:"newFindings"`
	RemovedFindingIDs []string     `json:"removedFindingIds"`
	ChangedFiles      []FileStat   `json:"changedFiles"`
	CurrentStats      ProjectStats `json:"currentStats"`
	NewFeatures       []Feature    `json:"newFeatures"`
	RemovedFeatureIDs []string     `json:"removedFeatureIds"`
}
