package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"text/tabwriter"
)

// projects + baselines-all: multi-project server administration.

func init() {
	mpCommands = append(mpCommands,
		mpCmd{Group: "projects", Name: "list", Desc: "List all projects with finding and comment stats.",
			Flags: []flagDef{
				{Name: "json", Desc: "Print the raw JSON response instead of a table", Type: "bool"},
			},
			Run: projectList},
		mpCmd{Group: "projects", Name: "create", Desc: "Register a git repository as a new project. The slug is derived from the name.",
			Flags: []flagDef{
				{Name: "name", Desc: "Project name", Required: true},
				{Name: "repo-path", Desc: "Path to the git repository on the server", Required: true},
			},
			Run: projectCreate},
		mpCmd{Group: "projects", Name: "update", Desc: "Rename a project or point it at a different repository path.",
			Args: []string{"slug"},
			Flags: []flagDef{
				{Name: "slug", Desc: "Project slug", Required: true},
				{Name: "name", Desc: "New project name"},
				{Name: "repo-path", Desc: "New repository path"},
			},
			Run: projectUpdate},
		mpCmd{Group: "projects", Name: "delete", Desc: "Remove a project from the server. The repository itself is not touched.",
			Args: []string{"slug"},
			Flags: []flagDef{
				{Name: "slug", Desc: "Project slug", Required: true},
			},
			Run: projectDelete},

		mpCmd{Group: "baselines-all", Name: "list", Desc: "List baselines across every project: up to 50 per project, newest first within each project, each tagged with projectSlug.",
			Run: func(c *cli, _ *mpInput) error { return c.emit("GET", "/api/baselines", nil) }},
	)
}

func projectList(c *cli, in *mpInput) error {
	data, status, err := c.req("GET", "/api/projects", nil)
	if err != nil {
		return err
	}
	if in.flag("json") {
		fmt.Fprintln(c.stdout, formatOutput(data, status))
		return nil
	}
	var projects []struct {
		Name     string `json:"name"`
		Slug     string `json:"slug"`
		RepoPath string `json:"repoPath"`
		Stats    *struct {
			FindingsTotal int `json:"findingsTotal"`
			FindingsOpen  int `json:"findingsOpen"`
			CommentsTotal int `json:"commentsTotal"`
			CommentsOpen  int `json:"commentsOpen"`
		} `json:"stats"`
	}
	if err := json.Unmarshal(data, &projects); err != nil {
		return fmt.Errorf("decoding response: %v", err)
	}
	if len(projects) == 0 {
		fmt.Fprintln(c.stdout, "No projects.")
		return nil
	}
	tw := tabwriter.NewWriter(c.stdout, 2, 4, 3, ' ', 0)
	fmt.Fprintf(tw, "SLUG\tNAME\tFINDINGS\tCOMMENTS\tPATH\n")
	for _, p := range projects {
		findings, comments := "-", "-"
		if p.Stats != nil {
			findings = fmt.Sprintf("%d (%d open)", p.Stats.FindingsTotal, p.Stats.FindingsOpen)
			comments = fmt.Sprintf("%d (%d open)", p.Stats.CommentsTotal, p.Stats.CommentsOpen)
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", p.Slug, p.Name, findings, comments, p.RepoPath)
	}
	return tw.Flush()
}

func projectCreate(c *cli, in *mpInput) error {
	data, _, err := c.req("POST", "/api/projects", map[string]string{"name": in.str("name"), "repoPath": in.str("repo-path")})
	if err != nil {
		return err
	}
	var proj struct {
		Slug string `json:"slug"`
		Name string `json:"name"`
	}
	_ = json.Unmarshal(data, &proj)
	fmt.Fprintf(c.stdout, "Created project %q (slug: %s)\n", proj.Name, proj.Slug)
	return nil
}

func projectUpdate(c *cli, in *mpInput) error {
	obj := map[string]string{}
	if v := in.str("name"); v != "" {
		obj["name"] = v
	}
	if v := in.str("repo-path"); v != "" {
		obj["repoPath"] = v
	}
	if len(obj) == 0 {
		return errors.New("at least one of --name or --repo-path must be provided")
	}
	if _, _, err := c.req("PATCH", "/api/projects/"+url.PathEscape(in.str("slug")), obj); err != nil {
		return err
	}
	fmt.Fprintf(c.stdout, "Updated project %q\n", in.str("slug"))
	return nil
}

func projectDelete(c *cli, in *mpInput) error {
	if _, _, err := c.req("DELETE", "/api/projects/"+url.PathEscape(in.str("slug")), nil); err != nil {
		return err
	}
	fmt.Fprintf(c.stdout, "Deleted project %q\n", in.str("slug"))
	return nil
}
