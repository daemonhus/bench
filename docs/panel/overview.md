# Overview

The Overview panel is the project dashboard: the first tab (shortcut <kbd>0</kbd>), summarising review state at a glance in three columns.

**Git state** (first column) shows the last pull (HEAD commit with relative age and subject), the most recent merge commit, where reconciliation has got to (a green chip when annotations are reconciled to HEAD, an amber one naming how many files lag behind), the local branches, and the commit history rendered with the same graph as the Browse panel.

**Findings** (second column) shows the open count broken down by severity, the mean time to resolve, and two weekly charts: findings raised per week, and mean time to resolve per week. Hover a column for exact values.

**Features** (third column) counts the annotated attack surface by feature kind (interfaces, sources, sinks, dependencies, externalities) and previews the planned feature relationship map: a node graph of how interfaces flow into sources, sinks, and dependencies, built from feature links. The map is currently a static mockup; PLAN-feature-graph.md describes the interactive version.

Average fix time only counts findings resolved after the `resolved_at` column was introduced; findings closed before that upgrade have no resolution timestamp and are excluded.
