# agentank-evolver

Generated: 2026-05-14T13:37:46.5158078+08:00

`agentank-evolver` is a local strategy evolution workspace for AgenTank. It is designed to be driven by `D:\github\My\js-evolution-agent` through the `agentank-tank` subject.

## Safety Defaults

- `AGENTANK_TANK_KEY` is read only from the local environment.
- Authorization headers and tank keys are redacted from outputs and persisted data.
- Publishing requires `AGENTANK_ALLOW_PUBLISH=true` and a passing evaluation gate.
- Real recorded challenge (`challenge`) updates stats and rankings. It runs only when `AGENTANK_ALLOW_CHALLENGE=true` or `--force` is passed. `challenge-request` still only records a local stub for approval.

## Commands

```powershell
node src/cli.mjs sync
node src/cli.mjs generate
node src/cli.mjs simulate --opponent nova-scout --map classic
node src/cli.mjs evaluate
node src/cli.mjs publish
node src/cli.mjs challenge --randomOpponent --map classic
node src/cli.mjs challenge-request --opponentTankId 42 --map classic --reason "manual review"
```

All commands print JSON so the host project can capture receipts and ingest summaries.
