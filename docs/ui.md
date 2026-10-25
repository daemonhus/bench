# Using the UI

The home page lists the projects. **Activity**, **Flows** and **Map** in the side rail cover all projects, and are described in [Projects & flows](/concepts/multi-project). Opening a project shows its workbench. The top bar shows the project name, which opens the Overview (<kbd>0</kbd>), the [review branch](/concepts/review-branch), and the tabs: Browse (<kbd>1</kbd>), Changes (<kbd>2</kbd>), Findings (<kbd>3</kbd>), Features (<kbd>4</kbd>) and Profile (<kbd>5</kbd>).

Each page stores its filters, sort order and search in the address, so that a view can be linked to, bookmarked, and revisited with Back.

## Overview

The Overview summarises the project. The header shows the service name, owner and description, the [profile](#profile) attributes, and three figures: the number of open findings, the number of commits on the review branch since the latest baseline, and the size of the attack surface. Below the header are three columns.

- **Findings** shows the findings by status, then the systemic issues (findings grouped by category, with a severity marker for each finding), then a chart of findings over time. The chart shows findings raised and resolved per week, month or year, with the number of open findings drawn as a line, and it opens on the most recent period with activity.
- **Repository** shows the latest baseline and the number of commits since it, the head of the review branch, the local branches (each of which opens Browse on that branch), whether the annotations are reconciled, the recent history as a graph, and commits over time with their authors.
- **Attack surface** shows the number of features of each kind and the feature map, which draws the features and the links between them, coloured by kind.

The chart of findings over time counts each finding at the time it was recorded, not at the time the code was written; the [origin](/concepts/annotations#origin) of a finding records the latter. Findings that were resolved before bench recorded resolution dates are counted below the axis.

## Browse

Browse shows the file tree on the left, the code in the centre, and the annotations on the right.

The card above the file tree shows the current commit: its hash, subject, author and age, and the branch whose head it is. Selecting the card opens the commit history. **Compare** replaces the card with two cards, From and To, and the history then offers only commits that keep From earlier than To. Browse opens at the head of the review branch. To view another branch without changing the review branch, select the branch on the Overview; the address then names the branch, for example `#/browse?at=fix/login`.

Selecting lines in the gutter offers to add a comment, a finding or a feature at those lines, or to copy a link to them on the repository's host. A finding's severity is shown as a bar beside its lines, and overlapping findings are drawn side by side.

The blame column shows who last changed each line and when. Hovering over a label shows the commit, selecting it opens the change, and dragging the edge of the column resizes it. <kbd>B</kbd> shows or hides the column.

## Changes

Changes compares the review branch with its latest baseline. It lists the findings and features added since the baseline, the findings removed, and the files changed since the baseline's commit. Below this is a list of findings, comments, features and commits in reverse date order, which can be filtered by kind, severity and actor. A merge commit shows the pull request or merge request that it merged, with its number, title, source branch and commits; these details are read from the commit messages.

**Set Baseline** creates a baseline. The baseline history lists earlier baselines, and selecting one shows what it added. A baseline's reviewer and summary can be edited, and a baseline can be deleted. If the review branch has no baseline in its history, Changes offers to create one.

## Findings

Findings lists every finding on the review branch, with metrics by severity, status, source and category above the list. The list can be filtered by state (open or closed), severity and actor, and searched. A finding's status can be changed on its card, and each finding has its own page and comment thread.

Findings on other branches are counted but not listed. **Show them** adds them to the list, marked as not on the review branch.

Other pages link to filtered views of the list:

| Address | Shows |
|---|---|
| `#/findings/{id}` | one finding |
| `#/findings/feature/{id}` | the findings linked to a feature |
| `#/findings?severity=high` | the findings of one severity |
| `#/findings?overdue=1` | the open findings that are past their deadline (critical 7 days, high 30, medium 90, low 180) |
| `#/finding/{id}` | the page of a finding |

## Features

Features lists the attack surface by kind, with search and sorting. Each feature has its own page, which shows its parameters, links, origin, findings and comments, and the flows that include it.

## Profile

The service profile records information about the service that the code does not show: exposure, compute, data sensitivity, criticality, tenancy, lifecycle, edge protections, compliance scope, the authentication model, the consumers, and the [trust zone](/concepts/multi-project#trust-zones). Each field explains how it affects the weight of a finding; for example, rate limiting at the gateway makes a finding about missing rate limits irrelevant, and multi-tenancy increases the impact of an authorisation issue. Changes are saved as they are made.

An unset field means that the attribute is not configured. It is never treated as evidence that a control is missing. In the multiple-choice fields, **None** states that the control is known to be absent, and selecting it clears the other options.

Until the profile has been saved once, bench rejects findings, comments, features, web links and baselines from the UI, the CLI, the API and MCP, and a banner links to the profile. Saving an empty profile is sufficient. The server option `-require-profile=false` disables this check.

## Keyboard

The keyboard button at the bottom right of the workbench lists the shortcuts.

| Keys | Action |
|---|---|
| <kbd>0</kbd>–<kbd>5</kbd> | Overview, Browse, Changes, Findings, Features, Profile |
| <kbd>Tab</kbd>, <kbd>Shift</kbd>+<kbd>Tab</kbd> | move to the next or previous area (file tree, code, sidebar, list) |
| <kbd>↑</kbd> <kbd>↓</kbd>, <kbd>PgUp</kbd> <kbd>PgDn</kbd> | move within a list or the code |
| <kbd>Space</kbd> | expand or collapse the item |
| <kbd>Enter</kbd>, <kbd>Shift</kbd>+<kbd>Enter</kbd> | open the item; go to its code |
| <kbd>→</kbd> | move into the item's controls (<kbd>←</kbd> <kbd>→</kbd> to move between them, <kbd>Esc</kbd> to return) |
| <kbd>F6</kbd> | move to the toolbar (<kbd>←</kbd> <kbd>→</kbd> to move, <kbd>Esc</kbd> to return) |
| <kbd>/</kbd> | search the list |
| <kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>F</kbd>, <kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> | find in the file; find in all files |
| <kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>G</kbd>, <kbd>:</kbd> | go to a file; go to a line |
| <kbd>B</kbd> | show or hide blame |
| <kbd>Alt</kbd>+<kbd>←</kbd> <kbd>→</kbd> | back; forward |
| <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>←</kbd> <kbd>→</kbd> | resize the focused panel |
| <kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>Enter</kbd>, <kbd>Esc</kbd> | submit; cancel |
