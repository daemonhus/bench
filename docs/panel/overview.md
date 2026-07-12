# Overview

The Overview panel is the project dashboard: the first tab (shortcut <kbd>0</kbd>). A header band carries the project context, and three columns below it cover findings, the repository, and the annotated attack surface.

**Header** names the service, its owner (linked to [Context](./context)), the description, and the profile attributes as chips - the same meta-attributes that contextualise every finding. Three KPIs sit alongside: open findings (of the total, and how many are closed), how far HEAD has drifted from the last baseline (commits and merges since it was set), and the size of the attack surface.

**Findings** (first column) opens with the resolution strip - open, in progress, accepted, closed - then **systemic issues**: findings grouped by category, each row showing the total, how many remain open, and a severity swatch per finding, so a category holding three highs reads differently from one holding three lows. Below that, findings raised per week; hover a column for exact values.

**Repository** (second column) leads with the baseline callout: which baseline is the last reviewed state, when it was set, and how far HEAD has moved past it. Then HEAD itself (short hash, subject, relative age, and the branches pointing at it), a reconciliation chip (green when annotations are reconciled to HEAD, amber when they lag), the recent log rendered with the same commit graph as the Browse panel, and the commit activity timeline - commits per period, with the authors who made them. Switch the timeline between day, week, month, and year, and page back through history with the arrows.

**Attack surface** (third column) counts features by kind - interfaces, sources, sinks, dependencies, externalities - and renders the feature map: a force-directed graph of the annotated surface, drawn from the features and the links between them. Nodes are coloured by kind; hovering one raises its card.

Each panel title links through to the full panel, and the finding and feature references throughout link to their filtered lists - see [Findings](./findings#filtering).

## Notes

The map lays out real features, not a mockup. A feature with no links still appears; it simply sits unconnected.

Findings raised per week counts by creation date, so back-filling a review with historical findings puts them in the week they were *recorded*, not the week the code was written. To capture when a vulnerability was actually introduced, record its [origin](../concepts/annotations#origin).
