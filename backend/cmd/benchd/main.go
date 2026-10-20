package main

import (
	"flag"
	"log"

	"bench/internal/server"
)

func main() {
	dataDir := flag.String("data", ".", "Data directory for databases")
	addr := flag.String("addr", ":8080", "Listen address")
	flag.Parse()

	if err := server.Run(*dataDir, *addr); err != nil {
		log.Fatal(err)
	}
}
