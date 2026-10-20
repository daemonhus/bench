package main

// Multi-project commands. These talk to a multi-project server's
// /api/* API (projects, cross-project baselines, flows, flow folders,
// saved flow views, the cross-project feature catalog). They are not routed
// through --project; a few use it as a default value (e.g. flows add-step).
//
// Unlike the declarative per-project command table, each multi-project
// command has a Run function: several of them resolve names to IDs, render
// tables, or do client-side dry-runs. Parsing still uses the shared flagDef /
// parseFlags machinery so flag syntax is identical. Commands also accept
// their identifying values positionally (e.g. `bench flows get <id>` is the
// same as `bench flows get --id <id>`), in the order given by Args.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"sort"
	"strings"
	"text/tabwriter"
)

// cli carries per-invocation state for multi-project commands.
type cli struct {
	client  *apiClient
	project string // global --project / BENCH_PROJECT
	stdout  io.Writer
	stderr  io.Writer
	stdin   io.Reader // nil → os.Stdin
}

// mpGroup is a multi-project category ("projects") or sub-group ("flows folders").
type mpGroup struct {
	Parent  string   // "" for a top-level category, else the parent group's Name
	Name    string   //
	Aliases []string // alternative names
	Desc    string
	Note    string // extra help text shown under the group's command list
	Default string // command to run when the group is invoked with no arguments
}

// mpCmd is one multi-project command.
type mpCmd struct {
	Group    string   // group path, e.g. "flows" or "flows folders"
	Name     string   //
	Args     []string // flag names that positional arguments fill, in order
	Variadic bool     // the last Arg collects all remaining positionals (comma-joined, list flag)
	Desc     string
	Flags    []flagDef
	Run      func(c *cli, in *mpInput) error
}

var mpGroups = []mpGroup{
	{Name: "projects", Desc: "Projects: list, register, update, remove repositories under review"},
	{Name: "baselines-all", Desc: "Recent baselines across every project", Default: "list"},
	{Name: "flows", Desc: "Flows: cross-project feature walkthroughs - steps, links, baselines, folders, views"},
	{Parent: "flows", Name: "folders", Desc: "Flow folders: organise flows into nested folders",
		Note: "A <folder> is a folder id or a path of names (auth/login); / or root is the top level.\nRelated: flows list --folder, flows create --folder, flows move <flow-id>... --folder <folder>"},
	{Parent: "flows", Name: "baseline", Aliases: []string{"baselines"}, Desc: "Flow baselines: snapshot a flow's state and compare against it later",
		Note: "Related: flows delta, flows findings"},
	{Parent: "flows", Name: "views", Desc: "Saved flow views: named, optionally shared, flow list queries"},
	{Name: "catalog", Desc: "Cross-project feature catalog: search features across all projects"},
}

// groupPath returns the full path ("flows folders") of a group.
func (g *mpGroup) path() string {
	if g.Parent == "" {
		return g.Name
	}
	return g.Parent + " " + g.Name
}

func findGroup(parent, name string) *mpGroup {
	for i := range mpGroups {
		g := &mpGroups[i]
		if g.Parent != parent {
			continue
		}
		if g.Name == name {
			return g
		}
		for _, a := range g.Aliases {
			if a == name {
				return g
			}
		}
	}
	return nil
}

func findMPCmd(group, name string) *mpCmd {
	for i := range mpCommands {
		if mpCommands[i].Group == group && mpCommands[i].Name == name {
			return &mpCommands[i]
		}
	}
	return nil
}

// mpCommands is populated by init functions in projects.go, flows.go,
// folders.go and catalog.go.
var mpCommands []mpCmd

func isHelpArg(a string) bool { return a == "--help" || a == "-h" || a == "help" }

// runGroup dispatches args (everything after the group name) within g.
func (c *cli) runGroup(g *mpGroup, args []string) int {
	if len(args) == 0 {
		if g.Default != "" {
			args = []string{g.Default}
		} else {
			c.printGroupHelp(g)
			return 0
		}
	}
	if isHelpArg(args[0]) {
		c.printGroupHelp(g)
		return 0
	}
	if sub := findGroup(g.Name, args[0]); sub != nil && g.Parent == "" {
		return c.runGroup(sub, args[1:])
	}
	cmd := findMPCmd(g.path(), args[0])
	if cmd == nil {
		fmt.Fprintf(c.stderr, "Error: unknown command %q in %q\n\n", args[0], g.path())
		c.printGroupHelp(g)
		return 1
	}
	rest := args[1:]
	for _, a := range rest {
		if a == "--help" || a == "-h" {
			c.printMPCommandHelp(cmd)
			return 0
		}
	}
	pf, err := parseMPArgs(cmd, rest)
	if err != nil {
		fmt.Fprintf(c.stderr, "Error: %v\n\n", err)
		c.printMPCommandHelp(cmd)
		return 1
	}
	if err := cmd.Run(c, &mpInput{pf: pf}); err != nil {
		msg := err.Error()
		// API errors are already formatted ("Error: ..." or "Error (HTTP 400): ...").
		if !strings.HasPrefix(msg, "Error") {
			msg = "Error: " + msg
		}
		fmt.Fprintln(c.stderr, msg)
		return 1
	}
	return 0
}

// parseMPArgs separates positional arguments from flags, parses the flags
// with the shared parseFlags, then assigns positionals to cmd.Args.
func parseMPArgs(cmd *mpCmd, args []string) (*parsedFlags, error) {
	byName := make(map[string]*flagDef)
	for i := range cmd.Flags {
		byName[cmd.Flags[i].Name] = &cmd.Flags[i]
	}
	var flagArgs, pos []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		if !strings.HasPrefix(a, "--") || a == "--" {
			pos = append(pos, a)
			continue
		}
		name, _, hasEq := strings.Cut(a[2:], "=")
		def, ok := byName[name]
		if !ok {
			return nil, fmt.Errorf("unknown flag: --%s", name)
		}
		flagArgs = append(flagArgs, a)
		if !hasEq && def.Type != "bool" && def.Type != "bool-false" {
			if i+1 >= len(args) {
				return nil, fmt.Errorf("flag --%s requires a value", name)
			}
			i++
			flagArgs = append(flagArgs, args[i])
		}
	}

	// Parse without required checks; positionals may still satisfy them.
	optional := make([]flagDef, len(cmd.Flags))
	copy(optional, cmd.Flags)
	for i := range optional {
		optional[i].Required = false
	}
	pf, err := parseFlags(optional, flagArgs)
	if err != nil {
		return nil, err
	}

	for i, p := range pos {
		if cmd.Variadic && len(cmd.Args) > 0 && i >= len(cmd.Args)-1 {
			last := cmd.Args[len(cmd.Args)-1]
			if prev, ok := pf.values[last]; ok && prev != "" {
				pf.values[last] = prev + "," + p
			} else {
				pf.values[last] = p
			}
			continue
		}
		if i >= len(cmd.Args) {
			return nil, fmt.Errorf("unexpected argument: %s", p)
		}
		name := cmd.Args[i]
		if _, dup := pf.values[name]; dup {
			return nil, fmt.Errorf("<%s> given both as an argument and as --%s", name, name)
		}
		pf.values[name] = p
	}

	var missing []string
	for _, d := range cmd.Flags {
		if !d.Required {
			continue
		}
		if v, ok := pf.values[d.Name]; !ok || v == "" {
			if !pf.bools[d.Name] {
				missing = append(missing, "--"+d.Name)
			}
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		return nil, fmt.Errorf("missing required flag(s): %s", strings.Join(missing, ", "))
	}
	return pf, nil
}

// mpInput gives Run functions typed access to parsed flags.
type mpInput struct{ pf *parsedFlags }

func (in *mpInput) str(name string) string { return in.pf.values[name] }

func (in *mpInput) has(name string) bool {
	_, ok := in.pf.values[name]
	return ok || in.pf.bools[name]
}

func (in *mpInput) flag(name string) bool {
	return in.pf.bools[name] || in.pf.values[name] == "true"
}

// list splits a comma-separated flag value, trimming blanks. A flag that
// was not given yields nil; one given as "" yields an empty, non-nil slice.
func (in *mpInput) list(name string) []string {
	v, ok := in.pf.values[name]
	if !ok {
		return nil
	}
	out := []string{}
	for _, p := range strings.Split(v, ",") {
		if s := strings.TrimSpace(p); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

// apiError is a >=400 response, already formatted for display.
type apiError struct{ msg string }

func (e *apiError) Error() string { return e.msg }

// req performs a request against the multi-project API. body is JSON-encoded
// unless it is a []byte (sent verbatim) or nil (no body).
func (c *cli) req(method, path string, body any) ([]byte, int, error) {
	var r io.Reader
	switch b := body.(type) {
	case nil:
	case []byte:
		r = bytes.NewReader(b)
	default:
		enc, err := json.Marshal(b)
		if err != nil {
			return nil, 0, err
		}
		r = bytes.NewReader(enc)
	}
	data, status, err := c.client.do(method, path, r)
	if err != nil {
		return nil, 0, fmt.Errorf("%v\n\nIs the multi-project server running? Start it with ./platform/dev.sh, or pass --url.", err)
	}
	if status >= 400 {
		msg := formatOutput(data, status)
		return data, status, &apiError{msg}
	}
	return data, status, nil
}

// emit performs a request and pretty-prints the response to stdout.
func (c *cli) emit(method, path string, body any) error {
	data, status, err := c.req(method, path, body)
	if err != nil {
		return err
	}
	fmt.Fprintln(c.stdout, formatOutput(data, status))
	return nil
}

// withQuery appends q to path when non-empty.
func withQuery(path string, q url.Values) string {
	if len(q) == 0 {
		return path
	}
	return path + "?" + q.Encode()
}

// readInput returns the contents of the --input file, or stdin when piped.
func (c *cli) readInput(file string) ([]byte, error) {
	if file != "" {
		return os.ReadFile(file)
	}
	in := c.stdin
	if in == nil {
		if stat, err := os.Stdin.Stat(); err == nil && stat.Mode()&os.ModeCharDevice != 0 {
			return nil, errors.New("requires JSON input via --input <file> or a stdin pipe")
		}
		in = os.Stdin
	}
	return io.ReadAll(in)
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

func (c *cli) printGroupHelp(g *mpGroup) {
	w := c.stderr
	fmt.Fprintf(w, "bench %s - %s\n\n", g.path(), strings.ToLower(g.Desc[:1])+g.Desc[1:])
	fmt.Fprintln(w, "Requires a multi-project server.")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "Commands:")
	tw := tabwriter.NewWriter(w, 2, 4, 3, ' ', 0)
	for _, cmd := range mpCommands {
		if cmd.Group == g.path() {
			fmt.Fprintf(tw, "  %s\t%s\n", strings.TrimSpace(cmd.Name+" "+argUsage(&cmd)), firstSentence(cmd.Desc))
		}
	}
	if g.Parent == "" {
		for _, sub := range mpGroups {
			if sub.Parent == g.Name {
				fmt.Fprintf(tw, "  %s ...\t%s\n", sub.Name, strings.ToLower(sub.Desc[:1])+sub.Desc[1:])
			}
		}
	}
	tw.Flush()
	if g.Note != "" {
		fmt.Fprintln(w)
		fmt.Fprintln(w, g.Note)
	}
	fmt.Fprintln(w)
	fmt.Fprintf(w, "Run 'bench %s <command> --help' for details on a command.\n", g.path())
}

func argUsage(cmd *mpCmd) string {
	var parts []string
	for i, a := range cmd.Args {
		s := "<" + a + ">"
		if cmd.Variadic && i == len(cmd.Args)-1 {
			s += "..."
		}
		for _, f := range cmd.Flags {
			if f.Name == a && !f.Required {
				s = "[" + s + "]"
			}
		}
		parts = append(parts, s)
	}
	return strings.Join(parts, " ")
}

func (c *cli) printMPCommandHelp(cmd *mpCmd) {
	w := c.stderr
	fmt.Fprintf(w, "bench %s %s - %s\n\n", cmd.Group, cmd.Name, cmd.Desc)
	fmt.Fprintf(w, "Usage:\n  bench %s %s\n", cmd.Group, strings.Join(strings.Fields(cmd.Name+" "+argUsage(cmd)+" [flags]"), " "))
	if len(cmd.Args) > 0 {
		fmt.Fprintf(w, "\nPositional arguments are shorthand for the flags of the same name (")
		for i, a := range cmd.Args {
			if i > 0 {
				fmt.Fprint(w, ", ")
			}
			fmt.Fprintf(w, "<%s> = --%s", a, a)
		}
		fmt.Fprintln(w, ").")
	}
	fmt.Fprintln(w, "Requires a multi-project server.")
	if len(cmd.Flags) == 0 {
		return
	}
	fmt.Fprintln(w)
	fmt.Fprintln(w, "Flags:")
	tw := tabwriter.NewWriter(w, 2, 4, 3, ' ', 0)
	sorted := make([]flagDef, len(cmd.Flags))
	copy(sorted, cmd.Flags)
	sort.SliceStable(sorted, func(i, j int) bool {
		if sorted[i].Required != sorted[j].Required {
			return sorted[i].Required
		}
		return sorted[i].Name < sorted[j].Name
	})
	for _, f := range sorted {
		hint := " string"
		switch f.Type {
		case "int":
			hint = " int"
		case "list":
			hint = " list"
		case "bool", "bool-false":
			hint = ""
		case "file":
			hint = " file"
		}
		desc := f.Desc
		if f.Required {
			desc += " (required)"
		}
		fmt.Fprintf(tw, "      --%s%s\t%s\n", f.Name, hint, desc)
	}
	tw.Flush()
}
