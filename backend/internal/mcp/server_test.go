package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// testHandler creates an MCP handler with no real deps — just for protocol testing.
// Tools that require deps will error, but we can test dispatch and tool listing.
func testHandler() http.Handler {
	deps := &toolDeps{}
	tools := map[string]Tool{
		"echo": {
			Name:        "echo",
			Description: "Echoes back the input text.",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}`),
			Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
				var p struct {
					Text string `json:"text"`
				}
				json.Unmarshal(params, &p)
				return "echo: " + p.Text, nil
			},
		},
	}
	_ = deps // suppress unused
	return &Handler{tools: tools}
}

func rpcCall(t *testing.T, handler http.Handler, method string, params any) rpcResponse {
	t.Helper()
	body := map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  method,
	}
	if params != nil {
		b, _ := json.Marshal(params)
		body["params"] = json.RawMessage(b)
	}
	b, _ := json.Marshal(body)

	req := httptest.NewRequest(http.MethodPost, "/mcp", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	var resp rpcResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v (body: %s)", err, rec.Body.String())
	}
	return resp
}

func TestInitialize(t *testing.T) {
	h := testHandler()
	resp := rpcCall(t, h, "initialize", map[string]any{})

	if resp.Error != nil {
		t.Fatalf("unexpected error: %v", resp.Error)
	}
	result, ok := resp.Result.(map[string]any)
	if !ok {
		t.Fatalf("expected map result, got %T", resp.Result)
	}
	if result["protocolVersion"] != protocolVersion {
		t.Errorf("expected protocol version %s, got %v", protocolVersion, result["protocolVersion"])
	}
	caps, _ := result["capabilities"].(map[string]any)
	if caps == nil {
		t.Fatal("missing capabilities")
	}
	if _, ok := caps["tools"]; !ok {
		t.Error("missing tools capability")
	}
}

func TestToolsList(t *testing.T) {
	h := testHandler()
	resp := rpcCall(t, h, "tools/list", nil)

	if resp.Error != nil {
		t.Fatalf("unexpected error: %v", resp.Error)
	}
	result, _ := resp.Result.(map[string]any)
	tools, ok := result["tools"].([]any)
	if !ok {
		t.Fatalf("expected tools array, got %T", result["tools"])
	}
	if len(tools) != 1 {
		t.Fatalf("expected 1 tool, got %d", len(tools))
	}
	tool, _ := tools[0].(map[string]any)
	if tool["name"] != "echo" {
		t.Errorf("expected tool name 'echo', got %v", tool["name"])
	}
}

func TestToolsCall_Success(t *testing.T) {
	h := testHandler()
	resp := rpcCall(t, h, "tools/call", map[string]any{
		"name":      "echo",
		"arguments": map[string]any{"text": "hello"},
	})

	if resp.Error != nil {
		t.Fatalf("unexpected error: %v", resp.Error)
	}
	result, _ := resp.Result.(map[string]any)
	content, _ := result["content"].([]any)
	if len(content) == 0 {
		t.Fatal("expected content blocks")
	}
	block, _ := content[0].(map[string]any)
	if block["text"] != "echo: hello" {
		t.Errorf("expected 'echo: hello', got %v", block["text"])
	}
}

func TestToolsCall_UnknownTool(t *testing.T) {
	h := testHandler()
	resp := rpcCall(t, h, "tools/call", map[string]any{
		"name":      "nonexistent",
		"arguments": map[string]any{},
	})

	if resp.Error == nil {
		t.Fatal("expected error for unknown tool")
	}
	if resp.Error.Code != errMethodNotFound {
		t.Errorf("expected error code %d, got %d", errMethodNotFound, resp.Error.Code)
	}
}

func TestUnknownMethod(t *testing.T) {
	h := testHandler()
	resp := rpcCall(t, h, "resources/list", nil)

	if resp.Error == nil {
		t.Fatal("expected error for unknown method")
	}
	if resp.Error.Code != errMethodNotFound {
		t.Errorf("expected error code %d, got %d", errMethodNotFound, resp.Error.Code)
	}
}

func TestPing(t *testing.T) {
	h := testHandler()
	resp := rpcCall(t, h, "ping", nil)

	if resp.Error != nil {
		t.Fatalf("unexpected error: %v", resp.Error)
	}
}

func TestMethodNotAllowed(t *testing.T) {
	h := testHandler()
	req := httptest.NewRequest(http.MethodGet, "/mcp", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", rec.Code)
	}
}

func TestValidateParams_AcceptsValidKeys(t *testing.T) {
	schema := json.RawMessage(`{"type":"object","properties":{"file":{},"commit":{},"finding_id":{}}}`)
	params := json.RawMessage(`{"file":"a.go","commit":"abc"}`)
	if err := validateParams(schema, params); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestValidateParams_RejectsCamelCase(t *testing.T) {
	schema := json.RawMessage(`{"type":"object","properties":{"file":{},"finding_id":{},"line_start":{}}}`)
	params := json.RawMessage(`{"file":"a.go","findingId":"f1","lineStart":10}`)
	err := validateParams(schema, params)
	if err == nil {
		t.Fatal("expected error for camelCase keys")
	}
	msg := err.Error()
	if !strings.Contains(msg, `"findingId" (use "finding_id" instead)`) {
		t.Errorf("expected suggestion for findingId, got: %s", msg)
	}
	if !strings.Contains(msg, `"lineStart" (use "line_start" instead)`) {
		t.Errorf("expected suggestion for lineStart, got: %s", msg)
	}
}

func TestValidateParams_RejectsUnknownKey(t *testing.T) {
	schema := json.RawMessage(`{"type":"object","properties":{"file":{},"text":{}}}`)
	params := json.RawMessage(`{"file":"a.go","text":"hello","bogus":"val"}`)
	err := validateParams(schema, params)
	if err == nil {
		t.Fatal("expected error for unknown key")
	}
	if !strings.Contains(err.Error(), `"bogus"`) {
		t.Errorf("expected bogus in error, got: %s", err.Error())
	}
}

func TestCamelToSnake(t *testing.T) {
	tests := []struct{ in, want string }{
		{"findingId", "finding_id"},
		{"lineStart", "line_start"},
		{"commentType", "comment_type"},
		{"file", "file"},
		{"includeResolved", "include_resolved"},
	}
	for _, tt := range tests {
		got := camelToSnake(tt.in)
		if got != tt.want {
			t.Errorf("camelToSnake(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestCoerceParams_StringToInt(t *testing.T) {
	schema := json.RawMessage(`{"type":"object","properties":{"line_start":{"type":"integer"},"line_end":{"type":"integer"},"file":{"type":"string"}}}`)
	params := json.RawMessage(`{"line_start":"24","line_end":"36","file":"a.go"}`)
	out := coerceParams(schema, params)

	var m map[string]json.RawMessage
	json.Unmarshal(out, &m)

	if string(m["line_start"]) != "24" {
		t.Errorf("line_start: got %s, want 24", string(m["line_start"]))
	}
	if string(m["line_end"]) != "36" {
		t.Errorf("line_end: got %s, want 36", string(m["line_end"]))
	}
	// String fields should stay as strings
	if string(m["file"]) != `"a.go"` {
		t.Errorf("file: got %s, want \"a.go\"", string(m["file"]))
	}
}

func TestCoerceParams_StringToBool(t *testing.T) {
	schema := json.RawMessage(`{"type":"object","properties":{"include_resolved":{"type":"boolean"}}}`)
	params := json.RawMessage(`{"include_resolved":"true"}`)
	out := coerceParams(schema, params)

	var m map[string]json.RawMessage
	json.Unmarshal(out, &m)
	if string(m["include_resolved"]) != "true" {
		t.Errorf("got %s, want true", string(m["include_resolved"]))
	}
}

func TestCoerceParams_AlreadyCorrectType(t *testing.T) {
	schema := json.RawMessage(`{"type":"object","properties":{"line_start":{"type":"integer"}}}`)
	params := json.RawMessage(`{"line_start":24}`)
	out := coerceParams(schema, params)

	var m map[string]json.RawMessage
	json.Unmarshal(out, &m)
	if string(m["line_start"]) != "24" {
		t.Errorf("got %s, want 24", string(m["line_start"]))
	}
}

func TestCoerceParams_NonNumericStringStaysString(t *testing.T) {
	schema := json.RawMessage(`{"type":"object","properties":{"line_start":{"type":"integer"}}}`)
	params := json.RawMessage(`{"line_start":"abc"}`)
	out := coerceParams(schema, params)

	var m map[string]json.RawMessage
	json.Unmarshal(out, &m)
	// Can't coerce "abc" to int, so it stays as the original string
	if string(m["line_start"]) != `"abc"` {
		t.Errorf("got %s, want \"abc\"", string(m["line_start"]))
	}
}

func TestInvalidJSON(t *testing.T) {
	h := testHandler()
	req := httptest.NewRequest(http.MethodPost, "/mcp", bytes.NewReader([]byte("not json")))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	var resp rpcResponse
	json.NewDecoder(rec.Body).Decode(&resp)
	if resp.Error == nil {
		t.Fatal("expected error for invalid JSON")
	}
	if resp.Error.Code != errInvalidRequest {
		t.Errorf("expected error code %d, got %d", errInvalidRequest, resp.Error.Code)
	}
}
