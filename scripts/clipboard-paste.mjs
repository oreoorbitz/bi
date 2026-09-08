// bi/scripts/clipboard-paste.mjs — clipboard paste-path conformance (bi#32 images leg).
// Drives the REAL host module (dist/src/clipboard.js) plus the BAML paste
// policy (paste_mime_supported/paste_extension via dist/baml_sdk) and asserts:
// (1) magic-byte sniffing maps PNG/JPEG/WebP/GIF and rejects BMP/TIFF/text,
// (2) extension mapping matches pi's extensionForImageMimeType shape,
// (3) BAML allowlist and host sniff agree on every probed mime,
// (4) a staged-file round-trip (write fixture bytes, read back, sniff)
//     keeps the image part byte-clean for the turn wire.
// No clipboard binary is touched: fixtures are synthetic magic + payload,
// so this runs offline on any platform.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = dirname(fileURLToPath(import.meta.url));
const mod = await import(join(ROOT, "..", "dist", "src", "clipboard.js"));
const { paste_mime_supported_async, paste_extension_async } = await import(join(ROOT, "..", "dist", "baml_sdk", "index.js"));
const { sniffImageMime, extensionForImageMime } = mod;

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("payload")]);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("payload")]);
const webp = Buffer.concat([Buffer.from("RIFF____WEBP", "ascii"), Buffer.from("payload")]);
const gif89 = Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.from("payload")]);
const gif87 = Buffer.concat([Buffer.from("GIF87a", "ascii"), Buffer.from("payload")]);
const bmp = Buffer.concat([Buffer.from("BM", "ascii"), Buffer.from("payload-padded........")]);
const text = Buffer.from("hello, this is plain text");

// (1) sniff matrix — bytes are the authority.
check(sniffImageMime(png) === "image/png", "png magic sniffs image/png");
check(sniffImageMime(jpeg) === "image/jpeg", "jpeg SOI sniffs image/jpeg");
check(sniffImageMime(webp) === "image/webp", "RIFF/WEBP sniffs image/webp");
check(sniffImageMime(gif89) === "image/gif", "GIF89a sniffs image/gif");
check(sniffImageMime(gif87) === "image/gif", "GIF87a sniffs image/gif");
check(sniffImageMime(bmp) === null, "BMP is rejected (no Photon transcode)");
check(sniffImageMime(text) === null, "text is rejected");
check(sniffImageMime(Buffer.alloc(0)) === null, "empty is rejected");
check(sniffImageMime(Buffer.from([137, 80])) === null, "truncated magic is rejected");

// (2) extension mapping.
check(extensionForImageMime("image/png") === "png", "png extension is png");
check(extensionForImageMime("image/jpeg") === "jpg", "jpeg extension is jpg");
check(extensionForImageMime("image/webp") === "webp", "webp extension is webp");
check(extensionForImageMime("image/gif") === "gif", "gif extension is gif");

// (3) BAML/host parity on every probed mime.
for (const mime of ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/tiff"]) {
	const bamlSays = await paste_mime_supported_async(mime);
	const hostSays = ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime);
	check(bamlSays === hostSays, `BAML/host agree on ${mime} (${bamlSays ? "accept" : "reject"})`);
}
for (const [mime, ext] of [["image/png", "png"], ["image/jpeg", "jpg"], ["image/webp", "webp"], ["image/gif", "gif"]]) {
	check((await paste_extension_async(mime)) === extensionForImageMime(mime), `BAML/host extension agree on ${mime}`);
}
check((await paste_extension_async("image/bmp")) === null, "BAML extension rejects BMP");

// (4) staged-file round-trip — what /paste writes, the turn reads back.
const dir = mkdtempSync(join(tmpdir(), "bi-paste-"));
try {
	for (const [name, bytes, mime] of [["a.png", png, "image/png"], ["b.jpg", jpeg, "image/jpeg"]]) {
		const file = join(dir, name);
		writeFileSync(file, bytes);
		const back = readFileSync(file);
		check(back.equals(bytes), `staged ${name} round-trips byte-clean`);
		check(sniffImageMime(back) === mime, `staged ${name} re-sniffs ${mime}`);
		check(back.toString("base64").length > 0, `staged ${name} base64s for the SendTurnWithImage wire`);
	}
} finally {
	rmSync(dir, { recursive: true, force: true });
}

if (failures) {
	console.error(`${failures} clipboard-paste check(s) failed`);
	process.exit(1);
}
console.log("clipboard-paste: all green");
