package mcp

import (
	"fmt"

	"bench/internal/review"
)

// branchProp is the schema property of every tool whose answer depends on the
// review branch, spliced in at the head of its properties.
const branchProp = `"branch": {"type": "string", "description": "Look at this branch instead of the project's review branch (as ?branch= over REST)"},`

// allBranchesProp is the schema property of the list tools, which otherwise
// show only what's on the branch.
const allBranchesProp = `"all_branches": {"type": "boolean", "description": "Include items anchored on other branches (default: false)"},`

// reviewBranch is the review branch in effect: the named one when given
// (as ?branch= over REST), else the project's.
func (d *toolDeps) reviewBranch(branch string) (review.Branch, error) {
	return review.Resolve(d.db, d.repo, branch)
}

// tip is the head of the review branch, where a tool's commit defaults to.
func (d *toolDeps) tip(branch string) (string, error) {
	b, err := d.reviewBranch(branch)
	if err != nil {
		return "", err
	}
	return b.Tip, nil
}

// scope is what a list is filtered to: the review branch, or nil (everything)
// for all_branches.
func (d *toolDeps) scope(branch string, all bool) (*review.Scope, error) {
	if all {
		return nil, nil
	}
	b, err := d.reviewBranch(branch)
	if err != nil {
		return nil, err
	}
	return review.NewScope(d.repo, b.Tip), nil
}

// offBranchNote closes a scoped list with how many items it left out; empty
// when it left none out, or wasn't scoped.
func offBranchNote(scope *review.Scope, off int) string {
	if scope == nil || off == 0 {
		return ""
	}
	return fmt.Sprintf("\n(%d on other branches, not shown; all_branches=true includes them)", off)
}
