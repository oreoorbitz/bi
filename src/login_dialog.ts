// bi/src/login_dialog.ts — in-REPL OAuth login dialog (bi#94).
//
// Port of pi's LoginDialogComponent
// (packages/coding-agent/src/modes/interactive/components/login-dialog.ts):
// browser-open hint, device-code input, expiry countdown, Esc-cancel that
// leaves the session alive. Pi's dialog is a persistent pi-tui widget
// swapped into the editor container; bi's line REPL has no persistent
// widget tree, so the "dialog" is a printed frame (DynamicBorder rules
// from prompt.ts) with BAML-shaped rows (baml_src/login_dialog.baml),
// code entry through the same askText modal / readline fallback as
// auth_cli.ts, and expiry through the shared CountdownTimer (bi#95).
//
// Standing split: BAML owns every rendered string (login_dialog.baml +
// countdown.baml); this module owns effects (printing, ticking,
// prompting, abort). Secrets never touch BAML — the returned Credential
// passes through opaquely to the caller's modifyCredential.
//
// Consumer contract (for the merger's /login wiring in cli.ts, OUT of
// scope here — R1 precedent): `await runLoginDialog(id, opts)` returns
// the fresh Credential; persistence (modifyCredential) and the REPL
// history stay with the caller, so success returns to the exact prior
// prompt state and pipes keep the current linear flow.

import { createInterface } from "node:readline";

import {
	Credential,
	ListProviders_async,
	OAuthNeedsRefresh_async,
	login_auth_url_block,
	login_cancelled_line,
	login_device_block,
	login_dialog_title,
	login_expired_notice,
	login_row_hint,
	login_success_line,
	login_waiting_line,
} from "../baml_sdk/index.js";
import { listCredentials, readCredential } from "./auth.js";
import { CountdownTimer, countdown_label } from "./countdown.js";
import { getOAuthFlow, resolveFlowLogin, type DeviceCodeNotice, type OAuthFlow, type OAuthInteraction } from "./oauth.js";
import { askText, DynamicBorder, promptAvailable } from "./prompt.js";
import { releaseReplTui, retainReplTui, termWidth } from "./tui.js";

export class LoginDialogError extends Error {}

// Print sink. `print` appends a line; `live` rewrites the current TTY
// line (countdown ticks) and degrades to a no-op on pipes, where only
// the printed expiry notice remains — same guarantee as the readline
// fallback (byte-identical, no control bytes into a pipe).
export interface LoginDialogWriter {
	print(s: string): void;
	live?(s: string): void;
}

export function consoleDialogWriter(): LoginDialogWriter {
	return {
		print: (s) => console.log(s),
		live: (s) => {
			if (process.stdout.isTTY) process.stdout.write(`\r${s}   `);
		},
	};
}

// Code-entry prompter. Default mirrors auth_cli.ts runOAuthLogin exactly:
// TTY gets the pi-tui text modal (Esc resolves null = cancel), pipes get
// the line reader (byte-identical). Null / abort both mean "Login
// cancelled" so every exit path funnels through cancel().
export type LoginDialogPrompter = (
	message: string,
	placeholder: string | undefined,
	signal: AbortSignal,
) => Promise<string | null>;

export async function defaultDialogPrompter(
	message: string,
	placeholder: string | undefined,
	signal: AbortSignal,
): Promise<string | null> {
	if (signal.aborted) return null;
	if (promptAvailable()) {
		// askText resolves null on Esc — the dialog's cancel path.
		return askText(message);
	}
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		const onAbort = () => {
			rl.close();
			resolve(null);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		rl.question(`${message} `, (answer) => {
			signal.removeEventListener("abort", onAbort);
			rl.close();
			resolve(answer);
		});
	});
}

export interface LoginDialogOptions {
	// Display name (pi's providerNameOverride). Defaults to the flow id.
	providerName?: string;
	// 1-based /oauth board row (bi#102 numbering) for the deep-link hint.
	// Resolved via loginBoardIndex when omitted.
	boardIndex?: number | null;
	writer?: LoginDialogWriter;
	prompter?: LoginDialogPrompter;
	// Flow runner, default resolveFlowLogin(flow). Injected in tests so
	// no network is needed; production passes nothing.
	login?: (flow: OAuthFlow, interaction: OAuthInteraction) => Promise<Credential>;
	now?: () => number;
}

// 1-based board position in ListProviders order — the same order cli.ts
// /oauth <n> addresses, so the dialog's hint names a working deep-link.
export async function loginBoardIndex(providerId: string): Promise<number | null> {
	const providers = await ListProviders_async();
	const at = providers.findIndex((p: any) => String(p.id ?? p) === providerId);
	return at === -1 ? null : at + 1;
}

// Stale-row pre-flight against the reconciled bi#102 layer: a stored
// OAuth credential past OAuthNeedsRefresh (same 5-minute window as the
// turn loop) makes this a refresh, and the notice names its own resume
// path. Null expiry reads as unknown, never expired (board policy).
export async function loginExpiredNotice(providerId: string, nowMs: number): Promise<string | null> {
	const cur = await readCredential(providerId);
	if (!cur || cur.type !== "oauth") return null;
	const stale = await OAuthNeedsRefresh_async(cur.expires ?? null, nowMs);
	if (!stale) return null;
	const n = await loginBoardIndex(providerId);
	return login_expired_notice(providerId, n ?? 0);
}

function clickHint(): string {
	return process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
}

export class LoginDialog {
	readonly providerId: string;
	readonly providerName: string;
	readonly boardIndex: number | null;
	private readonly writer: LoginDialogWriter;
	private readonly prompter: LoginDialogPrompter;
	private readonly aborter = new AbortController();
	private countdown: CountdownTimer | undefined;
	private done = false;
	private onComplete: (success: boolean) => void = () => {};

	constructor(providerId: string, opts: LoginDialogOptions = {}) {
		this.providerId = providerId;
		this.providerName = opts.providerName ?? providerId;
		this.boardIndex = opts.boardIndex ?? null;
		this.writer = opts.writer ?? consoleDialogWriter();
		this.prompter = opts.prompter ?? defaultDialogPrompter;
	}

	get signal(): AbortSignal {
		return this.aborter.signal;
	}

	get settled(): boolean {
		return this.done;
	}

	private rule(): string {
		return new DynamicBorder().render(termWidth()).join("\n");
	}

	// Frame header: title + deep-link hint (pi's titleOverride position).
	showFrame(): void {
		this.writer.print(this.rule());
		this.writer.print(login_dialog_title(this.providerName));
		if (this.boardIndex !== null) this.writer.print(login_row_hint(this.providerId, this.boardIndex));
	}

	// pi showAuth: URL + instructions, browser hint. No countdown: the
	// authorize URL does not expire on a device-code window.
	showAuth(url: string, instructions?: string): void {
		this.writer.print(login_auth_url_block(url, clickHint()));
		if (instructions) this.writer.print(instructions);
	}

	// pi showDeviceCode + ExtensionInput countdown: the code block, then a
	// live `Waiting for authentication (Ns)` line; expiry cancels the
	// login exactly like Esc (pi's onExpire → onCancel).
	showDeviceCode(notice: DeviceCodeNotice): void {
		this.writer.print(login_device_block(notice.verificationUri, notice.userCode));
		const total = notice.expiresInSeconds ?? null;
		if (total !== null) this.writer.print(`Code expires in ${total}s.`);
		this.writer.print(login_waiting_line());
		if (total === null || total <= 0) return;
		this.countdown?.dispose();
		this.countdown = new CountdownTimer(
			total * 1000,
			undefined,
			(s) => this.writer.live?.(countdown_label("Waiting for authentication", s)),
			() => this.cancel(),
		);
	}

	showProgress(message: string): void {
		this.writer.print(message);
	}

	// pi showPrompt/manual-code: modal on TTY, readline on pipes. Esc or
	// abort resolves null here and rejects as "Login cancelled" — the
	// same rejection pi's abort races produce.
	showPrompt(message: string, placeholder?: string): Promise<string> {
		return this.prompter(message, placeholder, this.signal).then((value) => {
			if (value === null || this.signal.aborted) throw new Error("Login cancelled");
			return value.trim();
		});
	}

	// Silent teardown: dispose the tick source, drop the abort gate,
	// mark done. Non-cancel failures take this path — the caller owns
	// the error surface (pi's showError), the dialog must not print a
	// "cancelled" line for a network failure.
	private finish(success: boolean): void {
		if (this.done) return;
		this.done = true;
		this.countdown?.dispose();
		this.countdown = undefined;
		if (!this.aborter.signal.aborted) this.aborter.abort();
		this.onComplete(success);
	}

	// Pi's cancel: Esc / expiry / abort. Prints the cancelled line and
	// funnels every exit through the same "Login cancelled" rejection
	// the OAuth polling loop already honors.
	cancel(): void {
		if (this.done) return;
		this.finish(false);
		this.writer.print(login_cancelled_line(this.providerName));
	}

	// Adapter: the dialog IS an OAuthInteraction, so any registered flow
	// runs unmodified — resolveFlowLogin(flow)(flow, dialog.asInteraction()).
	asInteraction(): OAuthInteraction {
		return {
			signal: this.signal,
			notify: (n) => {
				if (this.done) return;
				if (n.type === "auth_url") this.showAuth(n.url, n.instructions);
				else if (n.type === "device_code") this.showDeviceCode(n);
				else this.showProgress(n.message);
			},
			prompt: (message, placeholder) => this.showPrompt(message, placeholder),
		};
	}

	// Run one interactive login to completion. preNotice carries the
	// bi#102 stale-row line when this is a refresh (printed inside the
	// frame, after the title). Esc/expiry/abort reject as "Login
	// cancelled" with the cancelled line printed; other failures tear
	// down silently and propagate (caller reports them). Either way the
	// REPL history is untouched — returning IS pi's restoreEditor here.
	async run(
		login: (flow: OAuthFlow, interaction: OAuthInteraction) => Promise<Credential>,
		preNotice?: string | null,
	): Promise<Credential> {
		// bi#162: one lease for the whole dialog — device-code waits
		// re-prompt through one shared host, not one terminal per ask.
		retainReplTui();
		try {
			return await this.runInner(login, preNotice);
		} finally {
			await releaseReplTui();
		}
	}
	private async runInner(
		login: (flow: OAuthFlow, interaction: OAuthInteraction) => Promise<Credential>,
		preNotice?: string | null,
	): Promise<Credential> {
		this.showFrame();
		if (preNotice) this.showProgress(preNotice);
		try {
			const cred = await login(getOAuthFlow(this.providerId)!, this.asInteraction());
			this.finish(true);
			this.writer.print(login_success_line(this.providerName));
			return cred;
		} catch (e) {
			if (this.signal.aborted || (e instanceof Error && e.message === "Login cancelled")) this.cancel();
			else this.finish(false);
			throw e;
		}
	}

	// Every unmount path (submit / Esc / success / expiry) must dispose
	// the interval — a live timer after return is a stray-tick bug.
	dispose(): void {
		this.countdown?.dispose();
		this.countdown = undefined;
	}
}

// Consumer-ready entry for the merger's /login wiring (cli.ts, OUT of
// scope): resolves the registered OAuth flow, pre-flights the bi#102
// stale row, runs the dialog, and returns the Credential for the caller
// to persist via modifyCredential. API-key-only providers refuse with
// the `bi login <id>` fix, mirroring runOAuthLogin.
export async function runLoginDialog(providerId: string, opts: LoginDialogOptions = {}): Promise<Credential> {
	const flow = getOAuthFlow(providerId);
	if (!flow) {
		throw new LoginDialogError(
			`No OAuth flow registered for ${providerId} yet — run \`bi login ${providerId}\` to store an API key`,
		);
	}
	const now = (opts.now ?? Date.now)();
	const dialog = new LoginDialog(
		providerId,
		opts.boardIndex !== undefined ? opts : { ...opts, boardIndex: await loginBoardIndex(providerId) },
	);
	const notice = await loginExpiredNotice(providerId, now);
	const login = opts.login ?? ((f, i) => resolveFlowLogin(f)(f, i));
	return dialog.run(login, notice);
}

// Re-export for the merger: the board rows this dialog deep-links into.
export { listCredentials };
