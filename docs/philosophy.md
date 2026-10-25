# Philosophy

Bench is a workbench for people who review code. It records what a reviewer finds, keeps each record attached to the code it describes, and leaves the review process to the reviewer.

## Aims

**A working tool rather than a reporting tool.**
Findings are created while the code is being read, updated as the reviewer's understanding changes, and resolved when the fix is merged. Bench does not impose a form or a process.

**Based on git.**
Every annotation is anchored to a file, a commit and a line range. Reconciliation follows the code as it changes, and each project is reviewed on a branch. The state of a review is always relative to the repository.

**One set of operations.**
The UI, the CLI, the REST API and the MCP server provide the same operations, so no task depends on a particular interface.

**Suitable for automated agents.**
An agent can read code, record findings and features, track review coverage and set baselines through MCP. The data model is intended to be written by programs as readily as by people.

## Scope

**Bench is not a scanner.**
It has no detection engine. It organises the issues that a reviewer finds or imports from other tools; the output of a scanner such as Semgrep can be loaded in a batch.

**Bench is not a project management tool.**
It has no sprints and no assignees. A finding has a severity and a status, and an open finding has a fix deadline that depends on its severity.

**Bench does not replace other tools.**
It is not a proxy, an editor or a ticket tracker. It holds the results of a review and links to the systems in which they are followed up.
