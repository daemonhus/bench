# Findings

The Findings panel lists all findings across the project. A metrics section at the top breaks them down by severity, status, category, and source.

Findings are grouped into two sections: **Open** (draft, open, in-progress) and **Closed** (false-positive, accepted, closed).

![Findings panel showing the metrics section and expanded finding cards with comment threads](./img/findings.png)

## Editing

Expand a finding card and click the edit icon to open the edit form. You can change the title, description, severity, status, source, category, CWE, CVE, and CVSS vector/score.

To cycle a finding's status without opening the full form, click the status label directly.

## Conversation

Each finding has a comment thread. Expand the finding to read the discussion and add a reply. Type in the text area at the bottom and press **Submit** or <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Enter</kbd> to post.

Click the edit icon on any comment to revise its text, or the delete icon to remove it.

## Filtering

Use the severity and source dropdowns to narrow the list. Toggle the Open and Closed sections to focus on what's relevant.

The list can also be filtered by the route, which is how the rest of the app links into it:

| Route | Shows |
|-------|-------|
| `#/findings` | Everything |
| `#/findings/{id}` | That one finding |
| `#/findings/feature/{id}` | Findings linked to that feature |

Both filters appear as a pill next to the search box, labelled with the id's short code; hover it for the title, and click the `×` to clear (which also normalises the URL, so a reload stays clear). Clicking a finding anywhere else in the app - the Overview's systemic issues, the feature map, the activity feed on Changes - filters the list to it rather than scrolling you to its position in a long list. A finding linked this way is shown whatever its status, so the Open/Closed toggles never hide the thing you just clicked.
