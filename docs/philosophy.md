# Philosophy

Bench is a workbench for reviewers who work with code. It organises what you find, tracks where findings live as code moves, and gets out of the way.

## What it's trying to be

**A place to work, not a place to report.**
Findings live in a SQLite file next to the repo. You create them while reading, update them as your understanding changes, and resolve them when the fix lands. There's no dashboard to fill in, no ticket to open, no process to follow.

**Git-native.**
Every annotation is anchored to a file, a commit, and a line range. When code moves, reconciliation follows it. The review state is always relative to the repository — not a snapshot of a form someone filled in.

**The same tool everywhere.**
The CLI, REST API, and MCP endpoint all run the same handler code. If you can do it in the UI you can do it from the terminal or from an AI agent. Nothing is locked to a particular interface.

**Designed to work with AI.**
The MCP server exists so an AI agent can read code, create findings, track coverage, and set baselines without a human in the loop for every step. The data model is designed to be queried and written by machines as naturally as by people.

## What it's not

**Not a scanner.**
Bench has no detection engine. It doesn't find vulnerabilities — it helps you organise the ones you find (or import from tools that do). Run Semgrep, Bandit, or whatever fits the stack, then pipe the output in.

**Not a project management tool.**
There are no sprints, no assignees, no SLAs. A finding has a severity and a status. That's the extent of the workflow surface.

**Not a replacement for your existing tools.**
It doesn't replace Burp for web testing, or your IDE for reading code, or your ticketing system for tracking remediation. It's the layer where you collect and organise what those tools surface during a review engagement.

**Not multi-tenant by default.**
One instance reviews one repository.
