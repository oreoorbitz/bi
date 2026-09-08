package main

// tui-go — Bubble Tea v2 TUI shell spike over the JSON-RPC/NDJSON seam
// (bi#187). Zero coupling to bi/src: the host side today is
// fixture/emit.mjs.
//
// Usage:
//
//	go build -o bin/tui . && node fixture/emit.mjs | ./bin/tui > /dev/null
//	./bin/tui --events session.ndjson --out back.ndjson --debug-log dbg.ndjson
//	./bin/tui   (interactive-only, no seam)
//
// The UI always renders on the controlling terminal (/dev/tty); stdio stays
// free for the seam. See README.md for the wire shapes.

import (
	"flag"
	"fmt"
	"os"
	"strconv"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/term"
)

func main() {
	eventsPath := flag.String("events", "", "seam input: NDJSON file (precedence: fd 3 > --events > stdin)")
	outPath := flag.String("out", "", "seam back-channel: NDJSON file (precedence: fd 4 > --out > stdout)")
	debugPath := flag.String("debug-log", "", "internal-event NDJSON log for the pty drills")
	flag.Parse()

	debug, err := openDebugLog(*debugPath)
	if err != nil {
		fatal(err)
	}
	defer debug.close()

	seam, err := openSeam(*eventsPath, *outPath,
		term.IsTerminal(os.Stdin.Fd()), term.IsTerminal(os.Stdout.Fd()))
	if err != nil {
		fatal(err)
	}
	defer seam.close()
	debug.log("seam_open", map[string]any{"in": seam.inName, "out": seam.outName})

	// The TUI always lives on the controlling terminal, never on stdio —
	// stdio is the seam. Fails loudly when there is no terminal.
	tty, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		fatal(fmt.Errorf("no controlling terminal (/dev/tty): %w — run under a tty/pty", err))
	}
	defer tty.Close()

	// SSH-aware escape-sequence reassembly (see seqreader.go for the
	// evidence). TUI_GO_SEQ_TIMEOUT_MS=0 disables it — that toggle is the
	// split-csi drill's red-check hunk.
	seqWindow := defaultSeqWindow
	if v := os.Getenv("TUI_GO_SEQ_TIMEOUT_MS"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			fatal(fmt.Errorf("TUI_GO_SEQ_TIMEOUT_MS=%q: not a non-negative integer", v))
		}
		seqWindow = time.Duration(n) * time.Millisecond
	}

	// IMPORTANT: bubbletea hands p.input to uv.NewCancelReader, which for
	// non-*os.File readers spawns a fallback goroutine that READS AHEAD,
	// unbuffered, and DISCARDS the bytes on cancellation (verified in
	// x/exp/cancelreader + observed in the split-csi drill: our wrapped
	// input lost every keystroke after the first held sequence). A
	// pass-through *os.File keeps the fd-based (kqueue) cancelreader path
	// and loses nothing.
	var ttyIn *os.File = tty
	if seqWindow > 0 {
		// bubbletea only enters raw mode when its input is a terminal —
		// our pipe is not, so WE must own raw mode here (verified: with a
		// pipe input and no raw mode, the pty stayed canonical+echo+ICRNL:
		// input echoed into the footer, line-buffered until CR, and CR
		// arrived as LF so Enter never matched).
		state, err := term.MakeRaw(tty.Fd())
		if err != nil {
			fatal(fmt.Errorf("seqreader: raw mode on /dev/tty: %w", err))
		}
		defer term.Restore(tty.Fd(), state) //nolint:errcheck
		ttyIn = newSeqReaderTTY(tty, seqWindow)
		defer ttyIn.Close()
		debug.log("seqreader", map[string]any{"window_ms": seqWindow.Milliseconds()})
	} else {
		debug.log("seqreader", map[string]any{"disabled": true})
	}

	var seamCh <-chan seamEvent
	if seam.in != nil {
		ch := make(chan seamEvent, 64)
		go readSeam(seam.in, ch)
		seamCh = ch
	}

	model := newRootModel(seam, seamCh, debug)
	program := tea.NewProgram(
		model,
		tea.WithInput(ttyIn),
		tea.WithOutput(tty),
	)
	// Back-reference for program.Println scrollback commits; model is a
	// pointer, so the program's stored model observes this.
	model.program = program

	if _, err := program.Run(); err != nil {
		fatal(fmt.Errorf("bubbletea: %w", err))
	}
	debug.log("exit", map[string]any{"ok": true})
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "tui-go:", err)
	os.Exit(1)
}
