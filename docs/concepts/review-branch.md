# Review branch

Each project is reviewed on one branch: its **review branch**. Browse, Changes, Findings, Features and the Overview look at the project as it stands on that branch, and so do the CLI and MCP tools. It starts as the repo's default branch (`main` or `master`, from `origin/HEAD` when there is one), whatever happens to be checked out.

## Choosing it

The branch chip beside the project name, top left, shows the review branch. Open it to pick another local branch: the choice is saved for the project, so everyone working on it (and every agent) follows. The pages start again on the new branch. Picking the default branch saves "the default", so the project follows the default branch if it changes.

```bash
bench git review-branch                          # show it
bench git set-review-branch --branch fix/login   # review fix/login, for everyone
bench git set-review-branch --branch ""          # back to the default branch
```

The MCP tools are `get_review_branch` and `set_review_branch`. Over REST, `GET /review-branch` and `PUT /review-branch {branch}`.

## Links to another branch

A page address can name a branch of its own: `/p/api?branch=fix/login#/findings` shows `fix/login` to whoever opens it, without changing the project's. The chip says so (`fix/login link`) and offers to review that branch for everyone, or to go back to the project's. Any API request can do the same with `?branch=` (or the `X-Bench-Branch` header).

If a saved or linked branch no longer exists, the default branch stands in for it and the chip says which one is missing.

## What follows the branch

| | On the review branch |
|---|---|
| **Browse** | Opens at the branch's head; the history starts there. ([`?at=`](/panel/browse) still looks at any other branch or commit without changing the review branch.) |
| **Changes** | Since the branch's latest baseline (one whose commit is in its history) up to its head. Baselines on other branches don't apply. |
| **Findings, comments, features** | Those anchored on a commit in the branch's history. The rest are counted, not listed: the Findings page says how many are on other branches and shows them, marked, on asking. A finding's own page and thread are always reachable. |
| **Baselines** | A new baseline is taken at the branch's head by default, and its counts are the branch's. |
| **Reconciling** | Annotations are [reconciled](/concepts/reconciling) to the branch's head. |

An annotation anchored on a commit that can't be found (a rewritten history, or a database carried over from another checkout) counts as on every branch, so nothing disappears just because its commit did.

The cross-project pages (home, flows, the service map, project cards) still count every branch's findings.
