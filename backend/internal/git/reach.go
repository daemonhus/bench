package git

import (
	"sync"

	"github.com/go-git/go-git/v5/plumbing"
)

// reachTips is how many branch tips keep a reach index. Each holds a hash per
// commit walked, so a few tips stay small even on a long history.
const reachTips = 4

// reachIndex answers "is this commit in tip's history?" for one tip, walking
// the history breadth first only as far as the questions need: a commit near
// the tip is found after a few steps, and only a commit that isn't there walks
// the whole history, once per tip.
type reachIndex struct {
	mu       sync.Mutex
	seen     map[plumbing.Hash]struct{}
	frontier []plumbing.Hash
	lastUse  uint64
}

// Contains reports whether commit is tip or one of its ancestors. Either may
// be any commitish; ErrUnknownRef if one doesn't resolve.
func (b *GoGitBackend) Contains(tip, commit string) (bool, error) {
	if err := validateRef(tip); err != nil {
		return false, err
	}
	if err := validateRef(commit); err != nil {
		return false, err
	}
	repo, err := b.open()
	if err != nil {
		return false, err
	}
	t, err := repo.ResolveRevision(plumbing.Revision(tip))
	if err != nil {
		return false, classifyGoGitErr(err)
	}
	c, err := repo.ResolveRevision(plumbing.Revision(commit))
	if err != nil {
		return false, classifyGoGitErr(err)
	}

	idx := b.reachIndexFor(*t)
	idx.mu.Lock()
	defer idx.mu.Unlock()
	for {
		if _, ok := idx.seen[*c]; ok {
			return true, nil
		}
		if len(idx.frontier) == 0 {
			return false, nil
		}
		next := idx.frontier[0]
		idx.frontier = idx.frontier[1:]
		obj, err := repo.CommitObject(next)
		if err != nil {
			// A missing parent (shallow clone) ends that line of history.
			continue
		}
		for _, p := range obj.ParentHashes {
			if _, ok := idx.seen[p]; !ok {
				idx.seen[p] = struct{}{}
				idx.frontier = append(idx.frontier, p)
			}
		}
	}
}

// reachIndexFor returns tip's index, making it (and dropping the least
// recently used one beyond reachTips) if needed.
func (b *GoGitBackend) reachIndexFor(tip plumbing.Hash) *reachIndex {
	b.reachMu.Lock()
	defer b.reachMu.Unlock()
	b.reachClock++
	if idx, ok := b.reach[tip]; ok {
		idx.lastUse = b.reachClock
		return idx
	}
	if b.reach == nil {
		b.reach = map[plumbing.Hash]*reachIndex{}
	}
	if len(b.reach) >= reachTips {
		var oldest plumbing.Hash
		var oldestUse uint64
		for h, idx := range b.reach {
			if oldestUse == 0 || idx.lastUse < oldestUse {
				oldest, oldestUse = h, idx.lastUse
			}
		}
		delete(b.reach, oldest)
	}
	idx := &reachIndex{
		seen:     map[plumbing.Hash]struct{}{tip: {}},
		frontier: []plumbing.Hash{tip},
		lastUse:  b.reachClock,
	}
	b.reach[tip] = idx
	return idx
}
