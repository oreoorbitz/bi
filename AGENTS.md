# AGENTS.md — bi

> Read `../AGENTS.md` first. BI is the Pi-inspired coding agent; namespace `bi` / `.bi`.

## Ownership and entry points

* BAML owns provider calls (`turn.baml`), incremental streaming/media, model/tool/session types, and loop, retry, review, memory and skill policies.
* `src/agent.ts` executes the turn/tool loop; `agent_loop.ts` wraps BAML loop validation. The host also owns authentication, filesystem tools, session persistence, compaction plumbing and terminal rendering.
* `src/bais.ts` loads BAIS through the built sibling host wrapper. `src/tools.ts` executes tools; `baml_src/tools.baml` declares their data. Keep those surfaces aligned.
* Bare `bi` shows ready issues and enters the REPL on a TTY; non-TTY startup lists ready issues. `bi run` executes a prompt. Inspect CLI help/source for current flags.
* `BI_TUI=go` routes supported human-facing `bi run` rendering through the Go shell; the interactive REPL still falls back to pi-tui. Full Go parity is `bi#189`. Read `tui-go/AGENTS.md` before Go changes. The seam uses fds 3/4; update the host catalog and Go shapes together.

## Integration boundaries

* `baml.toml [dependencies] bais` is reserved for Phase B. No cross-package BAML imports are active. Keep BI standalone; BAIS runtime interop uses TS-host `file://` loading of `bais/dist/src/toml.js`.
* Keep 0.17.0 bridge workarounds until executed repros prove they can be removed: string provider tags, concrete `TurnFailure`, plain `ToolSpec`, in-VM client/media construction, incremental `BamlStream`. A newer VM alone does not prove bridge compatibility. Current stream deltas use single strings; do not introduce 0.18 API shapes incidentally.
* `baml_src/memory.baml` is tier-1 policy. Persistence and frozen session injection are tracked by `hub#220`; policy tests do not establish session behavior.
* `baml_src/ns_skills/` holds compiled skill interfaces/policies; `baml_src/skills.baml` is the separate markdown registry model.
* Issues migrated to the workspace root `.bais/issues/`. Tracked deletions under `bi/.bais/` belong to that migration; never restore or commit them incidentally.
* Upstream Pi is `../../pi` from this project directory. Read it for port semantics; never edit it. FFI reports live in `../proposals/`.

## Toolchain and gates

Follow the root [storage hygiene rules](../AGENTS.md#storage-hygiene): set `BAML_PROFILE=0` in the actual launcher environment, watch for new dumps after long runs, and retain Rust build artifacts only while needed. These projects use the installed CLI/bridge; normal work does not require compiling the BAML Rust checkout.

Wrapper `0.2.4`, toolchain `0.17.0`, bridge `0.17.0`; keep bridge/toolchain aligned. Use `BAML_PROFILE=0` before runtime initialization (root instructions explain shell/GUI setup). From the workspace root:

```bash
baml check --project bi
baml test --project bi
baml fmt --project bi
baml generate --project bi
npm run build --prefix bi
npm run typecheck --prefix bi
```

Never hand-edit `baml_sdk/` or `dist/`. Report observed test results; historical counts are not a current gate result.

Host gates: `npm test --prefix bi`, `npm run test:e2e --prefix bi`, and `npm run test:seam --prefix bi`; select those relevant to the change.
