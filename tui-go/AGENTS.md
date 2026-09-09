# AGENTS.md — bi/tui-go

> Read `../../AGENTS.md` and `../AGENTS.md` first. This directory is the
> Go Bubble Tea **v2** TUI shell over a JSON-RPC/NDJSON seam, built as
> the bi#187 spike. **bi#188 has since landed the host side**: behind
> `BI_TUI=go`, `bi run` spawns this binary from `bi/src/tui_seam.ts`
> (seam on fds 3/4 — node leaks an open fd 3 into children, so the host
> MUST pass fds 3/4 explicitly). The spike's "zero changes to bi/src"
> constraint applied only until bi#188; the seam contract is now
> `SEAM_CATALOG` in `bi/src/tui_seam.ts`, mirrored by `seam.go` and kept
> honest by `bi/scripts/seam-parity.mjs` — land catalog and struct
> changes together.

## BAIS issue work

The root [required BAIS workflow](../../AGENTS.md#required-bais-workflow) applies here. Use standalone `bais` with `--hub /absolute/path/to/workspace` for shared issues, including `bi#` issues. Use native commands for supported changes; do not write issue TOML from Go, shell, or Python to manage the board.

## Build / run / drill

```bash
go build ./... && go vet ./...          # gate
go run ./drills all                     # pty drills (split-csi, paste, sigwinch, session)
go build -o bin/tui . && node fixture/emit.mjs | ./bin/tui > /dev/null   # demo on your tty
./bin/tui --events s.ndjson --out b.ndjson --debug-log d.ndjson          # scripted
```

Run drills from THIS directory (they check `go.mod`). The drills spawn the
real binary on a pty with the seam on fds 3/4; assertions read the pty byte
stream, the back-channel NDJSON, and `--debug-log` NDJSON.

## Bubble Tea v2 idioms — do NOT regress to v1

v1 muscle memory is actively wrong here. All five are load-bearing (each
one cost a debugging round in this spike):

1. **Module paths are `charm.land/*`, not `github.com/charmbracelet/*`**:
   `charm.land/bubbletea/v2`, `charm.land/bubbles/v2`,
   `charm.land/lipgloss/v2`, `charm.land/glamour/v2` (pinned in go.mod).
2. **`Model.View() tea.View`, not `string`** (v2.0.9). Wrap with
   `tea.NewView(s)`. The Model interface is `Init() tea.Cmd /
   Update(tea.Msg) (tea.Model, tea.Cmd) / View() tea.View`.
3. **Keys are `tea.KeyPressMsg` / `tea.KeyReleaseMsg`** (there is no plain
   `KeyMsg` struct to type-switch on; `tea.KeyMsg` is the interface).
   Match with `msg.String()` ("enter", "esc", "a") or
   `msg.Keystroke()` ("ctrl+c"). Kitty release events arrive as
   `KeyReleaseMsg` — never route them to text widgets.
4. **Paste is `tea.PasteMsg{Content}`** plus `PasteStartMsg`/`PasteEndMsg`
   — native bracketed paste, exactly one `PasteMsg` per paste no matter
   how the bytes were chunked. Do not write paste-burst heuristics.
5. **`program.Println(...)` is a Program method** (v1's `tea.Println` Cmd
   is gone) that does a **blocking send on the unbuffered `p.msgs`
   channel**. Calling it synchronously inside `Update` **deadlocks the
   event loop** (verified: submit delivered, then the loop wedged and even
   `tea.Quit` stopped processing). Always wrap it in a returned `tea.Cmd`;
   order it against teardown with `tea.Sequence(cmd, tea.Quit)`.

Other v2 facts relied on here:

- If `stdin` is not a TTY, v2 opens `/dev/tty` for input automatically —
  but this program always opens `/dev/tty` explicitly and passes
  `tea.WithInput/WithOutput`, because stdio is the seam.
- v2 only enters raw mode when its input is a terminal. Our seqReader
  interposes a pipe, so **we** own `term.MakeRaw` on `/dev/tty`
  (main.go). A non-terminal input with no raw mode = canonical+echo+ICRNL:
  input echoes into the frame, line-buffers, and CR arrives as LF.
- bubbles v2: `textarea` handles `tea.PasteMsg` natively; `spinner.Dot`'s
  frames are `⣾⣽⣻⢿⡿⣟⣯⣷` (NOT the ⠋⠙⠹ cli-spinners set — a drill
  assertion burned itself on this); `viewport.New()` starts 0×0, always
  `SetWidth/SetHeight` on `tea.WindowSizeMsg`.
- lipgloss v2 has `NewCompositor`/`NewLayer`/`Canvas` — the modal picker is
  a real stacked layer, no manual line splicing.
- glamour v2: `glamour.NewTermRenderer(glamour.WithStandardStyle("dark"),
  glamour.WithWordWrap(w), glamour.WithPreservedNewLines())`.

## Terminal discipline (the whole point of the spike)

- **No DECSTBM, no alt-screen, no scroll regions.** Layout is declared
  (viewport + docked textarea + footer row joined vertically; picker is a
  stacked layer). Completed blocks are committed to real scrollback with
  `program.Println` (insert-above). Drills assert `ESC[Pt;Pbr` and
  `ESC[?1049h` never appear.
- **Byte-stream substring checks are not valid render witnesses.** The
  cell-diffed "Cursed Renderer" writes changed cells with absolute cursor
  addressing, so a logical line is fragmented across the byte stream and
  stripping ANSI splices unrelated fragments. Assert on (a) the debug log
  (model-side events), (b) the back-channel, (c) short atomically-rendered
  fragments only. If screen-state assertions are ever needed, bring in a
  terminal emulator (x/vt) — don't substring the byte stream.
- **Input reassembly is OUR layer** (`seqreader.go`). Evidence:
  ultraviolet's `TerminalReader` (what bubbletea v2.0.9 uses) holds
  incomplete escape sequences for only `EscTimeout = 50ms` — the same
  fatal window as pi-tui's `DEFAULT_SEQUENCE_TIMEOUT_MS` (proposals/14),
  no SSH bump, no env knob, and bubbletea doesn't expose it. A kitty
  release split at 60/120ms types its tail as text upstream; our
  pipe-based `seqReader` (250ms window, `TUI_GO_SEQ_TIMEOUT_MS`, 0
  disables) reassembles it. The wrapper MUST be an `*os.File` pipe:
  `uv.NewCancelReader` uses a byte-discarding fallback goroutine for
  non-file readers.

## Red-checks

Every drill's safety net has been reverted once and observed failing for
the right reason — records live in `drills/main.go`'s header comment (the
canonical copy) and in the bi#187 NOTES.md handoff. `TUI_GO_SEQ_TIMEOUT_MS=0`
is the standing toggle for the split-csi red-check.

## Files

- `main.go` — flags, seam fd/file resolution, `/dev/tty` + raw mode, program wiring
- `model.go` — the one root Elm model (viewport + textarea + footer + picker + commits)
- `picker.go` — stacked modal (bubbles/list child model, lipgloss layer)
- `seam.go` — NDJSON/JSON-RPC codec + message shapes (mirror of `SEAM_CATALOG` in `bi/src/tui_seam.ts`; `bi/scripts/seam-parity.mjs` gates drift)
- `seqreader.go` — SSH-aware escape-sequence reassembly (`*os.File` pipe)
- `debuglog.go` — internal-event NDJSON log (drill witness)
- `fixture/emit.mjs` — plain-node scripted-session emitter (six channels)
- `drills/main.go` — pty drills: split-csi, paste, sigwinch, session
- `README.md` — seam message shapes (the bi#188 protocol draft)
- Host side (bi#188): `bi/src/tui_seam.ts` + `bi/scripts/seam-{parity,run-pty,picker-pty}.mjs` (`npm run test:seam --prefix bi`)
