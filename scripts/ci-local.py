#!/usr/bin/env python3
"""Run CI's own steps here: the `run:` steps of .github/workflows/ci.yml's backend and frontend
jobs, in order, each in its working directory, stopping a job at its first failure.

Used by `scripts/pre-push.sh --clean` in a fresh clone, so a clean install meets the checks in
exactly CI's order: a test that needs a package CI installs only later fails here too. Steps that
`uses:` an action (checkout, toolchain setup) are skipped: the local toolchain stands in.

Reads the workflow's plain subset of YAML (no anchors, no expressions in `run:`); no YAML library
is needed.
"""
import os
import re
import subprocess
import sys
import time

JOBS = ("backend", "frontend")
RED, GREEN, DIM, BOLD, OFF = "\033[31m", "\033[32m", "\033[2m", "\033[1m", "\033[0m"


def parse(path):
    lines = open(path).read().splitlines()
    jobs, current, steps = {}, None, None
    i = 0
    while i < len(lines):
        line = lines[i]
        job = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)
        if job:
            current = job.group(1)
            jobs[current] = {"dir": ".", "steps": []}
            steps = None
        elif current and re.match(r"^\s{8}working-directory:\s*(\S+)", line) and steps is None:
            jobs[current]["dir"] = line.split(":", 1)[1].strip()
        elif current and re.match(r"^    steps:\s*$", line):
            steps = jobs[current]["steps"]
        elif steps is not None and re.match(r"^      - ", line):
            steps.append({})
            lines[i] = "        " + line[8:]  # the dash's line holds the step's first key:
            i -= 1  # read it again as one
        elif steps is not None and steps and re.match(r"^        ([a-z-]+):", line):
            key, _, value = line.strip().partition(":")
            value = value.strip()
            if key == "run" and value == "|":
                block = []
                while i + 1 < len(lines) and (lines[i + 1].startswith("          ") or not lines[i + 1].strip()):
                    i += 1
                    block.append(lines[i][10:])
                value = "\n".join(block).strip("\n")
            steps[-1][key] = value
        i += 1
    return jobs


def main():
    root = os.getcwd()
    jobs = parse(os.path.join(root, ".github/workflows/ci.yml"))
    failed = []
    for name in JOBS:
        job = jobs.get(name)
        if not job:
            print(f"{RED}no {name} job in ci.yml{OFF}")
            return 1
        print(f"{BOLD}{name}{OFF}")
        for step in job["steps"]:
            if "run" not in step:
                continue
            cwd = os.path.join(root, step.get("working-directory", job["dir"]))
            label = step.get("name", step["run"].splitlines()[0])
            start = time.time()
            proc = subprocess.run(["bash", "-eo", "pipefail", "-c", step["run"]], cwd=cwd, capture_output=True, text=True)
            took = f"{DIM}{int(time.time() - start)}s{OFF}"
            if proc.returncode == 0:
                print(f"{GREEN}✓{OFF} {label:<40} {took}")
                continue
            print(f"{RED}✗{OFF} {label:<40} {took}")
            out = (proc.stdout + proc.stderr).strip().splitlines()
            for l in out[-40:]:
                print(f"    {l}")
            failed.append(f"{name}: {label}")
            break  # as in CI, a job stops at its first failed step
    if failed:
        print(f"\n{RED}{len(failed)} job(s) failed:{OFF} " + "; ".join(failed))
        return 1
    print(f"\n{GREEN}CI's steps passed{OFF}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
