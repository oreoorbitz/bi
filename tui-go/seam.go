package main

// seam.go — the JSON-RPC-over-NDJSON seam between a host (bi's future TS
// host, today the fixture emitter) and this Bubble Tea UI.
//
// Shapes are the protocol draft for bi#188; README.md is the human copy.
// Six channels:
//   host→UI notifications: agent/event, assistant/delta, tool/start,
//                          tool/done, turn/result, footer/frame
//   host→UI request:       picker/open   (answered on the back-channel)
//   UI→host notification:  input/submit
//   UI→host responses:     {id, result} / {id, error} for picker/open

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sync"
)

const seamVersion = "2.0"

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type envelope struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      *int64          `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type agentEventParams struct {
	Kind  string `json:"kind"` // spinner_start | spinner_stop | status
	Label string `json:"label"`
}

type deltaParams struct {
	Text string `json:"text"`
}

type toolStartParams struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Summary string `json:"summary"`
}

type toolDoneParams struct {
	ID   string `json:"id"`
	OK   bool   `json:"ok"`
	Line string `json:"line"`
}

type turnResultParams struct {
	Markdown string `json:"markdown"`
}

type footerFrameParams struct {
	Provider  string `json:"provider"`
	Model     string `json:"model"`
	Thinking  string `json:"thinking"`
	TokensIn  int64  `json:"tokensIn"`
	TokensOut int64  `json:"tokensOut"`
	CWD       string `json:"cwd"`
	// bi#188: the real host (bi/src/tui_seam.ts) carries turn/message
	// counts and the git branch — render_footer_frame's data — rather
	// than token totals. Additive optional fields; the bi#187 fixture's
	// token fields keep working unchanged.
	Turn     *int64 `json:"turn,omitempty"`
	Messages *int64 `json:"messages,omitempty"`
	Branch   string `json:"branch,omitempty"`
}

type pickerItem struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description"`
}

type pickerOpenParams struct {
	Title string       `json:"title"`
	Items []pickerItem `json:"items"`
}

type submitParams struct {
	Text string `json:"text"`
}

type pickerResult struct {
	ItemID string `json:"itemId"`
	Label  string `json:"label"`
}

// seamEvent is one parsed inbound line (or a transport/parse failure —
// failures are surfaced to the model, never dropped silently, bi#55).
type seamEvent struct {
	env envelope
	err error
	eof bool
}

// readSeam scans NDJSON lines from r and forwards them on ch until EOF or
// unrecoverable read error, then emits exactly one {eof:true} sentinel.
func readSeam(r io.Reader, ch chan<- seamEvent) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 1<<20), 1<<20)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var env envelope
		if err := json.Unmarshal(line, &env); err != nil {
			ch <- seamEvent{err: fmt.Errorf("seam: bad NDJSON line: %w", err)}
			continue
		}
		ch <- seamEvent{env: env}
	}
	if err := sc.Err(); err != nil {
		ch <- seamEvent{err: fmt.Errorf("seam: read error: %w", err)}
	}
	ch <- seamEvent{eof: true}
}

// seamWriter serializes back-channel writes (UI goroutine only, but the
// mutex keeps it safe if that ever changes).
type seamWriter struct {
	mu  sync.Mutex
	w   io.Writer
	err error
}

func newSeamWriter(w io.Writer) *seamWriter { return &seamWriter{w: w} }

func (s *seamWriter) send(env envelope) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return s.err
	}
	env.JSONRPC = seamVersion
	b, err := json.Marshal(env)
	if err != nil {
		return fmt.Errorf("seam: marshal: %w", err)
	}
	if _, err := s.w.Write(append(b, '\n')); err != nil {
		s.err = fmt.Errorf("seam: back-channel write failed: %w", err)
		return s.err
	}
	return nil
}

func (s *seamWriter) submit(text string) error {
	p, _ := json.Marshal(submitParams{Text: text})
	return s.send(envelope{Method: "input/submit", Params: p})
}

func (s *seamWriter) pickerChoice(id int64, it pickerItem) error {
	r, _ := json.Marshal(pickerResult{ItemID: it.ID, Label: it.Label})
	return s.send(envelope{ID: &id, Result: r})
}

func (s *seamWriter) pickerCancel(id int64) error {
	return s.send(envelope{ID: &id, Error: &rpcError{Code: -32800, Message: "cancelled"}})
}

// openSeam resolves seam input/output per the documented precedence:
//
//	in:  fd 3 (if open) → --events FILE → stdin (if not a tty) → none
//	out: fd 4 (if open) → --out FILE    → stdout (if not a tty) → none
//
// "none" is a named state (interactive-only mode), not a silent drop: the
// footer shows "no seam" and any attempted back-channel write is logged to
// the debug log with a reason.
type seamIO struct {
	in       io.Reader
	out      *seamWriter
	inName   string
	outName  string
	inClose  io.Closer
	outClose io.Closer
}

func fdOpen(fd uintptr) (*os.File, bool) {
	f := os.NewFile(fd, fmt.Sprintf("fd%d", fd))
	if f == nil {
		return nil, false
	}
	if _, err := f.Stat(); err != nil {
		return nil, false
	}
	return f, true
}

func openSeam(eventsPath, outPath string, stdinIsTTY, stdoutIsTTY bool) (*seamIO, error) {
	s := &seamIO{}

	if f, ok := fdOpen(3); ok {
		s.in, s.inName, s.inClose = f, "fd3", f
	} else if eventsPath != "" {
		f, err := os.Open(eventsPath)
		if err != nil {
			return nil, fmt.Errorf("seam: --events %s: %w", eventsPath, err)
		}
		s.in, s.inName, s.inClose = f, eventsPath, f
	} else if !stdinIsTTY {
		s.in, s.inName = os.Stdin, "stdin"
	} else {
		s.inName = "none"
	}

	if f, ok := fdOpen(4); ok {
		s.out, s.outName, s.outClose = newSeamWriter(f), "fd4", f
	} else if outPath != "" {
		f, err := os.Create(outPath)
		if err != nil {
			return nil, fmt.Errorf("seam: --out %s: %w", outPath, err)
		}
		s.out, s.outName, s.outClose = newSeamWriter(f), outPath, f
	} else if !stdoutIsTTY {
		s.out, s.outName = newSeamWriter(os.Stdout), "stdout"
	} else {
		s.outName = "none"
	}

	if s.in != nil && s.out == nil {
		return nil, fmt.Errorf("seam: input active (%s) but no back-channel target — pass --out or fd 4 (refusing to run with a half-open seam)", s.inName)
	}
	return s, nil
}

func (s *seamIO) close() {
	if s.inClose != nil {
		s.inClose.Close()
	}
	if s.outClose != nil {
		s.outClose.Close()
	}
}
