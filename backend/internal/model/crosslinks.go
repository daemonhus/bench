package model

import (
	"fmt"
	"strings"
)

// A reference to an annotation in another project of the same server is written
// "<project-slug>:<id>" wherever a feature id is taken: a feature's linkedFeatures, a
// finding's features. Ids and slugs never contain a colon, so a bare id is always this
// project's own.

// SplitCrossRef reports the project and id of a "<project>:<id>" reference.
func SplitCrossRef(ref string) (project, id string, ok bool) {
	project, id, ok = strings.Cut(ref, ":")
	if !ok || project == "" || id == "" {
		return "", "", false
	}
	return project, id, true
}

// CrossRef writes a reference to an annotation in another project.
func CrossRef(project, id string) string { return project + ":" + id }

// CrossLinks keeps the links between this project's features and findings and features in
// other projects. The server provides it (the links live in its own database, as they span
// two projects); a standalone workbench has none and refuses cross-project references.
// Every method takes and returns references in "<project>:<id>" form.
type CrossLinks interface {
	// Self is this project's slug: "<self>:<id>" is the same as a bare id.
	Self() string
	// FeatureLinks returns, for each of these features, its links to other projects'
	// features, in either direction.
	FeatureLinks(featureIDs []string) (map[string][]LinkedFeature, error)
	// SetFeatureLinks replaces a feature's links to other projects' features. It checks
	// that each target exists (an unknown one is ErrUnknownFeature).
	SetFeatureLinks(featureID string, links []LinkedFeature) error
	// FindingFeatures returns, for each of these findings, the other projects' features
	// it affects.
	FindingFeatures(findingIDs []string) (map[string][]string, error)
	// SetFindingFeatures replaces the other projects' features a finding affects.
	SetFindingFeatures(findingID string, refs []string) error
	// FindingsOn returns, for each of these features, the other projects' findings that
	// affect it.
	FindingsOn(featureIDs []string) (map[string][]string, error)
	// Forget drops every link of a deleted feature or finding (kind "feature"|"finding").
	Forget(kind, id string) error
}

// SplitRefs separates this project's own ids from references to other projects, given
// this project's slug (cross may be nil: then any reference to another project is refused).
func SplitRefs(cross CrossLinks, refs []string) (local, foreign []string, err error) {
	for _, r := range refs {
		project, id, ok := SplitCrossRef(r)
		switch {
		case !ok:
			local = append(local, r)
		case cross != nil && project == cross.Self():
			local = append(local, id)
		case cross == nil:
			return nil, nil, fmt.Errorf("%w: %q names another project, which needs the bench server", ErrUnknownFeature, r)
		default:
			foreign = append(foreign, CrossRef(project, id))
		}
	}
	return local, foreign, nil
}
