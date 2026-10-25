package git

import (
	"errors"
	"path/filepath"
	"testing"

	"github.com/go-git/go-billy/v5/osfs"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/cache"
	"github.com/go-git/go-git/v5/storage"
	"github.com/go-git/go-git/v5/storage/filesystem"
)

// countingStorer counts the reads that reach the real storage.
type countingStorer struct {
	storage.Storer
	reads map[plumbing.Hash]int
}

func (c *countingStorer) EncodedObject(t plumbing.ObjectType, h plumbing.Hash) (plumbing.EncodedObject, error) {
	c.reads[h]++
	return c.Storer.EncodedObject(t, h)
}

func fixtureStorage(t *testing.T, f *fixture) *countingStorer {
	t.Helper()
	st := filesystem.NewStorage(osfs.New(filepath.Join(f.Dir, ".git")), cache.NewObjectLRUDefault())
	return &countingStorer{Storer: st, reads: map[plumbing.Hash]int{}}
}

// Commits and trees are read from the storage once; blobs every time.
func TestObjectCache_KeepsCommitsAndTrees(t *testing.T) {
	f := newFixture(t)
	under := fixtureStorage(t, f)
	s := withObjectCache(under)

	commit := plumbing.NewHash(f.C2)
	tree := mustTreeOf(t, f, f.C2)
	blob := plumbing.ComputeHash(plumbing.BlobObject, []byte("ccc\n")) // c.txt at C2

	for i := 0; i < 3; i++ {
		for _, read := range []struct {
			typ plumbing.ObjectType
			h   plumbing.Hash
		}{{plumbing.CommitObject, commit}, {plumbing.TreeObject, tree}, {plumbing.BlobObject, blob}} {
			if _, err := s.EncodedObject(read.typ, read.h); err != nil {
				t.Fatalf("read %s %s: %v", read.typ, read.h, err)
			}
		}
	}
	if n := under.reads[commit]; n != 1 {
		t.Errorf("commit read from storage %d times, want 1", n)
	}
	if n := under.reads[tree]; n != 1 {
		t.Errorf("tree read from storage %d times, want 1", n)
	}
	if n := under.reads[blob]; n != 3 {
		t.Errorf("blob read from storage %d times, want 3 (blobs aren't kept)", n)
	}
}

// A cached object asked for as another type is not found, as from the storage itself.
func TestObjectCache_WrongTypeIsNotFound(t *testing.T) {
	f := newFixture(t)
	s := withObjectCache(fixtureStorage(t, f))
	commit := plumbing.NewHash(f.C1)
	if _, err := s.EncodedObject(plumbing.CommitObject, commit); err != nil {
		t.Fatal(err)
	}
	if _, err := s.EncodedObject(plumbing.TreeObject, commit); !errors.Is(err, plumbing.ErrObjectNotFound) {
		t.Fatalf("commit read as a tree: got %v, want ErrObjectNotFound", err)
	}
}

// An abbreviated hash still resolves through the cached storage.
func TestObjectCache_ShortHashResolves(t *testing.T) {
	f := newFixture(t)
	got, err := f.Repo.ResolveRef(f.C2[:7])
	if err != nil {
		t.Fatalf("ResolveRef(%s): %v", f.C2[:7], err)
	}
	if got != f.C2 {
		t.Fatalf("ResolveRef(%s) = %s, want %s", f.C2[:7], got, f.C2)
	}
}

func mustTreeOf(t *testing.T, f *fixture, commit string) plumbing.Hash {
	t.Helper()
	repo, err := f.Repo.backend.(*GoGitBackend).open()
	if err != nil {
		t.Fatal(err)
	}
	c, err := repo.CommitObject(plumbing.NewHash(commit))
	if err != nil {
		t.Fatal(err)
	}
	return c.TreeHash
}
