# Review branch

Each project is reviewed on one branch, called its review branch. Browse, Changes, Findings, Features and the Overview show the project as it is on that branch, and the API, the CLI and MCP use the same branch. A request that names no commit uses the head of the branch, and lists, baselines and summaries cover only what is on it. Over MCP, `get_review_branch` and `set_review_branch` read and set the review branch; the other tools take an optional `branch` argument to use another branch, and the list tools take `all_branches` to include every branch. A new project's review branch is the repository's default branch (`main` or `master`, or the branch that `origin/HEAD` points to), regardless of which branch is checked out.

## Choosing the review branch

The branch selector beside the project name, at the top left of the workbench, shows the review branch. Selecting another local branch saves it for the project, so that every user and agent uses that branch. The workbench then reloads on the new branch. Selecting the default branch saves the default rather than the branch name, so that the project follows the default branch if it changes.

```bash
bench git review-branch                          # show the review branch
bench git set-review-branch --branch fix/login   # make fix/login the review branch for everyone
bench git set-review-branch --branch ""          # return to the default branch
```

Over REST, the review branch is read with `GET /review-branch` and set with `PUT /review-branch {branch}`.

## Linking to another branch

The address of a page can name a branch, for example `/p/api?branch=fix/login#/findings`. Anyone who opens the address sees `fix/login`, and the project's review branch is not changed. The branch selector is then marked `link`, and offers to make the linked branch the review branch or to return to the project's review branch. An API request can name a branch in the same way, with `?branch=` or the `X-Bench-Branch` header.

If a saved or linked branch does not exist, the default branch is used in its place, and the branch selector names the missing branch.

## What depends on the review branch

| Area | Behaviour |
|---|---|
| Browse | Opens at the head of the branch, and the commit history starts there. The `?at=` parameter of [Browse](/ui#browse) shows another branch or commit without changing the review branch. |
| Changes | Compares the head of the branch with its latest baseline, which is the most recent baseline whose commit is in the branch's history. Baselines on other branches are not used. |
| Findings, comments and features | Lists include only the items whose commit is in the branch's history. Other items are counted but not listed; the Findings page shows the number on other branches and can list them, marked. The page and comment thread of every finding remain available. |
| Baselines | A new baseline is taken at the head of the branch by default, and its counts cover the branch. |
| Reconciliation | Annotations are [reconciled](/concepts/reconciling) to the head of the branch. |
| Commits | A request that names no commit, such as creating a finding or searching the code, uses the head of the branch. |
| Summary | The counts of findings and comments cover the branch. |

An annotation whose commit cannot be found, because history has been rewritten or because the database was copied from another repository, is treated as being on every branch. An annotation is therefore never hidden only because its commit is missing.

The pages that cover all projects (the home page, flows, the service map and the project cards) count the findings on every branch.
