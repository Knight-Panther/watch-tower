# Test Results

This folder stores persistent test results across sessions.

## File Naming Convention

```
{ISO-timestamp}_{suite}.json    — Machine-readable test results
latest_{suite}.json             — Most recent run (auto-updated)
index.json                      — Manifest of all runs
coverage/                       — HTML coverage reports
```

## How to Read Results

Each JSON file contains:
- `timestamp` — When the tests ran
- `suite` — Which test suite (unit, integration, e2e)
- `summary` — Pass/fail/skip counts
- `tests[]` — Individual test results with name, status, duration, error

## Comparing Runs

```bash
npm run test:compare -- results/file1.json results/file2.json
```

Shows new failures, fixed tests, and performance regressions.

## Note

Result files (*.json, *.html) are gitignored. Only this README and .gitkeep are tracked.
