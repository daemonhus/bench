package main

import (
	"errors"
	"net/url"
	"strings"
)

// catalog: the cross-project feature catalog (what flow steps point at).

func init() {
	mpCommands = append(mpCommands,
		mpCmd{Group: "catalog", Name: "search", Desc: "Search features across all projects by title, operation or tag. Results include each feature's projectSlug, for use with flows add-step.",
			Args: []string{"query"},
			Flags: []flagDef{
				{Name: "query", Desc: "Case-insensitive text to match against title, operation and tags (default: all features)"},
				{Name: "kind", Desc: "Filter by kind [interface|source|sink|dependency|externality]"},
				{Name: "projects", Desc: "Comma-separated project slugs to search (default: all projects)", Type: "list"},
				{Name: "limit", Desc: "Maximum results (default: 50, max: 200)", Type: "int"},
			},
			Run: func(c *cli, in *mpInput) error {
				if err := checkEnum(in, "kind", false, "interface", "source", "sink", "dependency", "externality"); err != nil {
					return err
				}
				q := url.Values{}
				if v := in.str("query"); v != "" {
					q.Set("q", v)
				}
				if v := in.str("kind"); v != "" {
					q.Set("kind", v)
				}
				addRepeated(q, "project", in.list("projects"))
				if v := in.str("limit"); v != "" {
					q.Set("limit", v)
				}
				return c.emit("GET", withQuery("/api/features/search", q), nil)
			}},
		mpCmd{Group: "catalog", Name: "get", Desc: "Fetch features by project-qualified reference (slug:feature-id). Missing features come back with tombstoned=true.",
			Args:     []string{"refs"},
			Variadic: true,
			Flags: []flagDef{
				{Name: "refs", Desc: "Comma-separated slug:feature-id references (or pass them as arguments)", Type: "list", Required: true},
			},
			Run: func(c *cli, in *mpInput) error {
				refs := in.list("refs")
				for _, r := range refs {
					if slug, id, ok := strings.Cut(r, ":"); !ok || slug == "" || id == "" {
						return errors.New("reference " + r + " is not of the form slug:feature-id")
					}
				}
				return c.emit("GET", withQuery("/api/features", url.Values{"refs": {strings.Join(refs, ",")}}), nil)
			}},
	)
}
