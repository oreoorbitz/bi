// drills — pty input drills for the bi#187 spike, ported from the
// proposals/14 drill family. Run from bi/tui-go:
//
//	go run ./drills all
//
// Each drill spawns the real tui binary on a fresh pty (creack/pty), with
// the seam wired through ExtraFiles: child fd 3 = seam-in, fd 4 =
// back-channel. Assertions read three witnesses: the raw pty byte stream,
// the back-channel NDJSON, and the tui's --debug-log NDJSON.
//
// Red-check records (bi#57 — each safety net was reverted once and the
// drill observed failing FOR THE RIGHT REASON; see NOTES.md for the full
// observed outputs):
//
//	split-csi hunk: env TUI_GO_SEQ_TIMEOUT_MS=0 (main.go seqreader wiring —
//	  disables our reassembly layer, restoring upstream's 50ms window).
//	  Observed: FAIL `submit text: got "3uhi" want "hi" (split CSI-u
//	  leaked as text)` + FAIL `no key_release debug event`.
//	paste hunk: model.go `case tea.PasteMsg:` — drop the message instead of
//	  routing it to the textarea. Observed: FAIL `no input/submit after
//	  paste within 5s` (empty textarea submits nothing).
//	sigwinch hunk A: model.go `case tea.WindowSizeMsg:` — remove the
//	  m.layout() call. Observed: FAIL `components not re-laid-out after
//	  SIGWINCH: viewport width 0 ≠ 60` + FAIL `committed turn result
//	  missing from pty stream after resize` (downstream consequence).
//	sigwinch hunk B: model.go `View()` — remove the clampLines calls (the
//	  width enforcement itself). Observed: FAIL `torn row after SIGWINCH:
//	  rendered line width 70 > 60 cols` + FAIL `layout self-check failed
//	  after SIGWINCH (footerOk=false)`. (Hunk A alone was camouflage
//	  before the vpWidth net existed — clamped View masked it.)
//	session hunk: model.go `case "footer/frame":` — disable the case.
//	  Observed: FAIL `footer never showed "claude-sonnet-4.5" from data
//	  payload` + FAIL `footer never showed "thinking:high" ...` + FAIL
//	  `final footer/frame (tokensIn=12987) never processed`.

package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"sync"
	"time"

	"github.com/creack/pty"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: go run ./drills <split-csi|paste|sigwinch|session|all>")
		os.Exit(2)
	}
	if _, err := os.Stat("go.mod"); err != nil {
		fmt.Fprintln(os.Stderr, "drills: run from bi/tui-go (go.mod not found)")
		os.Exit(2)
	}

	names := []string{os.Args[1]}
	if os.Args[1] == "all" {
		names = []string{"split-csi", "paste", "sigwinch", "session"}
	}
	bin, cleanup, err := buildTUI()
	if err != nil {
		fail("build", err.Error())
	}
	defer cleanup()

	failed := 0
	for _, n := range names {
		start := time.Now()
		var errs []string
		switch n {
		case "split-csi":
			errs = drillSplitCSI(bin)
		case "paste":
			errs = drillPaste(bin)
		case "sigwinch":
			errs = drillSigwinch(bin)
		case "session":
			errs = drillSession(bin)
		default:
			fmt.Fprintf(os.Stderr, "drills: unknown drill %q\n", n)
			os.Exit(2)
		}
		if len(errs) == 0 {
			fmt.Printf("PASS %s (%s)\n", n, time.Since(start).Round(time.Millisecond))
		} else {
			failed++
			for _, e := range errs {
				fmt.Printf("FAIL %s: %s\n", n, e)
			}
		}
	}
	if failed > 0 {
		os.Exit(1)
	}
}

func fail(where, what string) {
	fmt.Fprintf(os.Stderr, "FAIL %s: %s\n", where, what)
	os.Exit(1)
}

func buildTUI() (string, func(), error) {
	tmp, err := os.MkdirTemp("", "tui-go-drill-*")
	if err != nil {
		return "", nil, err
	}
	bin := tmp + "/tui"
	cmd := exec.Command("go", "build", "-o", bin, ".")
	if out, err := cmd.CombinedOutput(); err != nil {
		os.RemoveAll(tmp)
		return "", nil, fmt.Errorf("go build: %v\n%s", err, out)
	}
	return bin, func() { os.RemoveAll(tmp) }, nil
}

// rig is one spawned tui under test.
type rig struct {
	cmd   *exec.Cmd
	ptmx  *os.File
	seamW *os.File // drill → tui fd 3
	backC chan map[string]any

	mu        sync.Mutex
	pty       bytes.Buffer
	drainDone chan struct{} // closed when the pty capture goroutine hits EOF

	dbgPath string
}

func spawnRig(bin string, rows, cols uint16) (*rig, error) {
	tmp, err := os.MkdirTemp("", "tui-go-rig-*")
	if err != nil {
		return nil, err
	}
	r := &rig{dbgPath: tmp + "/debug.ndjson", backC: make(chan map[string]any, 64), drainDone: make(chan struct{})}

	inR, inW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	outR, outW, err := os.Pipe()
	if err != nil {
		return nil, err
	}

	r.cmd = exec.Command(bin, "--debug-log", r.dbgPath)
	r.cmd.ExtraFiles = []*os.File{inR, outW} // child fd 3, fd 4
	r.ptmx, err = pty.StartWithSize(r.cmd, &pty.Winsize{Rows: rows, Cols: cols})
	// Parent ends: keep inW (seam writer) and outR (back-channel reader).
	inR.Close()
	outW.Close()
	if err != nil {
		inW.Close()
		outR.Close()
		return nil, fmt.Errorf("pty start: %w", err)
	}
	r.seamW = inW

	go func() { // capture every pty byte; closes drainDone at EOF/EIO
		defer close(r.drainDone)
		var buf [4096]byte
		for {
			n, err := r.ptmx.Read(buf[:])
			if n > 0 {
				r.mu.Lock()
				r.pty.Write(buf[:n])
				r.mu.Unlock()
			}
			if err != nil {
				return
			}
		}
	}()

	go func() { // back-channel NDJSON
		sc := bufio.NewScanner(outR)
		sc.Buffer(make([]byte, 0, 1<<20), 1<<20)
		for sc.Scan() {
			var m map[string]any
			if err := json.Unmarshal(sc.Bytes(), &m); err == nil {
				r.backC <- m
			}
		}
		close(r.backC)
	}()

	return r, nil
}

func (r *rig) output() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.pty.String()
}

func (r *rig) sendSeam(v map[string]any) {
	b, _ := json.Marshal(v)
	r.seamW.Write(append(b, '\n'))
}

func (r *rig) typeKeys(s string) { r.ptmx.WriteString(s) }

func (r *rig) debugEvents() []map[string]any {
	f, err := os.Open(r.dbgPath)
	if err != nil {
		return nil
	}
	defer f.Close()
	var out []map[string]any
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1<<20), 1<<20)
	for sc.Scan() {
		var m map[string]any
		if json.Unmarshal(sc.Bytes(), &m) == nil {
			out = append(out, m)
		}
	}
	return out
}

func (r *rig) countDebug(eventType string) int {
	n := 0
	for _, e := range r.debugEvents() {
		if e["type"] == eventType {
			n++
		}
	}
	return n
}

func (r *rig) findDebug(eventType string, match func(map[string]any) bool) map[string]any {
	for _, e := range r.debugEvents() {
		if e["type"] == eventType && (match == nil || match(e)) {
			return e
		}
	}
	return nil
}

// waitDebug polls the debug log until an event matches or the timeout
// elapses.
func (r *rig) waitDebug(eventType string, match func(map[string]any) bool, timeout time.Duration) map[string]any {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if e := r.findDebug(eventType, match); e != nil {
			return e
		}
		time.Sleep(50 * time.Millisecond)
	}
	return nil
}

func (r *rig) waitBack(timeout time.Duration) (map[string]any, bool) {
	select {
	case m, ok := <-r.backC:
		if !ok {
			return nil, false
		}
		return m, true
	case <-time.After(timeout):
		return nil, false
	}
}

func (r *rig) waitBackWhere(timeout time.Duration, match func(map[string]any) bool) (map[string]any, bool) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		m, ok := r.waitBack(time.Until(deadline))
		if !ok {
			return nil, false
		}
		if match(m) {
			return m, true
		}
	}
	return nil, false
}

// shutdown asks the tui to quit (ctrl+c), falling back to seam EOF
// (the scripted quit path), then SIGKILL — each step named.
func (r *rig) shutdown(timeout time.Duration) error {
	done := make(chan error, 1)
	go func() { done <- r.cmd.Wait() }()
	select {
	case err := <-done:
		r.waitDrain()
		return err
	case <-time.After(2 * time.Second):
		r.typeKeys("\x03") // ctrl+c
	}
	select {
	case err := <-done:
		r.waitDrain()
		return err
	case <-time.After(3 * time.Second):
		r.seamW.Close() // EOF → commit + quit path
	}
	select {
	case err := <-done:
		r.waitDrain()
		return err
	case <-time.After(timeout):
		r.cmd.Process.Kill()
		<-done
		r.waitDrain()
		return fmt.Errorf("tui did not exit within %s (ctrl+c AND seam EOF both failed)", timeout)
	}
}

func (r *rig) waitExit(timeout time.Duration) error {
	done := make(chan error, 1)
	go func() { done <- r.cmd.Wait() }()
	select {
	case err := <-done:
		r.waitDrain()
		return err
	case <-time.After(timeout):
		r.cmd.Process.Kill()
		<-done
		r.waitDrain()
		return fmt.Errorf("tui did not exit within %s", timeout)
	}
}

// waitDrain blocks until the pty capture goroutine has consumed the final
// bytes (child exit → master reads EIO once the buffer is empty). Without
// this, post-exit assertions on r.output() race the capture goroutine —
// observed as flaky "committed turn result missing" failures.
func (r *rig) waitDrain() {
	select {
	case <-r.drainDone:
	case <-time.After(2 * time.Second):
	}
}

// --- assertions --------------------------------------------------------------

var (
	ansiRe    = regexp.MustCompile("\x1b(?:\\[[0-9;?]*[ -/]*[@-~]|\\][^\x07\x1b]*(?:\x07|\x1b\\\\)|[()][0-2]|[@-Z\\-_])")
	decstbmRe = regexp.MustCompile("\x1b\\[[0-9]*;[0-9]*r")
)

func stripANSI(s string) string { return ansiRe.ReplaceAllString(s, "") }

func noForbiddenSequences(name, out string) []string {
	var errs []string
	if decstbmRe.MatchString(out) {
		errs = append(errs, name+": DECSTBM (CSI Pt;Pb r) emitted — scroll regions are banned")
	}
	if bytes.Contains([]byte(out), []byte("\x1b[?1049h")) {
		errs = append(errs, name+": alt-screen entered — scrollback must survive by construction")
	}
	return errs
}

// --- drills ------------------------------------------------------------------

// split-csi: a kitty CSI-u release split across a 120ms SSH-style delay
// must type NOTHING (proposals/14 class: pi-tui leaked "3u" into the
// editor at >50ms; ultraviolet has the same 50ms window — seqreader.go is
// the layer under test here). The submit that follows must be exactly the
// typed text.
func drillSplitCSI(bin string) []string {
	r, err := spawnRig(bin, 24, 80)
	if err != nil {
		return []string{err.Error()}
	}
	var errs []string

	if r.waitDebug("resize", nil, 5*time.Second) == nil {
		errs = append(errs, "no initial resize/ready within 5s")
	}

	r.typeKeys("\x1b[111;1:")          // first half of kitty release ESC[111;1:3u
	time.Sleep(120 * time.Millisecond) // past ultraviolet's 50ms window; inside seqReader's 250ms
	r.typeKeys("3u")                   // second half
	time.Sleep(150 * time.Millisecond)

	r.typeKeys("hi")
	time.Sleep(80 * time.Millisecond)
	r.typeKeys("\r")

	msg, ok := r.waitBackWhere(5*time.Second, func(m map[string]any) bool {
		return m["method"] == "input/submit"
	})
	if !ok {
		errs = append(errs, "no input/submit on back-channel within 5s")
	} else {
		params, _ := msg["params"].(map[string]any)
		got, _ := params["text"].(string)
		if got != "hi" {
			errs = append(errs, fmt.Sprintf("submit text: got %q want %q (split CSI-u leaked as text)", got, "hi"))
		}
	}
	if r.waitDebug("key_release", nil, time.Second) == nil {
		errs = append(errs, "no key_release debug event — CSI-u release was not parsed as a release")
	}

	if werr := r.shutdown(5 * time.Second); werr != nil {
		errs = append(errs, "shutdown: "+werr.Error())
	}
	errs = append(errs, noForbiddenSequences("split-csi", r.output())...)
	return errs
}

// paste: a 200-line bracketed paste, delivered in three chunks, is exactly
// one PasteMsg — no paste-burst heuristic — and submits intact.
func drillPaste(bin string) []string {
	r, err := spawnRig(bin, 24, 80)
	if err != nil {
		return []string{err.Error()}
	}
	var errs []string

	r.waitDebug("resize", nil, 5*time.Second)

	var block bytes.Buffer
	for i := 1; i <= 200; i++ {
		fmt.Fprintf(&block, "paste-line-%03d", i)
		if i < 200 {
			block.WriteByte('\n')
		}
	}
	text := block.String()
	third := len(text) / 3

	r.typeKeys("\x1b[200~" + text[:third])
	time.Sleep(30 * time.Millisecond)
	r.typeKeys(text[third : 2*third])
	time.Sleep(30 * time.Millisecond)
	r.typeKeys(text[2*third:] + "\x1b[201~")

	pasteEv := r.waitDebug("paste", nil, 5*time.Second)
	if pasteEv == nil {
		errs = append(errs, "no paste debug event within 5s")
	} else if lines, _ := pasteEv["lines"].(float64); int(lines) != 200 {
		errs = append(errs, fmt.Sprintf("paste lines: got %v want 200", pasteEv["lines"]))
	}
	if n := r.countDebug("paste"); n != 1 {
		errs = append(errs, fmt.Sprintf("paste events: got %d want exactly 1 (chunked delivery must coalesce)", n))
	}

	time.Sleep(150 * time.Millisecond)
	r.typeKeys("\r")
	msg, ok := r.waitBackWhere(5*time.Second, func(m map[string]any) bool {
		return m["method"] == "input/submit"
	})
	if !ok {
		errs = append(errs, "no input/submit after paste within 5s")
	} else {
		params, _ := msg["params"].(map[string]any)
		got, _ := params["text"].(string)
		if got != text {
			errs = append(errs, fmt.Sprintf("submit text mismatch after paste: got %d chars want %d", len(got), len(text)))
		}
	}

	if werr := r.shutdown(5 * time.Second); werr != nil {
		errs = append(errs, "shutdown: "+werr.Error())
	}
	errs = append(errs, noForbiddenSequences("paste", r.output())...)
	return errs
}

// sigwinch: resize (shrink) mid-stream; the repaint must honor the new
// geometry with no torn rows, and the session must still commit cleanly.
func drillSigwinch(bin string) []string {
	r, err := spawnRig(bin, 24, 80)
	if err != nil {
		return []string{err.Error()}
	}
	var errs []string

	r.waitDebug("resize", nil, 5*time.Second)
	r.sendSeam(map[string]any{"method": "footer/frame", "params": map[string]any{
		"provider": "anthropic", "model": "sigwinch-probe", "thinking": "high",
		"tokensIn": 1, "tokensOut": 2, "cwd": "/tmp",
	}})

	// Stream 60 paced deltas; shrink the pty partway through.
	go func() {
		for i := 1; i <= 60; i++ {
			r.sendSeam(map[string]any{"method": "assistant/delta", "params": map[string]any{
				"text": fmt.Sprintf("tok-%02d ", i),
			}})
			time.Sleep(25 * time.Millisecond)
		}
		r.sendSeam(map[string]any{"method": "turn/result", "params": map[string]any{
			"markdown": "# SIGWINCH-PROBE-HEADING\n\nstream survived the resize",
		}})
		r.seamW.Close() // EOF → commit + quit
	}()

	time.Sleep(375 * time.Millisecond) // ~15 deltas in
	if err := pty.Setsize(r.ptmx, &pty.Winsize{Rows: 30, Cols: 60}); err != nil {
		errs = append(errs, "Setsize: "+err.Error())
	}

	// The model self-checks its layout invariant on every resize (no
	// rendered line wider than the terminal). Byte-stream line lengths
	// are NOT a valid witness — the cell-diffed renderer uses absolute
	// cursor addressing, so stripped fragments splice.
	resizeEv := r.waitDebug("resize", func(ev map[string]any) bool {
		w, _ := ev["width"].(float64)
		return int(w) == 60
	}, 5*time.Second)
	if resizeEv == nil {
		errs = append(errs, "no resize(width=60) debug event within 5s")
	} else {
		if mw, _ := resizeEv["maxLineWidth"].(float64); int(mw) > 60 {
			errs = append(errs, fmt.Sprintf("torn row after SIGWINCH: rendered line width %v > 60 cols", resizeEv["maxLineWidth"]))
		}
		if vw, _ := resizeEv["vpWidth"].(float64); int(vw) != 60 {
			errs = append(errs, fmt.Sprintf("components not re-laid-out after SIGWINCH: viewport width %v ≠ 60", resizeEv["vpWidth"]))
		}
		if ok, _ := resizeEv["footerOk"].(bool); !ok {
			errs = append(errs, "layout self-check failed after SIGWINCH (footerOk=false)")
		}
	}

	if werr := r.waitExit(15 * time.Second); werr != nil {
		errs = append(errs, "exit: "+werr.Error())
	}

	out := r.output()
	if !bytes.Contains([]byte(out), []byte("SIGWINCH-PROBE-HEADING")) {
		errs = append(errs, "committed turn result missing from pty stream after resize")
	}
	if r.countDebug("commit") < 1 {
		errs = append(errs, "no commit debug event — turn result never reached scrollback")
	}
	errs = append(errs, noForbiddenSequences("sigwinch", out)...)
	return errs
}

// session: the real fixture emitter end-to-end — incremental streaming,
// ticking spinner, footer from data, modal picker answered on the
// back-channel, scrollback commit. This is the bi#187 acceptance drill.
func drillSession(bin string) []string {
	r, err := spawnRig(bin, 30, 90)
	if err != nil {
		return []string{err.Error()}
	}
	var errs []string

	// Wire the node emitter between the seam pipes: emitter stdout → tui
	// fd 3, tui fd 4 → emitter stdin.
	emit := exec.Command("node", "fixture/emit.mjs", "--picker-timeout-ms=20000")
	emit.Stdout = r.seamW
	var emitErr bytes.Buffer
	emit.Stderr = &emitErr
	emitInR, emitInW, err := os.Pipe()
	if err != nil {
		return []string{err.Error()}
	}
	emit.Stdin = emitInR
	if err := emit.Start(); err != nil {
		return []string{"start emitter: " + err.Error()}
	}
	// The emitter now holds the seam-in write end; the parent must drop
	// its copy or the tui never sees EOF when the emitter exits.
	r.seamW.Close()
	emitDone := make(chan error, 1)
	go func() { emitDone <- emit.Wait() }()
	// tee the tui back-channel into the emitter's stdin
	teeDone := make(chan struct{})
	go func() {
		defer close(teeDone)
		for m := range r.backC {
			b, _ := json.Marshal(m)
			if _, err := emitInW.Write(append(b, '\n')); err != nil {
				return
			}
		}
	}()

	// 1. Wait for streaming to start (event-anchored, not wall-clock).
	if r.waitDebug("agent_event", func(ev map[string]any) bool {
		return ev["label"] == "Reading session files"
	}, 10*time.Second) == nil {
		errs = append(errs, "streaming never started (no 'Reading session files' status)")
		return errs
	}

	// 2. User input round-trips on the back-channel (typed long before
	//    the picker opens; the submit event gates the next step so a
	//    missed keystroke fails HERE with a named reason, not downstream).
	r.typeKeys("hello seam")
	time.Sleep(80 * time.Millisecond)
	r.typeKeys("\r")
	if r.waitDebug("submit", nil, 5*time.Second) == nil {
		errs = append(errs, "typed input never produced a submit event")
	}

	// 4. Picker: wait for it to open, move to the 2nd item, select it.
	if r.waitDebug("picker_open", nil, 15*time.Second) == nil {
		errs = append(errs, "picker never opened")
	} else {
		time.Sleep(300 * time.Millisecond)
		r.typeKeys("\x1b[B") // down
		time.Sleep(250 * time.Millisecond)
		r.typeKeys("\r") // enter
	}

	// 5. Emitter must finish (its picker wait satisfied by our answer).
	select {
	case err := <-emitDone:
		if err != nil {
			errs = append(errs, "emitter exit: "+err.Error())
		}
	case <-time.After(30 * time.Second):
		emit.Process.Kill()
		errs = append(errs, "emitter did not finish within 30s (picker answer never arrived?)")
	}
	emitLog := emitErr.String()
	if !bytes.Contains([]byte(emitLog), []byte(`"itemId":"run-drills"`)) {
		errs = append(errs, fmt.Sprintf("picker answer wrong/missing on back-channel; emitter log: %.200q", emitLog))
	}
	if !bytes.Contains([]byte(emitLog), []byte(`input/submit: "hello seam"`)) {
		errs = append(errs, fmt.Sprintf("input/submit missing on back-channel; emitter log: %.200q", emitLog))
	}

	// 6. EOF on the seam → tui commits and exits 0.
	if werr := r.waitExit(10 * time.Second); werr != nil {
		errs = append(errs, "exit: "+werr.Error())
	}
	emitInW.Close()
	<-teeDone

	out := r.output()
	plain := stripANSI(out)

	// 7. Incremental streaming: many delta events with strictly growing
	//    totals (each delta individually processed + rendered). Byte-
	//    stream substring checks are NOT valid here — the cell-diffed
	//    renderer interleaves fragments.
	var totals []int
	for _, e := range r.debugEvents() {
		if e["type"] == "delta" {
			t, _ := e["total"].(float64)
			totals = append(totals, int(t))
		}
	}
	if len(totals) < 5 {
		errs = append(errs, fmt.Sprintf("incremental streaming: only %d delta events (want ≥5)", len(totals)))
	} else {
		for i := 1; i < len(totals); i++ {
			if totals[i] <= totals[i-1] {
				errs = append(errs, fmt.Sprintf("delta totals not strictly increasing at %d: %v", i, totals))
				break
			}
		}
	}

	// 8. Spinner ticking: frames from bubbles' Dot spinner appear in the
	//    byte stream (Dot = ⣾⣽⣻⢿⡿⣟⣯⣷, NOT the ⠋⠙⠹ cli-spinners set).
	spinSeen := false
	for _, f := range []string{"⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"} {
		if bytes.Contains([]byte(out), []byte(f)) {
			spinSeen = true
			break
		}
	}
	if !spinSeen {
		errs = append(errs, "no Dot spinner frames in pty stream")
	}

	// 8. Footer from the data payload: stable screen fragments (rendered
	//    atomically) on the byte stream, full field check on the debug
	//    log — the cell-diffed renderer splits updated cells, so a long
	//    contiguous substring like "↑12987 ↓643" is not a valid witness.
	for _, want := range []string{"claude-sonnet-4.5", "thinking:high"} {
		if !bytes.Contains([]byte(plain), []byte(want)) {
			errs = append(errs, fmt.Sprintf("footer never showed %q from data payload", want))
		}
	}
	if r.findDebug("footer", func(ev map[string]any) bool {
		ti, _ := ev["tokensIn"].(float64)
		return ev["model"] == "claude-sonnet-4.5" && int64(ti) == 12987
	}) == nil {
		errs = append(errs, "final footer/frame (tokensIn=12987) never processed")
	}

	// 9. Scrollback: committed turn result + tool lines + user echo all
	//    present in the raw pty stream, with no DECSTBM / alt-screen.
	for _, want := range []string{"Turn summary", "110 passed", "> hello seam"} {
		if !bytes.Contains([]byte(plain), []byte(want)) {
			errs = append(errs, fmt.Sprintf("scrollback missing %q", want))
		}
	}
	if r.countDebug("commit") < 1 {
		errs = append(errs, "no commit debug events — transcript never reached scrollback")
	}
	errs = append(errs, noForbiddenSequences("session", out)...)
	if len(errs) > 0 {
		p := os.TempDir() + "/tui-go-session-fail.bin"
		if werr := os.WriteFile(p, []byte(out), 0o644); werr == nil {
			errs = append(errs, "pty capture dumped to "+p)
		}
	}
	return errs
}
