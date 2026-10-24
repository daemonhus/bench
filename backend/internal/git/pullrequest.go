package git

import (
	"regexp"
	"strconv"
	"strings"

	"bench/internal/model"
)

// What git records of a pull or merge request, read from the commit that landed it:
//   - a GitHub merge: "Merge pull request #12 from owner/branch", the PR title as the body;
//   - a GitLab merge: "Merge branch 'branch' into 'main'", the MR title in the body, and
//     "See merge request group/project!12";
//   - a squash merge: "Title (#12)", the PR collapsed into one commit (GitHub's default).
var (
	githubMergeRe = regexp.MustCompile(`^Merge pull request #(\d+) from (\S+)`)
	gitlabMergeRe = regexp.MustCompile(`^Merge branch '([^']+)' into '[^']+'`)
	gitlabRefRe   = regexp.MustCompile(`(?m)^See merge request \S+!(\d+)\s*$`)
	squashRe      = regexp.MustCompile(`^(.+) \(#(\d+)\)$`)
)

// parsePullRequest reads the pull or merge request a commit message lands, or nil. webURL is
// the repository's browsable address ("" when unknown), for the request's link.
func parsePullRequest(message, webURL string) *model.PullRequest {
	subject, body, _ := strings.Cut(strings.TrimSpace(message), "\n")
	subject = strings.TrimSpace(subject)
	var pr *model.PullRequest
	if m := githubMergeRe.FindStringSubmatch(subject); m != nil {
		n, _ := strconv.Atoi(m[1])
		branch := m[2]
		if _, b, ok := strings.Cut(branch, "/"); ok { // owner/branch
			branch = b
		}
		pr = &model.PullRequest{Kind: "pull", Number: n, Branch: branch, Title: firstLine(body)}
	} else if m := gitlabMergeRe.FindStringSubmatch(subject); m != nil {
		ref := gitlabRefRe.FindStringSubmatch(body)
		if ref == nil {
			return nil // a plain local merge
		}
		n, _ := strconv.Atoi(ref[1])
		title := firstLine(body)
		if strings.HasPrefix(title, "See merge request") {
			title = ""
		}
		pr = &model.PullRequest{Kind: "merge", Number: n, Branch: m[1], Title: title}
	} else if m := squashRe.FindStringSubmatch(subject); m != nil {
		n, _ := strconv.Atoi(m[2])
		pr = &model.PullRequest{Kind: "pull", Number: n, Title: m[1], Squashed: true}
	} else {
		return nil
	}
	if webURL != "" {
		if pr.Kind == "merge" {
			pr.URL = webURL + "/-/merge_requests/" + strconv.Itoa(pr.Number)
		} else {
			pr.URL = webURL + "/pull/" + strconv.Itoa(pr.Number)
		}
	}
	return pr
}

// firstLine is the first non-blank line of s.
func firstLine(s string) string {
	for _, l := range strings.Split(s, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			return l
		}
	}
	return ""
}

var (
	scpRemoteRe = regexp.MustCompile(`^[\w.-]+@([^:/]+):(.+?)(?:\.git)?/?$`)
	urlRemoteRe = regexp.MustCompile(`^(?:https?|ssh|git)://(?:[^@/]+@)?([^/:]+)(?::\d+)?/(.+?)(?:\.git)?/?$`)
)

// webURL turns a git remote (SSH or HTTPS) into the repository's https address, or "". An SSH
// host alias such as "github-work" (a ~/.ssh/config entry) is read as github.com or gitlab.com.
func webURL(remote string) string {
	m := scpRemoteRe.FindStringSubmatch(remote)
	if m == nil {
		m = urlRemoteRe.FindStringSubmatch(remote)
	}
	if m == nil {
		return ""
	}
	host := m[1]
	if !strings.Contains(host, ".") {
		switch {
		case strings.HasPrefix(host, "github"):
			host = "github.com"
		case strings.HasPrefix(host, "gitlab"):
			host = "gitlab.com"
		default:
			return ""
		}
	}
	return "https://" + host + "/" + m[2]
}
