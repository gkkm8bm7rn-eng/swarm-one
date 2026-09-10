# SWARM One v0.7.1 — Architecture

## One protocol, local-first runtime

SWARM One is a static PWA. The public repository contains the application shell only. User state is stored in IndexedDB on the device.

### Context Capsule

Memory items are typed as `FACT`, `REQUIREMENT`, `PREFERENCE`, `DECISION`, `HYPOTHESIS`, or `STALE`.

The **Context Gate** exposes only `FACT`, `REQUIREMENT`, and `PREFERENCE` to blind candidate rounds. Prior `DECISION`, `HYPOTHESIS`, and `STALE` items are withheld by default to reduce anchoring.

### Blind → Reveal → Challenge → Verify → Repair → Judge

- S0: one local inference call.
- S1: blind candidate → verifier → judge.
- S2: two blind candidates → critic → verifier → judge.
- S3: three blind candidates → critic → verifier → repair → post-check → judge.

Blind candidates receive the same source task/materials and gated stable context, but do not receive one another's answers.

### Private Audit Trace

Internal candidate/critic/verifier records are stored only in the local IndexedDB `audit` store. They are intentionally excluded from the Recovery Capsule and never committed to GitHub.

### Continuity Ledger

The Ledger stores compact completion metadata: task summary, status, mode, final summary, verification scope, unresolved risk, and next action. It is not a collaborative scratchpad and is not injected into blind rounds.

### Local model

The current cautious mobile default is `Qwen2.5-0.5B-Instruct-q4f16_1-MLC` through WebLLM 0.2.85. First-time model acquisition requires network access. The user must perform a real airplane-mode test before relying on offline availability.
