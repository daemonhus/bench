package api

import (
	"fmt"
	"net/http"

	"bench/internal/events"
)

type eventsHandler struct {
	broker *events.Broker
}

func (h *eventsHandler) stream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // nginx
	flusher.Flush()

	id, ch := h.broker.Subscribe()
	defer h.broker.Unsubscribe(id)

	for {
		select {
		case topic, ok := <-ch:
			if !ok {
				return
			}
			fmt.Fprintf(w, "event: %s\ndata: {}\n\n", topic)
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}
