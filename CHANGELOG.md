# Changelog

Bi is unreleased (`0.0.0`, private). Entries land here with the change,
newest section first — `/changelog` shows the top section.

## Unreleased

Session UI (bi#30): `/resume` lists and restores prior sessions, `/fork`
branches, `/clone` duplicates without a parent link, `/name` labels,
`/export` writes markdown, `/import` adopts external JSONL, `/share`
posts a secret gist via `gh`.

Settings (bi#29): `/settings` get/set/unset over persisted backend
defaults, `/config` edits `settings.json` in `$EDITOR` with BAML
revalidation, project trust gate with session-only escape, `/oauth`
per-provider status board, `/skills` inventory of `.bi/skills`.

Model scoping (bi#28): `/model` and `/thinking` switch the live backend
with footer readout, `/scoped-models` narrows the catalog to a persisted
enabled set with `(disabled)` marks and switch guards.

Input chrome (bi#32): `/tree` file browser with numbered attach,
`/attach` stages fenced file context, `/editor` composes in `$EDITOR`,
`/copy` copies the last answer, `/paste` stages clipboard PNGs with a
BAML image-capability guard, `/paste clear` drops staged images.

Providers: Meta Muse Spark via `api.meta.ai` (bi#65), Grok catalog
refresh from x.ai docs (bi#66), GLM/Flash from z.ai docs with true
pricing, stored-key chain with missing-key `bi login` hints.

Pinned footer (bi#67): the REPL model/context readout pins to the
bottom row via a scroll region on TTY, repainted differentially on turn
end through the BAML footer frame; pipes keep the plain printed line
byte-identical.

UI foundation (bi#27/bi#33): markdown shaping, tool status lines,
TTY-gated theme system.
