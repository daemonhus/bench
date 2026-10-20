package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strings"
)

// Flow folders. Everywhere a folder is expected the CLI takes either a folder
// id or a path of folder names ("auth/login"); "/" or "root" is the top level.

type cliFolder struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	ParentID    string `json:"parentId,omitempty"`
	FlowCount   int    `json:"flowCount"`
	FolderCount int    `json:"folderCount"`
	Path        string `json:"path"`
}

func init() {
	mpCommands = append(mpCommands,
		mpCmd{Group: "flows folders", Name: "list", Desc: "List folders with their paths and counts (JSON, or an indented tree with --tree).",
			Flags: []flagDef{{Name: "tree", Desc: "Print an indented tree instead of JSON", Type: "bool"}},
			Run:   folderList},
		mpCmd{Group: "flows folders", Name: "create", Desc: "Create a folder from a path; missing parents in the path are created too.",
			Args:  []string{"path"},
			Flags: []flagDef{{Name: "path", Desc: "Folder path, e.g. auth/login", Required: true}},
			Run:   folderCreate},
		mpCmd{Group: "flows folders", Name: "rename", Desc: "Rename a folder.",
			Args: []string{"folder", "name"},
			Flags: []flagDef{
				{Name: "folder", Desc: "Folder id or path", Required: true},
				{Name: "name", Desc: "New name", Required: true},
			},
			Run: folderRename},
		mpCmd{Group: "flows folders", Name: "move", Desc: "Move a folder (and everything in it) under another folder.",
			Args: []string{"folder", "to"},
			Flags: []flagDef{
				{Name: "folder", Desc: "Folder id or path to move", Required: true},
				{Name: "to", Desc: "Target parent folder id or path (/ for the top level)", Required: true},
			},
			Run: folderMove},
		mpCmd{Group: "flows folders", Name: "delete", Desc: "Delete a folder, its subfolders and ALL flows in them. Shows a preview by default; pass --confirm to actually delete.",
			Args: []string{"folder"},
			Flags: []flagDef{
				{Name: "folder", Desc: "Folder id or path", Required: true},
				{Name: "confirm", Desc: "Actually delete (default: preview only)", Type: "bool"},
			},
			Run: folderDelete},
		mpCmd{Group: "flows", Name: "move", Desc: "Move one or more flows into a folder.",
			Args:     []string{"ids"},
			Variadic: true,
			Flags: []flagDef{
				{Name: "ids", Desc: "Comma-separated flow IDs (or pass them as arguments)", Type: "list", Required: true},
				{Name: "folder", Desc: "Target folder id or path (/ for the top level)", Required: true},
			},
			Run: flowMove},
	)
}

// fetchFolders returns every folder with its path filled in, sorted by path.
func (c *cli) fetchFolders() ([]cliFolder, error) {
	data, _, err := c.req("GET", "/api/flow-folders", nil)
	if err != nil {
		return nil, err
	}
	var folders []cliFolder
	if err := json.Unmarshal(data, &folders); err != nil {
		return nil, fmt.Errorf("decode folders: %v", err)
	}
	byID := map[string]*cliFolder{}
	for i := range folders {
		byID[folders[i].ID] = &folders[i]
	}
	var pathOf func(f *cliFolder, depth int) string
	pathOf = func(f *cliFolder, depth int) string {
		if f.ParentID == "" || depth > 64 {
			return f.Name
		}
		if parent, ok := byID[f.ParentID]; ok {
			return pathOf(parent, depth+1) + "/" + f.Name
		}
		return f.Name
	}
	for i := range folders {
		folders[i].Path = pathOf(&folders[i], 0)
	}
	sort.Slice(folders, func(i, j int) bool { return strings.ToLower(folders[i].Path) < strings.ToLower(folders[j].Path) })
	return folders, nil
}

// lookupFolder turns an id or a name path into a folder id ("" = top level).
func lookupFolder(folders []cliFolder, ref string) (string, bool) {
	ref = strings.TrimSpace(ref)
	if ref == "" || ref == "/" || strings.EqualFold(ref, "root") {
		return "", true
	}
	for _, f := range folders {
		if f.ID == ref {
			return f.ID, true
		}
	}
	want := strings.ToLower(strings.Trim(ref, "/"))
	for _, f := range folders {
		if strings.ToLower(f.Path) == want {
			return f.ID, true
		}
	}
	return "", false
}

func resolveFolder(folders []cliFolder, ref string) (string, error) {
	id, ok := lookupFolder(folders, ref)
	if !ok {
		return "", fmt.Errorf("no folder %q (see 'bench flows folders list')", ref)
	}
	return id, nil
}

// resolveFolderRef fetches folders and resolves ref; the top level ("/",
// "root", "") resolves to "" without a request.
func (c *cli) resolveFolderRef(ref string) (string, error) {
	if id, ok := lookupFolder(nil, ref); ok {
		return id, nil
	}
	folders, err := c.fetchFolders()
	if err != nil {
		return "", err
	}
	return resolveFolder(folders, ref)
}

func folderList(c *cli, in *mpInput) error {
	folders, err := c.fetchFolders()
	if err != nil {
		return err
	}
	if !in.flag("tree") {
		if folders == nil {
			folders = []cliFolder{}
		}
		out, _ := json.Marshal(folders)
		fmt.Fprintln(c.stdout, formatOutput(out, 200))
		return nil
	}
	if len(folders) == 0 {
		fmt.Fprintln(c.stdout, "(no folders)")
		return nil
	}
	for _, f := range folders {
		depth := strings.Count(f.Path, "/")
		fmt.Fprintf(c.stdout, "%s%s/  (%d flows)  %s\n", strings.Repeat("  ", depth), f.Name, f.FlowCount, f.ID)
	}
	return nil
}

func folderCreate(c *cli, in *mpInput) error {
	path := in.str("path")
	folders, err := c.fetchFolders()
	if err != nil {
		return err
	}
	// Validate the whole path before creating anything, so a bad segment
	// late in the path doesn't leave its parents behind.
	parts := strings.Split(strings.Trim(path, "/"), "/")
	for i, part := range parts {
		parts[i] = strings.TrimSpace(part)
		if parts[i] == "" {
			return fmt.Errorf("empty folder name in %q", path)
		}
	}
	parent, soFar := "", ""
	var created []byte
	for _, part := range parts {
		if soFar != "" {
			soFar += "/"
		}
		soFar += part
		if id, ok := lookupFolder(folders, soFar); ok {
			parent = id
			continue
		}
		created, _, err = c.req("POST", "/api/flow-folders", map[string]any{"name": part, "parentId": parent})
		if err != nil {
			return err
		}
		var f cliFolder
		_ = json.Unmarshal(created, &f)
		f.Path = soFar
		folders = append(folders, f)
		parent = f.ID
	}
	if created == nil {
		return fmt.Errorf("folder %q already exists", path)
	}
	fmt.Fprintln(c.stdout, formatOutput(created, 201))
	return nil
}

func folderRename(c *cli, in *mpInput) error {
	id, err := c.resolveFolderRef(in.str("folder"))
	if err != nil {
		return err
	}
	if id == "" {
		return errors.New("the top level cannot be renamed")
	}
	return c.emit("PATCH", "/api/flow-folders/"+url.PathEscape(id), map[string]any{"name": in.str("name")})
}

func folderMove(c *cli, in *mpInput) error {
	folders, err := c.fetchFolders()
	if err != nil {
		return err
	}
	id, err := resolveFolder(folders, in.str("folder"))
	if err != nil {
		return err
	}
	if id == "" {
		return errors.New("the top level cannot be moved")
	}
	target, err := resolveFolder(folders, in.str("to"))
	if err != nil {
		return err
	}
	return c.emit("POST", "/api/flows/move", map[string]any{"folderIds": []string{id}, "targetFolderId": target})
}

func folderDelete(c *cli, in *mpInput) error {
	folders, err := c.fetchFolders()
	if err != nil {
		return err
	}
	id, err := resolveFolder(folders, in.str("folder"))
	if err != nil {
		return err
	}
	if id == "" {
		return errors.New("the top level cannot be deleted")
	}
	path := "/api/flow-folders/" + url.PathEscape(id)
	if in.flag("confirm") {
		return c.emit("DELETE", path+"?confirm=true", nil)
	}
	data, _, err := c.req("DELETE", path, nil)
	if err != nil {
		return err
	}
	var preview struct {
		Folders int `json:"folders"`
		Flows   int `json:"flows"`
	}
	_ = json.Unmarshal(data, &preview)
	name := in.str("folder")
	for _, f := range folders {
		if f.ID == id {
			name = f.Path
		}
	}
	fmt.Fprintf(c.stdout, "Dry run - deleting folder %q would permanently remove %d folder(s) and %d flow(s).\n\nPass --confirm to delete.\n", name, preview.Folders, preview.Flows)
	return nil
}

func flowMove(c *cli, in *mpInput) error {
	ids := in.list("ids")
	if len(ids) == 0 {
		return errors.New("no flow IDs given")
	}
	target, err := c.resolveFolderRef(in.str("folder"))
	if err != nil {
		return err
	}
	return c.emit("POST", "/api/flows/move", map[string]any{"flowIds": ids, "targetFolderId": target})
}
