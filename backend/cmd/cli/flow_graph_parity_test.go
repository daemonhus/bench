package main

import (
	"encoding/json"
	"sort"
	"strings"
	"testing"
)

// The same flow edits through REST, MCP and the CLI build the same graph: each surface runs
// one script (append, insert, branch, move along the path, splice out, set an edge, update a
// step, re-parent) on its own flow, and the exports must match.

type flowOps struct {
	create  func(name string) string
	add     func(flow, feature string, place map[string]any) string
	move    func(flow, step string, place map[string]any)
	remove  func(flow, step, mode string)
	setEdge func(flow, from, to string, props map[string]any)
	update  func(flow, step string, fields map[string]any)
}

// firstJSON decodes the first JSON object in out (CLI stdout, possibly followed by notes).
func firstJSON(t *testing.T, out string, v any) {
	t.Helper()
	i := strings.Index(out, "{")
	if i < 0 {
		t.Fatalf("no JSON in output: %s", out)
	}
	if err := json.NewDecoder(strings.NewReader(out[i:])).Decode(v); err != nil {
		t.Fatalf("decode %s: %v", out, err)
	}
}

func idOf(t *testing.T, out string) string {
	t.Helper()
	var v struct {
		ID string `json:"id"`
	}
	firstJSON(t, out, &v)
	if v.ID == "" {
		t.Fatalf("no id in %s", out)
	}
	return v.ID
}

func TestFlowGraph_SurfacesBuildTheSameFlow(t *testing.T) {
	e := setupParity(t)
	rest := func(method, path string, body any) string {
		t.Helper()
		var b []byte
		if body != nil {
			b, _ = json.Marshal(body)
		}
		code, data := serverCall(t, e.srv, method, path, b)
		if code >= 300 {
			t.Fatalf("%s %s: %d %s", method, path, code, data)
		}
		return string(data)
	}
	mcp := func(tool string, args map[string]any) string {
		t.Helper()
		ok, msg := e.mcpAt(t, "/mcp", tool, args)
		if !ok {
			t.Fatalf("mcp %s %v: %s", tool, args, msg)
		}
		return msg
	}
	cli := func(args ...string) string {
		t.Helper()
		ok, out := e.cli(t, args...)
		if !ok {
			t.Fatalf("cli %v: %s", args, out)
		}
		return out
	}
	// edgeArgs spells edge props as CLI flags.
	cliEdge := func(props map[string]any) []string {
		var args []string
		keys := make([]string, 0, len(props))
		for k := range props {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		flag := map[string]string{"trustBoundary": "trust-boundary"}
		for _, k := range keys {
			name := k
			if f, ok := flag[k]; ok {
				name = f
			}
			switch v := props[k].(type) {
			case bool:
				if v {
					args = append(args, "--"+name, "true")
				} else {
					args = append(args, "--"+name, "false")
				}
			case []string:
				args = append(args, "--"+name, strings.Join(v, ","))
			default:
				args = append(args, "--"+name, v.(string))
			}
		}
		return args
	}
	snake := map[string]string{"trustBoundary": "trust_boundary"}
	mcpEdge := func(args map[string]any, props map[string]any) map[string]any {
		for k, v := range props {
			if s, ok := snake[k]; ok {
				k = s
			}
			args[k] = v
		}
		return args
	}

	surfaces := map[string]flowOps{
		"REST": {
			create: func(name string) string { return idOf(t, rest("POST", "/api/flows", map[string]any{"name": name})) },
			add: func(flow, feature string, place map[string]any) string {
				body := map[string]any{"projectSlug": testProject, "featureId": feature}
				for k, v := range place {
					body[k] = v
				}
				return idOf(t, rest("POST", "/api/flows/"+flow+"/steps", body))
			},
			move: func(flow, step string, place map[string]any) {
				rest("POST", "/api/flows/"+flow+"/steps/"+step+"/move", place)
			},
			remove: func(flow, step, mode string) { rest("DELETE", "/api/flows/"+flow+"/steps/"+step+"?mode="+mode, nil) },
			setEdge: func(flow, from, to string, props map[string]any) {
				rest("PUT", "/api/flows/"+flow+"/edges/"+from+"/"+to, props)
			},
			update: func(flow, step string, fields map[string]any) {
				rest("PATCH", "/api/flows/"+flow+"/steps/"+step, fields)
			},
		},
		"MCP": {
			create: func(name string) string { return idOf(t, mcp("flows_create", map[string]any{"name": name})) },
			add: func(flow, feature string, place map[string]any) string {
				args := map[string]any{"flow_id": flow, "project_slug": testProject, "feature_id": feature}
				for k, v := range place {
					if k == "edge" {
						mcpEdge(args, v.(map[string]any))
						continue
					}
					args[k] = v
				}
				return idOf(t, mcp("flows_add_step", args))
			},
			move: func(flow, step string, place map[string]any) {
				args := map[string]any{"flow_id": flow, "step_id": step}
				for k, v := range place {
					switch k {
					case "dir":
						args["direction"] = v
					case "edge":
						mcpEdge(args, v.(map[string]any))
					default:
						args[k] = v
					}
				}
				mcp("flows_move_step", args)
			},
			remove: func(flow, step, mode string) {
				mcp("flows_remove_step", map[string]any{"flow_id": flow, "step_id": step, "mode": mode})
			},
			setEdge: func(flow, from, to string, props map[string]any) {
				mcp("flows_set_edge", mcpEdge(map[string]any{"flow_id": flow, "from_step_id": from, "to_step_id": to}, props))
			},
			update: func(flow, step string, fields map[string]any) {
				mcp("flows_update_step", with(map[string]any{"flow_id": flow, "step_id": step}, fields))
			},
		},
		"CLI": {
			create: func(name string) string { return idOf(t, cli("flows", "create", "--name", name)) },
			add: func(flow, feature string, place map[string]any) string {
				args := []string{"flows", "add-step", flow, "--project", testProject, "--feature", feature}
				for k, v := range place {
					if k == "edge" {
						args = append(args, cliEdge(v.(map[string]any))...)
						continue
					}
					args = append(args, "--"+k, v.(string))
				}
				return idOf(t, cli(args...))
			},
			move: func(flow, step string, place map[string]any) {
				args := []string{"flows", "move-step", flow, step}
				for k, v := range place {
					switch k {
					case "dir":
						if v.(int) < 0 {
							args = append(args, "up")
						} else {
							args = append(args, "down")
						}
					case "edge":
						args = append(args, cliEdge(v.(map[string]any))...)
					default:
						args = append(args, "--"+k, v.(string))
					}
				}
				cli(args...)
			},
			remove: func(flow, step, mode string) { cli("flows", "remove-step", flow, step, "--mode", mode) },
			setEdge: func(flow, from, to string, props map[string]any) {
				cli(append([]string{"flows", "set-edge", flow, from, to}, cliEdge(props)...)...)
			},
			update: func(flow, step string, fields map[string]any) {
				args := []string{"flows", "update-step", flow, step}
				for k, v := range fields {
					switch k {
					case "controls":
						args = append(args, "--controls", strings.Join(v.([]string), ","))
					default:
						args = append(args, "--"+k, v.(string))
					}
				}
				cli(args...)
			},
		},
	}

	exports := map[string]string{}
	for name, ops := range surfaces {
		f := ops.create("journey via " + name)
		a := ops.add(f, "a", nil)
		b := ops.add(f, "b", nil)
		c := ops.add(f, "c", nil)
		x := ops.add(f, "x", map[string]any{"after": a, "edge": map[string]any{"kind": "call", "auth": "user", "trustBoundary": true}})
		z := ops.add(f, "z", map[string]any{"from": a, "edge": map[string]any{"condition": "if admin"}})
		ops.move(f, c, map[string]any{"dir": -1})
		ops.remove(f, x, "splice")
		ops.setEdge(f, c, b, map[string]any{"kind": "async", "protocol": "kafka", "tainted": true, "tags": []string{"pii"}})
		ops.update(f, b, map[string]any{"actor": "admin", "controls": []string{"authz:rbac"}})
		ops.move(f, z, map[string]any{"from": c, "edge": map[string]any{"condition": "retry"}})
		exports[name] = normalizedExport(t, rest("GET", "/api/flows/"+f+"/export", nil))
	}
	want := exports["REST"]
	for name, got := range exports {
		if got != want {
			t.Errorf("%s built a different flow:\n got  %s\n want %s", name, got, want)
		}
	}
	// And the script did what it says.
	for _, part := range []string{`"a>c"`, `"c>b async kafka tainted [pii]"`, `"c>z retry"`, `"b admin [authz:rbac]"`} {
		if !strings.Contains(want, part) {
			t.Errorf("export %s lacks %s", want, part)
		}
	}
}

// normalizedExport renders an export with steps named by feature (ids differ per flow).
func normalizedExport(t *testing.T, raw string) string {
	t.Helper()
	var doc struct {
		Steps []struct {
			ClientID, FeatureID, Actor string
			Controls                   []string
		}
		Edges []struct {
			From, To, Kind, Protocol, Condition, Auth string
			TrustBoundary, Tainted                    bool
			Tags                                      []string
		}
	}
	if err := json.Unmarshal([]byte(raw), &doc); err != nil {
		t.Fatalf("export: %v", err)
	}
	name := map[string]string{}
	var parts []string
	for _, s := range doc.Steps {
		name[s.ClientID] = s.FeatureID
		desc := s.FeatureID
		if s.Actor != "" || len(s.Controls) > 0 {
			desc += " " + s.Actor + " [" + strings.Join(s.Controls, ",") + "]"
		}
		parts = append(parts, desc)
	}
	for _, e := range doc.Edges {
		desc := name[e.From] + ">" + name[e.To]
		for _, f := range []string{e.Kind, e.Protocol, e.Condition, e.Auth} {
			if f != "" && f != "next" {
				desc += " " + f
			}
		}
		if e.TrustBoundary {
			desc += " boundary"
		}
		if e.Tainted {
			desc += " tainted"
		}
		if len(e.Tags) > 0 {
			desc += " [" + strings.Join(e.Tags, ",") + "]"
		}
		parts = append(parts, desc)
	}
	return `"` + strings.Join(parts, `" "`) + `"`
}
