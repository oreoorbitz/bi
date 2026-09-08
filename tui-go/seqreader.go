package main

// seqreader.go — SSH-aware escape-sequence reassembly in front of
// bubbletea's input (proposals/14 class).
//
// Evidence gathered by this spike:
//  1. bubbletea v2.0.9's input path (ultraviolet TerminalReader) holds
//     incomplete escape sequences for only EscTimeout = 50ms, with no SSH
//     bump and no env knob — the same fatal window pi-tui had
//     (DEFAULT_SEQUENCE_TIMEOUT_MS). A kitty CSI-u release split across a
//     60ms gap leaks its tail ("3u") as typed text. ultraviolet parses the
//     COMPLETE sequence correctly (verified: whole-write probe emits one
//     KeyReleaseEvent), so holding the tail a little longer fixes the
//     class.
//  2. The wrapper MUST be an *os.File: bubbletea hands p.input to
//     uv.NewCancelReader, which for non-*os.File readers uses a fallback
//     goroutine that reads ahead unbuffered and discards bytes on
//     cancellation (observed: wrapped input lost all keystrokes after the
//     first held sequence). Hence the pipe below, not an io.Reader
//     wrapper.
//
// newSeqReaderTTY returns a pass-through *os.File whose read side yields
// tty bytes immediately EXCEPT a trailing incomplete escape sequence,
// which is held until it completes or the window (default 250ms,
// TUI_GO_SEQ_TIMEOUT_MS, 0 disables = upstream behavior) expires. Bytes
// are only ever delayed, never rewritten.

import (
	"fmt"
	"io"
	"os"
	"time"
)

const (
	defaultSeqWindow = 250 * time.Millisecond
	maxSeqHold       = 8192 // unterminated OSC/DCS flood guard
	pumpBufSize      = 32 * 1024
)

type pumpResult struct {
	b   []byte
	err error
}

// newSeqReaderTTY spawns the reassembly pump and returns the read side of
// its output pipe. Closing the returned file shuts the pump down.
func newSeqReaderTTY(r io.Reader, window time.Duration) *os.File {
	pr, pw, err := os.Pipe()
	if err != nil {
		fatal(fmt.Errorf("seqreader: os.Pipe: %w", err))
	}
	s := &seqPump{window: window, out: pw, chunks: make(chan pumpResult)}
	go s.pump(r)
	go s.run()
	return pr
}

type seqPump struct {
	window time.Duration
	out    *os.File
	chunks chan pumpResult

	pend      []byte // bytes read from the tty, not yet written out
	holding   bool   // pend ends in an incomplete sequence we are holding
	holdSince time.Time
	expired   bool  // hold window ran out: flush the tail as-is
	err       error // terminal read error, delivered after pend drains
}

func (s *seqPump) pump(r io.Reader) {
	for {
		b := make([]byte, pumpBufSize)
		n, err := r.Read(b)
		if n > 0 || err != nil {
			s.chunks <- pumpResult{b: b[:n], err: err}
		}
		if err != nil {
			return
		}
	}
}

func (s *seqPump) run() {
	for {
		if s.err != nil {
			s.expired = true // no more data can complete a held tail
		}
		if len(s.pend) > 0 && (s.ready() || s.expired) {
			if !s.flush() {
				return // output pipe closed: consumer is gone
			}
			continue
		}
		if len(s.pend) == 0 && s.err != nil {
			return
		}

		var timer *time.Timer
		var timeout <-chan time.Time
		if s.holding && !s.expired {
			remain := s.window - time.Since(s.holdSince)
			if remain <= 0 {
				s.expired = true
				continue
			}
			timer = time.NewTimer(remain)
			timeout = timer.C
		}

		select {
		case rr := <-s.chunks:
			if timer != nil {
				timer.Stop()
			}
			if len(rr.b) > 0 {
				s.pend = append(s.pend, rr.b...)
				s.expired = false // new data may complete the tail
				if trailingIncomplete(s.pend) >= 0 {
					s.holding = true
					s.holdSince = time.Now()
				} else {
					s.holding = false
				}
			}
			if rr.err != nil {
				s.err = rr.err
			}
		case <-timeout:
			s.expired = true
		}
	}
}

// ready reports whether pend begins with deliverable complete bytes.
func (s *seqPump) ready() bool {
	idx := trailingIncomplete(s.pend)
	if idx < 0 || len(s.pend)-idx > maxSeqHold {
		s.holding = false
		return true
	}
	if !s.holding {
		s.holding = true
		s.holdSince = time.Now()
	}
	return idx > 0 // complete prefix before the held tail is deliverable
}

// flush writes the deliverable prefix (or everything, when expired) to the
// output pipe. Returns false when the consumer closed the pipe.
func (s *seqPump) flush() bool {
	cut := len(s.pend)
	if !s.expired {
		if idx := trailingIncomplete(s.pend); idx >= 0 && len(s.pend)-idx <= maxSeqHold {
			cut = idx
		}
	}
	if cut == 0 {
		return true
	}
	if _, err := s.out.Write(s.pend[:cut]); err != nil {
		return false
	}
	s.pend = s.pend[cut:]
	if s.expired {
		s.holding = false
		s.expired = false
	}
	return true
}

// trailingIncomplete returns the index where a trailing incomplete escape
// sequence starts, or -1 if buf ends on a complete boundary. Anything
// before the returned index is safe to deliver.
func trailingIncomplete(buf []byte) int {
	i := 0
	for i < len(buf) {
		if buf[i] != 0x1b {
			i++
			continue
		}
		n := escSeqLen(buf[i:])
		if n < 0 {
			return i
		}
		i += n
	}
	return -1
}

// escSeqLen returns the length of the complete escape sequence at b
// (b[0] must be ESC), or -1 if the sequence is incomplete.
func escSeqLen(b []byte) int {
	if len(b) == 1 {
		return -1 // lone ESC
	}
	switch b[1] {
	case '[': // CSI: param 0x30-0x3F, intermediate 0x20-0x2F, final 0x40-0x7E
		j := 2
		for j < len(b) && b[j] >= 0x30 && b[j] <= 0x3f {
			j++
		}
		for j < len(b) && b[j] >= 0x20 && b[j] <= 0x2f {
			j++
		}
		if j < len(b) && b[j] >= 0x40 && b[j] <= 0x7e {
			return j + 1
		}
		return -1
	case ']': // OSC: until BEL or ST
		for j := 2; j < len(b); j++ {
			if b[j] == 0x07 {
				return j + 1
			}
			if b[j] == 0x1b {
				if j+1 < len(b) && b[j+1] == '\\' {
					return j + 2
				}
				return -1 // ESC inside OSC, unknown what follows
			}
		}
		return -1
	case 'P', 'X', '^', '_': // DCS / SOS / PM / APC: until ST
		for j := 2; j < len(b); j++ {
			if b[j] == 0x1b {
				if j+1 < len(b) && b[j+1] == '\\' {
					return j + 2
				}
				return -1
			}
		}
		return -1
	case 'O': // SS3: ESC O <final>
		if len(b) >= 3 {
			return 3
		}
		return -1
	default: // ESC + char (alt key) is complete
		return 2
	}
}
