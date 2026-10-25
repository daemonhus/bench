package git

import (
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/cache"
	"github.com/go-git/go-git/v5/storage"
)

// objectCacheSize bounds each repository handle's cache of commits and trees.
const objectCacheSize = 16 * cache.MiByte

// cachedStorer answers reads of commits and trees from memory. go-git's own storage opens an
// object's loose file on every read, cached or not, and tries that path before the packfiles, so
// a repository of loose objects (one never repacked, which bench doesn't control) pays a file
// open for every object of every history walk, diff and tree listing. An object never changes
// under its hash, so a cached one is always right. Blobs aren't kept: they are read once per
// view, and would crowd out the trees and commits that walks read over and over.
type cachedStorer struct {
	storage.Storer
	objects cache.Object
}

func withObjectCache(s storage.Storer) storage.Storer {
	return &cachedStorer{Storer: s, objects: cache.NewObjectLRU(objectCacheSize)}
}

func (s *cachedStorer) EncodedObject(t plumbing.ObjectType, h plumbing.Hash) (plumbing.EncodedObject, error) {
	if obj, ok := s.objects.Get(h); ok {
		if t != plumbing.AnyObject && obj.Type() != t {
			return nil, plumbing.ErrObjectNotFound
		}
		return obj, nil
	}
	obj, err := s.Storer.EncodedObject(t, h)
	if err != nil {
		return nil, err
	}
	if typ := obj.Type(); typ == plumbing.CommitObject || typ == plumbing.TreeObject {
		s.objects.Put(obj)
	}
	return obj, nil
}

// HashesWithPrefix passes on the filesystem storage's index lookup, which go-git uses to resolve
// an abbreviated hash; without it, it would read every object in the repository instead.
func (s *cachedStorer) HashesWithPrefix(prefix []byte) ([]plumbing.Hash, error) {
	type prefixed interface {
		HashesWithPrefix(prefix []byte) ([]plumbing.Hash, error)
	}
	if p, ok := s.Storer.(prefixed); ok {
		return p.HashesWithPrefix(prefix)
	}
	return nil, plumbing.ErrObjectNotFound
}
