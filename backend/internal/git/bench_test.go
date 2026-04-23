package git

import (
	"fmt"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// benchRepo is built once per process and reused across benchmarks so setup
// cost (100 commits, ~50 files) doesn't distort per-op numbers.
var (
	benchRepoOnce sync.Once
	benchRepo     *Repo
	benchHeadFile string // a medium-sized file present at HEAD
)

// setupBenchRepo builds a synthetic repo with ~100 commits touching ~50
// files. Sizes are chosen to be realistic for review workloads: big enough
// that Log/Tree/Grep are non-trivial, small enough that the fixture builds
// in a second or two.
func setupBenchRepo(tb testing.TB) *Repo {
	tb.Helper()
	benchRepoOnce.Do(func() {
		dir, err := os.MkdirTemp("", "bench-git-*")
		if err != nil {
			tb.Fatalf("MkdirTemp: %v", err)
		}
		run := func(args ...string) {
			cmd := exec.Command("git", args...)
			cmd.Dir = dir
			cmd.Env = append(os.Environ(),
				"GIT_AUTHOR_NAME=Bench", "GIT_AUTHOR_EMAIL=bench@example.com",
				"GIT_COMMITTER_NAME=Bench", "GIT_COMMITTER_EMAIL=bench@example.com",
			)
			if out, err := cmd.CombinedOutput(); err != nil {
				tb.Fatalf("git %v: %v\n%s", args, err, out)
			}
		}
		run("init", "-b", "main")
		run("config", "user.email", "bench@example.com")
		run("config", "user.name", "Bench")
		run("config", "commit.gpgsign", "false")

		// 50 files of ~2KB each, 100 commits each touching 1-3 files.
		rng := rand.New(rand.NewSource(1))
		const numFiles = 50
		const numCommits = 100
		files := make([]string, numFiles)
		for i := range files {
			files[i] = fmt.Sprintf("pkg%02d/file_%02d.go", i/10, i)
		}
		lines := make([][]string, numFiles)
		for i := range lines {
			lines[i] = make([]string, 40)
			for j := range lines[i] {
				lines[i][j] = fmt.Sprintf("// pkg %02d line %02d token%d keyword_%d", i, j, rng.Intn(1000), rng.Intn(100))
			}
		}
		writeFile := func(i int) {
			full := filepath.Join(dir, files[i])
			if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
				tb.Fatal(err)
			}
			if err := os.WriteFile(full, []byte(strings.Join(lines[i], "\n")+"\n"), 0644); err != nil {
				tb.Fatal(err)
			}
		}
		for i := range files {
			writeFile(i)
		}
		run("add", ".")
		run("commit", "-m", "c0: seed")

		for c := 1; c <= numCommits; c++ {
			touched := 1 + rng.Intn(3)
			for k := 0; k < touched; k++ {
				i := rng.Intn(numFiles)
				j := rng.Intn(len(lines[i]))
				lines[i][j] = fmt.Sprintf("// pkg %02d line %02d token%d keyword_%d (rev %d)", i, j, rng.Intn(1000), rng.Intn(100), c)
				writeFile(i)
			}
			run("add", ".")
			run("commit", "-m", fmt.Sprintf("c%d: tweak", c))
		}

		benchRepo = NewRepo(dir)
		benchHeadFile = files[0]
	})
	return benchRepo
}

func BenchmarkLog100(b *testing.B) {
	r := setupBenchRepo(b)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := r.Log(100); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkTreeRoot(b *testing.B) {
	r := setupBenchRepo(b)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := r.Tree("HEAD"); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkShowMediumFile(b *testing.B) {
	r := setupBenchRepo(b)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := r.Show("HEAD", benchHeadFile); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkGrepModerate(b *testing.B) {
	r := setupBenchRepo(b)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := r.Grep("keyword_42", "HEAD", "", false, false, 1000); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkBlameSmall(b *testing.B) {
	r := setupBenchRepo(b)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := r.Blame("HEAD", benchHeadFile, 0, 0); err != nil {
			b.Fatal(err)
		}
	}
}
