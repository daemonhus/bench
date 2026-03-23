package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"

	"bench/internal/db"
	"bench/internal/events"
	"bench/internal/git"
	"bench/internal/reconcile"
)

const (
	protocolVersion = "2025-03-26"
	serverName      = "bench"
	serverVersion   = "0.1.0"

	errInvalidRequest = -32600
	errMethodNotFound = -32601
	errInvalidParams  = -32602
	errInternal       = -32603
)

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      any             `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string    `json:"jsonrpc"`
	ID      any       `json:"id"`
	Result  any       `json:"result,omitempty"`
	Error   *rpcError `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// Handler serves MCP JSON-RPC requests at POST /mcp.
type Handler struct {
	tools map[string]Tool
}

// NewHandler creates an MCP handler wired to the given dependencies.
func NewHandler(database *db.DB, repo *git.Repo, reconciler *reconcile.Reconciler, broker *events.Broker) http.Handler {
	deps := &toolDeps{
		db:         database,
		repo:       repo,
		reconciler: reconciler,
		broker:     broker,
	}
	return &Handler{tools: registerAllTools(deps)}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 4*1024*1024)) // 4MB limit
	if err != nil {
		writeRPCError(w, nil, errInvalidRequest, "failed to read request body")
		return
	}

	var req rpcRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeRPCError(w, nil, errInvalidRequest, "invalid JSON: "+err.Error())
		return
	}
	if req.JSONRPC != "2.0" {
		writeRPCError(w, req.ID, errInvalidRequest, "jsonrpc must be \"2.0\"")
		return
	}

	switch req.Method {
	case "initialize":
		h.handleInitialize(w, req)
	case "notifications/initialized":
		// Client notification — acknowledge with no response
		w.WriteHeader(http.StatusNoContent)
	case "tools/list":
		h.handleToolsList(w, req)
	case "tools/call":
		h.handleToolsCall(r.Context(), w, req)
	case "ping":
		writeRPCResult(w, req.ID, map[string]any{})
	default:
		writeRPCError(w, req.ID, errMethodNotFound, fmt.Sprintf("unknown method: %s", req.Method))
	}
}

func (h *Handler) handleInitialize(w http.ResponseWriter, req rpcRequest) {
	writeRPCResult(w, req.ID, map[string]any{
		"protocolVersion": protocolVersion,
		"capabilities": map[string]any{
			"tools": map[string]any{},
		},
		"serverInfo": map[string]any{
			"name":    serverName,
			"version": serverVersion,
		},
	})
}

func (h *Handler) handleToolsList(w http.ResponseWriter, req rpcRequest) {
	type toolInfo struct {
		Name        string          `json:"name"`
		Description string          `json:"description"`
		InputSchema json.RawMessage `json:"inputSchema"`
	}
	tools := make([]toolInfo, 0, len(h.tools))
	for _, t := range h.tools {
		tools = append(tools, toolInfo{
			Name:        t.Name,
			Description: t.Description,
			InputSchema: t.InputSchema,
		})
	}
	writeRPCResult(w, req.ID, map[string]any{"tools": tools})
}

func (h *Handler) handleToolsCall(ctx context.Context, w http.ResponseWriter, req rpcRequest) {
	var params struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		writeRPCError(w, req.ID, errInvalidParams, "invalid params: "+err.Error())
		return
	}

	tool, ok := h.tools[params.Name]
	if !ok {
		writeRPCError(w, req.ID, errMethodNotFound, fmt.Sprintf("unknown tool: %s", params.Name))
		return
	}

	if err := validateParams(tool.InputSchema, params.Arguments); err != nil {
		writeRPCResult(w, req.ID, map[string]any{
			"isError": true,
			"content": []map[string]string{{"type": "text", "text": err.Error()}},
		})
		return
	}

	args := coerceParams(tool.InputSchema, params.Arguments)
	result, err := tool.Handler(ctx, args)
	if err != nil {
		log.Printf("mcp tool %s error: %v", params.Name, err)
		writeRPCResult(w, req.ID, map[string]any{
			"isError": true,
			"content": []map[string]string{{"type": "text", "text": err.Error()}},
		})
		return
	}

	writeRPCResult(w, req.ID, map[string]any{
		"content": []map[string]string{{"type": "text", "text": result}},
	})
}

func writeRPCResult(w http.ResponseWriter, id any, result any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(rpcResponse{
		JSONRPC: "2.0",
		ID:      id,
		Result:  result,
	})
}

func writeRPCError(w http.ResponseWriter, id any, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(rpcResponse{
		JSONRPC: "2.0",
		ID:      id,
		Error:   &rpcError{Code: code, Message: msg},
	})
}
