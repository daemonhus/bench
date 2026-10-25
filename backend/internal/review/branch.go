// Package review knows a project's review branch: the branch its findings,
// changes and history are looked at on. It is saved per project, defaults to
// the repo's default branch, and a request may name another (?branch=).
package review

import (
	"errors"
	"fmt"

	"bench/internal/git"
)

// settingKey is the project setting holding the saved review branch; absent
// or empty means the default branch.
const settingKey = "review_branch"

// Settings is the project's key-value settings store.
type Settings interface {
	GetSetting(key string) (string, bool, error)
	PutSetting(key, value string) error
}

// Branch is the review branch in effect.
type Branch struct {
	// Name is the branch and Tip its head commit. When the repo has no
	// default branch to fall back on, Name is "HEAD".
	Name string `json:"name"`
	Tip  string `json:"tip"`
	// DefaultBranch is the repo's default branch, used when nothing is saved.
	DefaultBranch string `json:"defaultBranch"`
	// Saved is the project's saved branch, "" when it uses the default.
	Saved string `json:"saved"`
	// Override is set when Name came from the request rather than the project.
	Override bool `json:"override"`
	// Missing names a requested or saved branch that doesn't exist (deleted,
	// renamed), which Name stands in for.
	Missing string `json:"missing,omitempty"`
}

// ErrUnknownBranch is returned by Save for a name that isn't a local branch.
var ErrUnknownBranch = errors.New("unknown branch")

// Resolve returns the review branch: override when it names a local branch,
// else the project's saved branch, else the default branch, else HEAD.
func Resolve(s Settings, repo *git.Repo, override string) (Branch, error) {
	saved, _, err := s.GetSetting(settingKey)
	if err != nil {
		return Branch{}, err
	}
	b := Branch{DefaultBranch: repo.DefaultBranch(), Saved: saved}

	if override != "" {
		if tip, err := repo.BranchTip(override); err == nil {
			b.Name, b.Tip, b.Override = override, tip, true
			return b, nil
		}
		b.Missing = override
	}
	if saved != "" {
		if tip, err := repo.BranchTip(saved); err == nil {
			b.Name, b.Tip = saved, tip
			return b, nil
		}
		if b.Missing == "" {
			b.Missing = saved
		}
	}
	if tip, err := repo.BranchTip(b.DefaultBranch); err == nil {
		b.Name, b.Tip = b.DefaultBranch, tip
		return b, nil
	}
	head, err := repo.Head()
	if err != nil {
		return Branch{}, fmt.Errorf("resolve HEAD: %w", err)
	}
	b.Name, b.Tip = "HEAD", head
	return b, nil
}

// Save makes name the project's review branch; "" goes back to the default.
func Save(s Settings, repo *git.Repo, name string) error {
	if name != "" {
		if _, err := repo.BranchTip(name); err != nil {
			return fmt.Errorf("%w: %q is not a local branch", ErrUnknownBranch, name)
		}
	}
	return s.PutSetting(settingKey, name)
}

// Scope tells whether an anchored item (a finding, comment or feature) is on
// the review branch: its anchor commit is in the branch's history. An anchor
// that can't be placed (an unknown or foreign commit) counts as on the
// branch, so nothing disappears because its commit did.
type Scope struct {
	repo *git.Repo
	tip  string
	memo map[string]bool
}

// NewScope returns the scope of the branch whose head is tip.
func NewScope(repo *git.Repo, tip string) *Scope {
	return &Scope{repo: repo, tip: tip, memo: map[string]bool{}}
}

// Has reports whether an item anchored at commit is on the branch. A nil
// Scope is every branch.
func (s *Scope) Has(commit string) bool {
	if s == nil || commit == "" {
		return true
	}
	if v, ok := s.memo[commit]; ok {
		return v
	}
	on, err := s.repo.Contains(s.tip, commit)
	v := err != nil || on
	s.memo[commit] = v
	return v
}
