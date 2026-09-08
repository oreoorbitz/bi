// bi/scripts/keybindings.mjs — keybindings file-format conformance (bi#91).
// Drives the REAL host module (dist/src/keybindings.js) plus the BAML file
// policy (keybinding_definitions/key_id_valid/validate via dist/baml_sdk)
// and asserts:
// (1) BAML/library parity — the vendored table has exactly the
//     TUI_KEYBINDINGS ids plus the bi-owned ids, every shipped default
//     passes BAML key_id_valid, and descriptions match the library's;
// (2) file-format matrix through the real loader (temp files, no ~/.bi
//     touched): string + array values, unknown ids fail LOUDLY with the
//     valid subset still applied, bad key names fail loudly, bad JSON /
//     non-object / non-string values become file errors, empty lists unbind,
//     BOM-prefixed files parse;
// (3) round-trip — save → reload picks up external edits (the /reload path)
//     and reset clears;
// (4) live matching — a remapped manager matches the NEW key bytes through
//     the library's own matcher and no longer matches the old ones.
// (5) bi-owned app-level id (bi#156) — validates, matches its default,
//     remaps live through the /reload path driving a real PromptEditor,
//     lists with description, and collides loudly via getConflicts.
// No TTY needed: key bytes are synthetic fixtures, runs offline anywhere.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = dirname(fileURLToPath(import.meta.url));
const kb = await import(join(ROOT, "..", "dist", "src", "keybindings.js"));
const sdk = await import(join(ROOT, "..", "dist", "baml_sdk", "index.js"));
const { TUI_KEYBINDINGS } = await import("@earendil-works/pi-tui");

const {
	loadKeybindingsFile,
	validateKeybindings,
	reloadKeybindings,
	getUserKeybindings,
	currentKeybindingsManager,
	saveKeybindings,
	resetKeybindings,
	renderKeybindingList,
	BI_KEYBINDINGS,
} = kb;
const { setKeybindings } = await import("@earendil-works/pi-tui");
const { keybinding_definitions, key_id_valid } = sdk;

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

const dir = mkdtempSync(join(tmpdir(), "bi-kb-"));
const f = (name) => join(dir, name);

// (1) BAML/library parity (plus bi-owned ids registered alongside).
const defs = keybinding_definitions();
const libIds = Object.keys(TUI_KEYBINDINGS);
const biIds = Object.keys(BI_KEYBINDINGS);
check(defs.length === libIds.length + biIds.length, `BAML table covers ${libIds.length} library + ${biIds.length} bi-owned ids (got ${defs.length})`);
check(libIds.every((id) => defs.some((d) => d.id === id)), "every library id is in the BAML table");
check(biIds.every((id) => defs.some((d) => d.id === id)), "every bi-owned id is in the BAML table");
for (const d of defs) {
	for (const k of d.default_keys) {
		if (!key_id_valid(k)) { check(false, `shipped default ${d.id}=${k} passes BAML validation`); }
	}
}
console.log("ok: every shipped default passes BAML key_id_valid");
const libDefs = defs.filter((d) => libIds.includes(d.id));
check(
	libDefs.every((d) => d.description === TUI_KEYBINDINGS[d.id]?.description),
	"BAML descriptions match the library's",
);
const libDefaultsMatch = libDefs.every((d) => {
	const lib = TUI_KEYBINDINGS[d.id]?.defaultKeys;
	const arr = Array.isArray(lib) ? lib : [lib];
	return JSON.stringify([...d.default_keys].sort()) === JSON.stringify([...arr].sort());
});
check(libDefaultsMatch, "BAML defaults match the library's");
for (const id of biIds) {
	const row = defs.find((d) => d.id === id);
	const want = BI_KEYBINDINGS[id];
	const wantKeys = Array.isArray(want.defaultKeys) ? want.defaultKeys : [want.defaultKeys];
	check(row?.description === want.description, `bi-owned ${id} description matches the host table`);
	check(JSON.stringify([...(row?.default_keys ?? [])].sort()) === JSON.stringify([...wantKeys].sort()), `bi-owned ${id} default matches the host table`);
}

// (2) file-format matrix.
writeFileSync(f("valid.json"), JSON.stringify({ "tui.select.up": "ctrl+p", "tui.select.down": ["ctrl+n", "alt+n"] }));
{
	const { entries, fileErrors } = loadKeybindingsFile(f("valid.json"));
	check(fileErrors.length === 0, "valid file has no file errors");
	const v = await validateKeybindings(f("valid.json"));
	check(v.errors.length === 0, "valid remap validates clean");
	check(v.config["tui.select.up"]?.join(" ") === "ctrl+p", "string value becomes a single-key override");
	check(v.config["tui.select.down"]?.join(" ") === "ctrl+n alt+n", "array value becomes a multi-key override");
}

writeFileSync(f("unknown.json"), JSON.stringify({ cycle: "ctrl+p", "tui.select.up": "ctrl+p" }));
{
	const v = await validateKeybindings(f("unknown.json"));
	check(v.errors.length === 1 && v.errors[0].includes("cycle"), "unknown id fails loudly naming the id");
	check(v.config["tui.select.up"]?.join(" ") === "ctrl+p", "valid subset still applies beside an unknown id");
}

writeFileSync(f("badkey.json"), JSON.stringify({ "tui.select.up": "bogus+c" }));
{
	const v = await validateKeybindings(f("badkey.json"));
	check(v.errors.length === 1 && v.errors[0].includes("tui.select.up"), "bad key name fails loudly naming the id");
	check(!("tui.select.up" in v.config), "entry with a bad key is dropped, never applied");
}

writeFileSync(f("broken.json"), "{ not json");
{
	const { entries, fileErrors } = loadKeybindingsFile(f("broken.json"));
	check(entries.length === 0 && fileErrors.length === 1, "unparseable JSON becomes a file error");
}

writeFileSync(f("array-top.json"), JSON.stringify(["tui.select.up"]));
{
	const { fileErrors } = loadKeybindingsFile(f("array-top.json"));
	check(fileErrors.length === 1, "non-object top level becomes a file error");
}

writeFileSync(f("badval.json"), JSON.stringify({ "tui.select.up": 42 }));
{
	const { entries, fileErrors } = loadKeybindingsFile(f("badval.json"));
	check(entries.length === 0 && fileErrors.length === 1, "non-string value becomes a file error");
}

writeFileSync(f("unbind.json"), JSON.stringify({ "tui.editor.yankPop": [] }));
{
	const v = await validateKeybindings(f("unbind.json"));
	check(v.errors.length === 0 && Array.isArray(v.config["tui.editor.yankPop"]) && v.config["tui.editor.yankPop"].length === 0, "empty list is a legal unbind");
}

writeFileSync(f("bom.json"), "﻿" + JSON.stringify({ "tui.select.up": "ctrl+p" }));
{
	const v = await validateKeybindings(f("bom.json"));
	check(v.errors.length === 0 && v.config["tui.select.up"]?.join(" ") === "ctrl+p", "BOM-prefixed file parses");
}

{
	const v = await validateKeybindings(f("missing.json"));
	check(v.errors.length === 0 && Object.keys(v.config).length === 0, "missing file means defaults, silently");
}

// (3) round-trip: save → external edit → reload (the /reload path) → reset.
{
	await saveKeybindings([{ id: "tui.select.up", keys: ["ctrl+p"] }], f("rt.json"));
	let r = await reloadKeybindings(f("rt.json"));
	check(r.applied === 1 && r.errors.length === 0, "saved remap reloads");
	check(getUserKeybindings()["tui.select.up"]?.join(" ") === "ctrl+p", "cache reflects the saved remap");
	writeFileSync(f("rt.json"), JSON.stringify({ "tui.select.up": "ctrl+n", "tui.input.submit": "ctrl+m" }));
	r = await reloadKeybindings(f("rt.json"));
	check(r.applied === 2, "/reload picks up external edits");
	check(getUserKeybindings()["tui.input.submit"]?.join(" ") === "ctrl+m", "externally edited binding is live");
	const { text } = await renderKeybindingList(f("rt.json"));
	check(text.includes("* tui.select.up  ctrl+n"), "list marks the override with *");
	check(resetKeybindings(f("rt.json")) === true, "reset removes the file");
	check(resetKeybindings(f("rt.json")) === false, "second reset reports already-defaults");
	await reloadKeybindings(f("missing.json"));
}

// set-with-no-keys unbinds; invalid saves throw before touching disk.
{
	await saveKeybindings([{ id: "tui.select.cancel", keys: [] }], f("unbind2.json"));
	const v = await validateKeybindings(f("unbind2.json"));
	check(v.config["tui.select.cancel"]?.length === 0, "saved empty list stays an unbind");
	let threw = false;
	try {
		await saveKeybindings([{ id: "nope", keys: ["ctrl+x"] }], f("should-not-exist.json"));
	} catch { threw = true; }
	check(threw, "saving an unknown id throws instead of writing");
}

// (4) live matching through the library matcher: ctrl+p is \x10.
{
	await saveKeybindings([{ id: "tui.select.up", keys: ["ctrl+p"] }], f("live.json"));
	await reloadKeybindings(f("live.json"));
	const mgr = currentKeybindingsManager();
	check(mgr.matches("\x10", "tui.select.up"), "remapped manager matches the new key bytes");
	check(!mgr.matches("\x1b[A", "tui.select.up"), "remapped manager no longer matches the old key");
	check(mgr.getKeys("tui.select.up").join(" ") === "ctrl+p", "getKeys reports the override");
	check(mgr.getKeys("tui.select.down").join(" ") === "down", "untouched bindings keep defaults");
	const conflicts = mgr.getConflicts();
	check(Array.isArray(conflicts), "conflict surface is reachable");
	await reloadKeybindings(f("missing.json"));
}

// (5) bi-owned app-level id end to end. ctrl+p is \x10, ctrl+n is \x0e.
{
	const { PromptEditor } = await import(join(ROOT, "..", "dist", "src", "prompt.js"));
	const theme = { borderColor: (s) => s, selectList: {} };
	// Drive a real PromptEditor through the global manager exactly as
	// runModal installs it per modal (setKeybindings(current...)).
	const fireCycle = (bytes) => {
		const ed = new PromptEditor({}, theme);
		const out = [];
		ed.onCycleForward = () => out.push("cycle");
		ed.handleInput(bytes);
		return out.join(",");
	};
	// Default: BAML accepts the id, the manager matches ctrl+p.
	{
		const v = await validateKeybindings(f("missing.json"));
		check(v.errors.length === 0, "bi-owned id needs no file entry to validate");
		await reloadKeybindings(f("missing.json"));
		setKeybindings(currentKeybindingsManager());
		const mgr = currentKeybindingsManager();
		check(mgr.matches("\x10", "bi.model.cycleForward"), "default manager matches ctrl+p for bi.model.cycleForward");
		check(mgr.getKeys("bi.model.cycleForward").join(" ") === "ctrl+p", "getKeys reports the ctrl+p default");
		check(fireCycle("\x10") === "cycle", "PromptEditor cycles on default ctrl+p");
		check(fireCycle("\x0e") === "", "PromptEditor ignores ctrl+n by default");
	}
	// Remap: file edit + reload (the /reload path) moves the binding.
	{
		writeFileSync(f("cycle.json"), JSON.stringify({ "bi.model.cycleForward": "ctrl+n" }));
		const v = await validateKeybindings(f("cycle.json"));
		check(v.errors.length === 0 && v.config["bi.model.cycleForward"]?.join(" ") === "ctrl+n", "remapped bi-owned id validates");
		const r = await reloadKeybindings(f("cycle.json"));
		check(r.applied === 1 && r.errors.length === 0, "remapped bi-owned id reloads");
		setKeybindings(currentKeybindingsManager());
		check(fireCycle("\x0e") === "cycle", "PromptEditor cycles on remapped ctrl+n");
		check(fireCycle("\x10") === "", "PromptEditor no longer cycles on old ctrl+p");
		// External edit without restart: rewrite + reload again.
		writeFileSync(f("cycle.json"), JSON.stringify({ "bi.model.cycleForward": "ctrl+g" }));
		await reloadKeybindings(f("cycle.json"));
		setKeybindings(currentKeybindingsManager());
		check(fireCycle("\x07") === "cycle", "externally edited remap is live next modal");
		check(fireCycle("\x0e") === "", "previous remap stops firing after re-reload");
		const { text } = await renderKeybindingList(f("cycle.json"));
		check(text.includes("* bi.model.cycleForward  ctrl+g"), "list marks the bi-owned override with *");
		check(text.includes("Cycle to next model"), "list shows the bi-owned description");
		await reloadKeybindings(f("missing.json"));
		setKeybindings(currentKeybindingsManager());
	}
	// Unknown ids still loud (a bi.* typo is not silently adopted).
	{
		writeFileSync(f("cycle-typo.json"), JSON.stringify({ "bi.model.cycleForwrd": "ctrl+n" }));
		const v = await validateKeybindings(f("cycle-typo.json"));
		check(v.errors.length === 1 && v.errors[0].includes("bi.model.cycleForwrd"), "typoed bi-owned id fails loudly");
		check(!("bi.model.cycleForwrd" in v.config), "typoed id never reaches the manager");
	}
	// Conflicts surface through getConflicts, never silent shadowing.
	{
		writeFileSync(f("cycle-clash.json"), JSON.stringify({ "tui.select.up": "ctrl+p", "bi.model.cycleForward": "ctrl+p" }));
		await reloadKeybindings(f("cycle-clash.json"));
		const clashes = currentKeybindingsManager().getConflicts();
		const hit = clashes.find((c) => c.key === "ctrl+p");
		check(!!hit && hit.keybindings.includes("tui.select.up") && hit.keybindings.includes("bi.model.cycleForward"), "user-remap collision surfaces via getConflicts");
		await reloadKeybindings(f("missing.json"));
		setKeybindings(currentKeybindingsManager());
	}
}

console.log(failures === 0 ? "keybindings: all green" : `keybindings: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
