# bi/tui-go — Bubble Tea v2 TUI shell spike (bi#187)

A disjoint spike answering: **can an LLM write a correct terminal UI for
`bi` against Bubble Tea v2, given the real event channels?** Evidence, not
vibes — before any `bi/src` file is touched (bi#188 decides that).

Two halves:

1. **`fixture/emit.mjs`** — a plain-node (zero-dep) fixture emitter that
   replays a scripted coding-agent session as newline-delimited JSON-RPC
   over stdio, on the six channels the real host already has.
2. **The Go program** (module `github.com/oreoorbitz/bi/tui-go`) — one root
   Elm model: transcript viewport + docked textarea (`>` glyph at col 2)
   + footer row as declared layout (**no DECSTBM, ever**) + one stacked
   modal picker + glamour markdown for turn results.

## Run it

```bash
go build -o bin/tui .
node fixture/emit.mjs | ./bin/tui > /dev/null   # demo: scripted session on your tty
go run ./drills all                              # pty drills (the acceptance gate)
```

Seam input precedence: fd 3 → `--events FILE` → stdin (when not a tty).
Back-channel precedence: fd 4 → `--out FILE` → stdout (when not a tty).
The UI always renders on `/dev/tty`. `TUI_GO_SEQ_TIMEOUT_MS` sets the
input-reassembly window (default 250ms; 0 = upstream behavior).

## The seam (protocol draft for bi#188)

Transport: newline-delimited JSON (one envelope per line), JSON-RPC 2.0
envelope shape. Host→UI on the seam-in channel; UI→host on the
back-channel. This is a **draft**: bi#188 formalizes.

### Host → UI (notifications)

`agent/event` — spinner/status (drives the footer-left spinner + label):

```json
{"jsonrpc":"2.0","method":"agent/event","params":{"kind":"spinner_start|spinner_stop|status","label":"Thinking…"}}
```

`assistant/delta` — incremental streamed text (the 40ms-delta stream):

```json
{"jsonrpc":"2.0","method":"assistant/delta","params":{"text":"…chunk…"}}
```

`tool/start` / `tool/done` — tool activity lines:

```json
{"jsonrpc":"2.0","method":"tool/start","params":{"id":"t1","name":"bash","summary":"baml test --project bi"}}
{"jsonrpc":"2.0","method":"tool/done","params":{"id":"t1","ok":true,"line":"bash: baml test --project bi (110 passed, 1.2s)"}}
```

`turn/result` — completed turn as markdown (rendered with glamour,
committed to scrollback):

```json
{"jsonrpc":"2.0","method":"turn/result","params":{"markdown":"# Turn summary\n…"}}
```

`footer/frame` — the footer as DATA, not rendered bytes (selectors.baml
`render_footer_frame` equivalent):

```json
{"jsonrpc":"2.0","method":"footer/frame","params":{"provider":"anthropic","model":"claude-sonnet-4.5","thinking":"high","tokensIn":12987,"tokensOut":643,"cwd":"~/code/x"}}
```

### Host → UI (request, answered on the back-channel)

`picker/open` — open the stacked modal picker; the UI MUST answer with the
same `id`:

```json
{"jsonrpc":"2.0","id":1,"method":"picker/open","params":{"title":"Pick a follow-up","items":[{"id":"run-drills","label":"Run the pty drill family","description":"split-CSI, paste, SIGWINCH"}]}}
```

### UI → host

`input/submit` (notification) — user submitted the docked textarea:

```json
{"jsonrpc":"2.0","method":"input/submit","params":{"text":"hello seam"}}
```

Picker responses — result on select, JSON-RPC error `-32800` on cancel:

```json
{"jsonrpc":"2.0","id":1,"result":{"itemId":"run-drills","label":"Run the pty drill family"}}
{"jsonrpc":"2.0","id":1,"error":{"code":-32800,"message":"cancelled"}}
```

### Session lifecycle

- EOF on seam-in = session end: the UI commits any pending streamed text
  to scrollback and exits 0.
- Malformed NDJSON lines, unknown methods, and `picker/open` without an
  `id` or with zero items are **named, visible errors** (status line +
  `--debug-log`), never silently dropped.

### The third channel: `--debug-log FILE`

Not part of the seam — an internal-event NDJSON log that exists so drills
(and future hosts) can assert on UI-internal facts without scraping the
rendered frame: `resize`, `paste`, `key_release`, `delta`, `submit`,
`commit`, `picker_open`, `picker_choice`, `seam_eof`, `unknown_input`,
`exit`. See `debuglog.go`.

## What the spike proved (evidence for the Go-TUI question)

- The scripted session renders end-to-end: incremental deltas (per-delta
  debug witness), ticking Dot spinner, footer from data payload, picker
  answered on the back-channel — `go run ./drills session`.
- **Scrollback survives by construction**: no alt-screen, no DECSTBM;
  completed blocks are `program.Println`d (insert-above) into real
  scrollback. Drills assert the forbidden sequences never appear.
- Bracketed paste is one `PasteMsg` per paste however chunked (textarea
  handles it natively) — the paste-burst-heuristic class is gone.
- SIGWINCH mid-stream: resize is delivered as a msg; declared layout
  recomputes; a model-side per-resize self-check asserts no rendered line
  exceeds the terminal width.
- **BUT the split-sequence class is NOT fully solved upstream**
  (proposals/14): bubbletea v2.0.9's input reader (ultraviolet
  `TerminalReader`) holds incomplete escape sequences for only
  `EscTimeout = 50ms` — the same fatal window as pi-tui's 50ms, with no
  SSH bump and no knob exposed through bubbletea. Whole sequences parse
  correctly (verified), so `seqreader.go` interposes a 250ms reassembly
  pipe in front of the input; the split-csi drill proves a kitty release
  split at 120ms types nothing. **Follow-up:** file upstream
  (charmbracelet/ultraviolet + bubbletea: SSH-aware `EscTimeout`, expose
  through `ProgramOption`) — check for existing issues first.
- v2 API traps an LLM will hit (all hit here, all documented in
  AGENTS.md): `charm.land/*` module paths, `View() tea.View`,
  KeyPress/KeyRelease split, **`program.Println` deadlocks if called
  synchronously inside `Update`**, raw mode is only automatic for terminal
  inputs, and byte-stream substring checks are useless against the
  cell-diffed renderer.
