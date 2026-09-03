# AGENTS.md — bi

> Read `../AGENTS.md` first — this file is the `bi` specialization.

## What this is

`bi` is `pi/packages/ai` → BAML. Port where it makes sense: **BAML owns LLM-calling logic** (`turn.baml` `SendTurn/StreamTurn/StartIncrementalStream` via `ai.Client`, `models/provider/tools/agent/image/stream`, `TurnPrompt` spec only), **thin TS host wraps `baml_sdk`** (`src/anthropic|openai-responses|google|conversation|tools|agent|provider|models|bais|cli`, `toHistory`/`toToolSpecs`).

Namespace is `bi` / `.bi`, not `pi`.

## Toolchain

Pinned `0.17.0` (wrapper `0.2.4`, toolchain `0.17.0 canary`, bridge `0.17.0` —
SDK and bridge versions must match). 0.18-isms (`ai.ModelTurn.calls`,
`string[]` stream deltas, cross-package `bais.*` refs) were reverted:
stream arms take single `string`, bais ToolSpecs are vendored into
`baml_src/tools.baml` until `[dependencies]` lands.

```
baml check --project bi    # 24 files Finished
baml test --project bi     # 110 passed
baml generate --project bi # 68 files → baml_sdk
```

## Project wiring

* `baml.toml` `[dependencies] bais = { path = "../bais" }` → `bais.Issue` is `bais.Issue` in BAML (Phase-B `Dependency` root; verified via isolated probe vs wrapper `unresolved bais`).
* FFI shims to keep until `baml-bridge 0.18.0`: `provider: string` tag (`bi#02`), `TurnFailure` concrete union (`bi#03`), `build_client` + consume in one BAML call (`bi#01`), `CreateMediaBlock` in-VM (`bi#06`). `0.18.0` VM already `string[]` / `throws never` clean.
* Issues live in `bi/.bais/issues/bi#01-10` (`bi#01,02,03,06` Open proposals, rest Done) — see `../proposals/` for FFI reports.

When in doubt, read `../pi/packages/ai` as ground truth, never edit `../pi`.
