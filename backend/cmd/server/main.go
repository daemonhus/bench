package main

import (
	"flag"
	"log"
	"net/http"
	"os"

	workbench "bench"
	"bench/internal/api"
)

func main() {
	repoPath := flag.String("repo", ".", "Path to git repository")
	dbPath := flag.String("db", "bench.db", "SQLite database path")
	addr := flag.String("addr", ":8081", "Listen address")
	flag.Parse()

	wb, err := workbench.Open(*repoPath, *dbPath)
	if err != nil {
		log.Fatalf("failed to open workbench: %v", err)
	}
	defer wb.Close()

	mux := http.NewServeMux()
	mux.Handle("/api/", wb.APIHandler())
	mux.Handle("/mcp", wb.MCPHandler())
	mux.Handle("/", workbench.SPAHandler())

	log.Printf("listening on %s (repo=%s, db=%s)", *addr, *repoPath, *dbPath)
	if err := http.ListenAndServe(*addr, api.WithMiddleware(mux)); err != nil {
		log.Fatal(err)
	}
}

func init() {
	if _, ok := os.LookupEnv("PATH"); !ok {
		log.Println("warning: PATH not set")
	}
}
