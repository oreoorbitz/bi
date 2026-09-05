# bi e2e pty harness

`scripts/e2e-pty.mjs` (+ transport `scripts/e2e-pty-spawn.py`) boots the real
`bi` under a pty with a sandboxed HOME, answers kitty/DA queries like a
kitty terminal, types scripted keys, and asserts byte-level transcript
properties. It exists because the chronic kitty junk reports never
reproduced in unit probes — only a live terminal handshake shows them.

## Run

```bash
npm run build            # harness drives dist/
npm run test:e2e         # full mock-backend suite, no key needed
node scripts/e2e-pty.mjs picker-select   # one scenario
BI_E2E_LIVE_KEY=<key> npm run test:e2e   # additionally run the live smoke
```

Without `BI_E2E_LIVE_KEY` the live smoke prints SKIP and exits 0.
Requires `python3` (pty transport — node has no pty API and `script(1)`
chokes on libuv socket stdio). macOS + Linux. Each scenario boots its own
bi with a fresh sandbox HOME (seeded sessions, pre-trusted cwd), so real
`~/.bi` is untouched. Failure transcripts are kept at
`$TMPDIR/bi-e2e-fail-*.log` (path printed on timeout).

## Scenario → symptom coverage

| scenario | pins |
|---|---|
| `editor-kitty-submit` | `/nope` typed via kitty press+release per char resolves byte-exact; no reply bytes leak (the load-time junk reports) |
| `late-replies` | 200ms-late kitty/DA replies never surface (settle envelope; stalls past ~450ms are known residual, bi#119) |
| `prompt-cancel` | Esc at the prompt re-prompts with hint; second query burst proves stdin clean |
| `picker-select` | `/model` arrows+Enter resolves a backend (`backend now p/m`) |
| `picker-cancel` | `/resume` Esc keeps the list; next prompt proves stdin clean |
| `ctrld-eof` | Ctrl-D on empty exits 0 with `EOF — session kept` |
| `live-smoke` | full `bi run` turn against a real key (gated, else SKIP) |

Every scenario also asserts the global no-leak invariant: output never
contains `?7u`, `64;1;2`, or `:3u` reply bytes.

## Adding a scenario

Add an `sName` function (`runSession({ sends, replyDelayMs })` +
`check(...)` asserts) and register it in `ALL`. Sends are
`[burstGate, offsetMs, bytes]` — fired `offsetMs` after the
`burstGate`-th query burst is seen in live output, so keys never race
boot or an unfocused widget (`~1200ms` offsets cover settle + drain with
margin; absolute send times flaked under load). Key encoders at the top:
`typeKitty`, `K_ENTER`, `K_ESC`, `K_DOWN`, `K_CTRLD`.

## Red-check record

2026-09-05: suspend reverted to `pause()` → `editor-kitty-submit` fails
exactly `no reply bytes leak (/64;1;2/)`; restored → all green. The leak
checks are load-bearing.
