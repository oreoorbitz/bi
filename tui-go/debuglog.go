package main

// debuglog.go — internal-event NDJSON log used by the pty drills to assert
// on UI-internal facts (paste coalescing, release-key drops, resizes,
// scrollback commits) without scraping the rendered frame.

import (
	"encoding/json"
	"fmt"
	"os"
	"sync"
)

type debugLog struct {
	mu sync.Mutex
	f  *os.File
}

func openDebugLog(path string) (*debugLog, error) {
	if path == "" {
		return &debugLog{}, nil
	}
	f, err := os.Create(path)
	if err != nil {
		return nil, fmt.Errorf("debug-log: %s: %w", path, err)
	}
	return &debugLog{f: f}, nil
}

// log writes one event. With no --debug-log it is a no-op; write failures
// go to stderr (named, never silent).
func (d *debugLog) log(eventType string, fields map[string]any) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.f == nil {
		return
	}
	rec := map[string]any{"type": eventType}
	for k, v := range fields {
		rec[k] = v
	}
	b, err := json.Marshal(rec)
	if err != nil {
		fmt.Fprintf(os.Stderr, "debug-log: marshal %s: %v\n", eventType, err)
		return
	}
	if _, err := d.f.Write(append(b, '\n')); err != nil {
		fmt.Fprintf(os.Stderr, "debug-log: write: %v\n", err)
	}
}

func (d *debugLog) close() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.f != nil {
		d.f.Close()
	}
}
