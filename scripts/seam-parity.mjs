// bi/scripts/seam-parity.mjs — bi#188 seam message-catalog parity gate.
//
// The seam (bi/src/tui_seam.ts) is the ONLY writer to the Go shell
// (bi/tui-go). Its typed catalog is the single source of truth; the Go
// side hand-mirrors it in seam.go structs + model.go's handleSeam switch.
// This gate fails loud on drift in either direction, tool-parity.mjs
// precedent:
//   advertised = SEAM_CATALOG imported from bi/dist/src/tui_seam.js
//     (compiled, not source — a stale dist fails the same way CI would).
//   mirrored   = json tags parsed from bi/tui-go/seam.go structs +
//     method dispatch parsed from bi/tui-go/model.go.
//
// Test-only flags (red-check + fixtures, never the committed hook):
//   --inject-method NAME            pretend the catalog also has NAME.
//   --inject-field method.field=T   pretend catalog method has field.
//   --drop-go-field Struct.tag      pretend the Go struct lost a field.
//
// Red-check record (bi#57, 2026-09-08, all observed live):
//   $ node bi/scripts/seam-parity.mjs
//     => seam-parity: all green (8 methods, 27 fields, picker shapes + cancel code), exit 0
//   $ node bi/scripts/seam-parity.mjs --inject-method phantom/method
//     => FAIL catalog-without-struct-map: phantom/method — METHOD_STRUCT
//        in this gate has no entry (gate drift), exit 1
//   $ node bi/scripts/seam-parity.mjs --inject-field footer/frame.tokens=string
//     => FAIL catalog-field-without-go-tag: footer/frame.tokens — host
//        sends it but seam.go footerFrameParams has no json tag, exit 1
//   $ node bi/scripts/seam-parity.mjs --drop-go-field footerFrameParams.turn
//     => FAIL catalog-field-without-go-tag: footer/frame.turn — host
//        sends it but seam.go footerFrameParams has no json tag, exit 1
// A passing gate that cannot go red is camouflage, not coverage.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url)); // bi/scripts
const args = process.argv.slice(2);
const flag = (name) => {
	const i = args.findIndex((a) => a === name || a.startsWith(name + "="));
	if (i < 0) return undefined;
	if (args[i].includes("=")) return args[i].slice(name.length + 1);
	return args[i + 1] !== undefined && !args[i + 1].startsWith("--") ? args[i + 1] : "";
};

// (1) Advertised: the compiled catalog the host actually sends.
const { SEAM_CATALOG } = await import(join(ROOT, "..", "dist", "src", "tui_seam.js"));
const catalog = {
	...SEAM_CATALOG.hostToUiNotifications,
	...SEAM_CATALOG.hostToUiRequests,
	...SEAM_CATALOG.uiToHostNotifications,
};
const injectedMethod = flag("--inject-method");
if (injectedMethod) catalog[injectedMethod] = { probe: "string" };
const injectedField = flag("--inject-field");
if (injectedField) {
	const [left, type] = injectedField.split("=");
	const [method, field] = left.split(".");
	if (catalog[method]) catalog[method] = { ...catalog[method], [field]: type };
}

// (2) Mirrored: Go structs (json tags) + dispatch cases + back-channel writers.
const seamGo = readFileSync(join(ROOT, "..", "tui-go", "seam.go"), "utf8");
const modelGo = readFileSync(join(ROOT, "..", "tui-go", "model.go"), "utf8");

const METHOD_STRUCT = {
	"agent/event": "agentEventParams",
	"assistant/delta": "deltaParams",
	"tool/start": "toolStartParams",
	"tool/done": "toolDoneParams",
	"turn/result": "turnResultParams",
	"footer/frame": "footerFrameParams",
	"picker/open": "pickerOpenParams",
	"input/submit": "submitParams",
};

// struct name -> { tag: goType-with-optionality }
function parseGoStructs(src) {
	const out = {};
	for (const m of src.matchAll(/type\s+(\w+)\s+struct\s*\{([^}]*)\}/g)) {
		const fields = {};
		for (const line of m[2].split("\n")) {
			const f = /^\s*\w+\s+([\*\[\]\w]+)\s+`json:"(\w+)(,omitempty)?"`/.exec(line);
			if (f) fields[f[2]] = f[1] + (f[3] ? "?" : "");
		}
		out[m[1]] = fields;
	}
	return out;
}
const goStructs = parseGoStructs(seamGo);
const droppedGo = flag("--drop-go-field");
if (droppedGo) {
	const [struct, tag] = droppedGo.split(".");
	if (goStructs[struct]) delete goStructs[struct][tag];
}

// Catalog type spellings already use the Go mirror's names; "?" marks
// optional on both sides. Go spells optional scalar as a pointer with
// omitempty ("*int64?"), the catalog as "int64?" — normalize.
function goTypeToCatalog(t) {
	const opt = t.endsWith("?");
	let base = opt ? t.slice(0, -1) : t;
	if (base.startsWith("*")) base = base.slice(1);
	return base + (opt ? "?" : "");
}

let failures = 0;
const fail = (kind, msg) => {
	failures++;
	console.error(`FAIL ${kind}: ${msg}`);
};

// Every catalog method: a Go struct with matching fields AND a dispatch
// site (handleSeam case for host→UI, a seam.go writer for UI→host).
let fieldCount = 0;
for (const [method, params] of Object.entries(catalog).sort()) {
	const structName = METHOD_STRUCT[method];
	if (!structName) {
		fail("catalog-without-struct-map", `${method} — METHOD_STRUCT in this gate has no entry (gate drift)`);
		continue;
	}
	const goFields = goStructs[structName];
	if (!goFields) {
		fail("catalog-without-go-struct", `${method} — seam.go has no type ${structName} struct`);
		continue;
	}
	for (const [field, type] of Object.entries(params)) {
		fieldCount++;
		if (!(field in goFields)) {
			fail("catalog-field-without-go-tag", `${method}.${field} — host sends it but seam.go ${structName} has no json tag (silently dropped at the UI)`);
		} else if (goTypeToCatalog(goFields[field]) !== type) {
			fail("field-type-drift", `${method}.${field} — catalog ${type} vs Go ${goFields[field]}`);
		}
	}
	for (const tag of Object.keys(goFields)) {
		if (!(tag in params)) {
			fail("go-tag-without-catalog-field", `${method}.${tag} — seam.go ${structName} decodes it but the host catalog never sends it (dead mirror)`);
		}
	}
	if (method in SEAM_CATALOG.uiToHostNotifications) {
		if (!seamGo.includes(`Method: "${method}"`)) {
			fail("catalog-without-go-writer", `${method} — seam.go has no back-channel writer for it`);
		}
	} else if (!modelGo.includes(`case "${method}":`)) {
		fail("catalog-without-go-case", `${method} — host sends it but handleSeam has no case (named-unknown at the UI)`);
	}
}

// Nested picker shapes + the cancel code.
for (const [catKey, structName] of [["pickerItem", "pickerItem"], ["pickerResult", "pickerResult"]]) {
	const want = SEAM_CATALOG[catKey];
	const got = goStructs[structName] ?? {};
	for (const [field, type] of Object.entries(want)) {
		fieldCount++;
		if (!(field in got)) fail("catalog-field-without-go-tag", `${structName}.${field} — missing in seam.go`);
		else if (got[field] !== type) fail("field-type-drift", `${structName}.${field} — catalog ${type} vs Go ${got[field]}`);
	}
	for (const tag of Object.keys(got)) {
		if (!(tag in want)) fail("go-tag-without-catalog-field", `${structName}.${tag} — decoded but never sent`);
	}
}
if (!seamGo.includes(String(SEAM_CATALOG.pickerCancelCode))) {
	fail("cancel-code-drift", `picker cancel code ${SEAM_CATALOG.pickerCancelCode} not found in seam.go`);
}

if (failures) {
	console.error(`seam-parity: ${failures} drifted item(s) — land both sides together (bi/src/tui_seam.ts SEAM_CATALOG + bi/tui-go/seam.go/model.go)`);
	process.exit(1);
}
console.log(`seam-parity: all green (${Object.keys(catalog).length} methods, ${fieldCount} fields, picker shapes + cancel code)`);
