package model

import (
	"net/url"
	"strconv"
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
	ResolvedAt      *string  `json:"resolvedAt,omitempty"`
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

// LinkedFeature represents a bidirectional link between two features, with an optional description.
type LinkedFeature struct {
	ID          string `json:"id"`
	Description string `json:"description,omitempty"`
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
	LinkedFeatures  []LinkedFeature    `json:"linkedFeatures"`
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
	// ServiceProfile is embedded so agents entering via delta review absorb
	// the service context without an extra call. Null when unconfigured.
	ServiceProfile *ServiceProfile `json:"serviceProfile"`
}

// ServiceProfile is the singleton set of reviewer-configured meta-attributes
// describing the service under review. Empty fields mean "not configured" —
// never treat absence as confirmation that a control is missing. In the
// multi-select fields, "none" is an explicit positive claim (control confirmed
// absent) and cannot be combined with other values.
type ServiceProfile struct {
	Description         string   `json:"description"`
	Owner               string   `json:"owner"`
	ExternallyFacing    string   `json:"externallyFacing"`
	Compute             string   `json:"compute"`
	DataSensitivity     string   `json:"dataSensitivity"`
	Criticality         string   `json:"criticality"`
	Tenancy             string   `json:"tenancy"`
	Lifecycle           string   `json:"lifecycle"`
	EdgeProtections     []string `json:"edgeProtections"`
	ComplianceScope     []string `json:"complianceScope"`
	AuthenticationModel []string `json:"authenticationModel"`
	ConsumerType        []string `json:"consumerType"`
	UpdatedAt           string   `json:"updatedAt,omitempty"`
}

// Valid values for each ServiceProfile enum field. Single source of truth for
// API, MCP, and CLI validation; the SQLite CHECK constraints mirror the
// single-select sets.
var (
	ProfileExternallyFacingValues = []string{"full", "partial", "none"}
	ProfileComputeValues          = []string{"vps", "kubernetes", "serverless", "bare-metal"}
	ProfileDataSensitivityValues  = []string{"public", "internal", "pii", "payment", "phi", "credentials"}
	ProfileCriticalityValues      = []string{"low", "medium", "high", "critical"}
	ProfileTenancyValues          = []string{"single-tenant", "multi-tenant"}
	ProfileLifecycleValues        = []string{"active", "maintenance", "deprecated", "decommissioning"}

	ProfileEdgeProtectionValues      = []string{"waf", "api-gateway", "rate-limiting", "ddos-protection", "none"}
	ProfileComplianceScopeValues     = []string{"pci-dss", "hipaa", "soc2", "gdpr", "none"}
	ProfileAuthenticationModelValues = []string{"none", "api-key", "oauth-oidc", "mtls", "session", "gateway-terminated"}
	ProfileConsumerTypeValues        = []string{"first-party-frontend", "internal-services", "third-party-partners", "general-public"}
)

// Normalize ensures multi-select fields serialise as [] rather than null.
func (p *ServiceProfile) Normalize() {
	if p.EdgeProtections == nil {
		p.EdgeProtections = []string{}
	}
	if p.ComplianceScope == nil {
		p.ComplianceScope = []string{}
	}
	if p.AuthenticationModel == nil {
		p.AuthenticationModel = []string{}
	}
	if p.ConsumerType == nil {
		p.ConsumerType = []string{}
	}
}

// Validate checks every enum field against its valid-value set. Empty
// single-selects and empty arrays are valid ("not configured"). Field names
// in errors use the JSON names.
func (p *ServiceProfile) Validate() error {
	singles := []struct {
		field, value string
		valid        []string
	}{
		{"externallyFacing", p.ExternallyFacing, ProfileExternallyFacingValues},
		{"compute", p.Compute, ProfileComputeValues},
		{"dataSensitivity", p.DataSensitivity, ProfileDataSensitivityValues},
		{"criticality", p.Criticality, ProfileCriticalityValues},
		{"tenancy", p.Tenancy, ProfileTenancyValues},
		{"lifecycle", p.Lifecycle, ProfileLifecycleValues},
	}
	for _, s := range singles {
		if s.value == "" {
			continue
		}
		if !containsString(s.valid, s.value) {
			return &ProfileValidationError{Field: s.field, Value: s.value, Valid: s.valid}
		}
	}

	multis := []struct {
		field  string
		values []string
		valid  []string
	}{
		{"edgeProtections", p.EdgeProtections, ProfileEdgeProtectionValues},
		{"complianceScope", p.ComplianceScope, ProfileComplianceScopeValues},
		{"authenticationModel", p.AuthenticationModel, ProfileAuthenticationModelValues},
		{"consumerType", p.ConsumerType, ProfileConsumerTypeValues},
	}
	for _, m := range multis {
		hasNone := false
		for _, v := range m.values {
			if !containsString(m.valid, v) {
				return &ProfileValidationError{Field: m.field, Value: v, Valid: m.valid}
			}
			if v == "none" {
				hasNone = true
			}
		}
		if hasNone && len(m.values) > 1 {
			return &ProfileValidationError{Field: m.field, Value: "none", Valid: m.valid, NoneMixed: true}
		}
	}
	return nil
}

// ProfileValidationError describes an invalid ServiceProfile field value.
type ProfileValidationError struct {
	Field     string
	Value     string
	Valid     []string
	NoneMixed bool
}

func (e *ProfileValidationError) Error() string {
	if e.NoneMixed {
		return "invalid " + e.Field + ": \"none\" is an explicit claim and cannot be combined with other values"
	}
	return "invalid " + e.Field + " value " + strconv.Quote(e.Value) + ": valid values are " + strings.Join(e.Valid, ", ")
}

func containsString(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}
