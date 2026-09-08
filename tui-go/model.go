package main

// model.go — the one root Elm model. Layout is declared, never negotiated
// with the terminal: viewport + docked textarea + footer row, joined
// vertically; the picker is a stacked lipgloss layer. No DECSTBM, no
// alt-screen, no scroll regions — completed blocks are committed to real
// scrollback with program.Println (insert-above).

import (
	"encoding/json"
	"fmt"
	"strings"

	"charm.land/bubbles/v2/spinner"
	"charm.land/bubbles/v2/textarea"
	"charm.land/bubbles/v2/viewport"
	tea "charm.land/bubbletea/v2"
	"charm.land/glamour/v2"
	"charm.land/lipgloss/v2"
	uv "github.com/charmbracelet/ultraviolet"
	"github.com/charmbracelet/x/ansi"
)

const (
	footerHeight = 1
	taHeight     = 3
)

var (
	footerStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("241"))
	statusStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("214"))
	errStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("196"))
	liveStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("252"))
)

type seamMsg seamEvent // one inbound seam line, delivered to Update

type rootModel struct {
	program *tea.Program
	seam    *seamIO
	seamCh  <-chan seamEvent
	debug   *debugLog

	width, height int

	vp       viewport.Model
	ta       textarea.Model
	sp       spinner.Model
	spinning bool
	status   string
	footer   footerFrameParams

	picker *pickerModel

	live   strings.Builder // current uncommitted streamed text
	tools  []string        // uncommitted tool activity lines
	quited bool
}

func newRootModel(seam *seamIO, seamCh <-chan seamEvent, debug *debugLog) *rootModel {
	ta := textarea.New()
	ta.Prompt = " > " // `>` glyph lands at terminal column 2 (bi#181 shape)
	ta.ShowLineNumbers = false
	ta.SetHeight(taHeight)
	ta.MaxHeight = taHeight
	ta.Focus()

	sp := spinner.New(spinner.WithSpinner(spinner.Dot))

	vp := viewport.New()

	return &rootModel{
		seam:   seam,
		seamCh: seamCh,
		debug:  debug,
		ta:     ta,
		sp:     sp,
		vp:     vp,
		status: "connecting…",
		footer: footerFrameParams{Provider: "—", Model: "—", Thinking: "—"},
	}
}

func waitForSeam(ch <-chan seamEvent) tea.Cmd {
	return func() tea.Msg {
		ev, ok := <-ch
		if !ok {
			return seamMsg{eof: true}
		}
		return seamMsg(ev)
	}
}

func (m *rootModel) Init() tea.Cmd {
	cmds := []tea.Cmd{m.ta.Focus()}
	if m.seamCh != nil {
		cmds = append(cmds, waitForSeam(m.seamCh))
	} else {
		m.debug.log("ready", map[string]any{"seam": "none"})
	}
	return tea.Batch(cmds...)
}

func (m *rootModel) layout() {
	vpHeight := max(m.height-footerHeight-taHeight, 1)
	m.vp.SetWidth(m.width)
	m.vp.SetHeight(vpHeight)
	m.ta.SetWidth(m.width)
}

func (m *rootModel) refreshLive() {
	var b strings.Builder
	if m.live.Len() > 0 {
		b.WriteString(liveStyle.Render(m.live.String()))
	}
	for _, l := range m.tools {
		if b.Len() > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(footerStyle.Render(l))
	}
	m.vp.SetContent(b.String())
	m.vp.GotoBottom()
}

// commitLive renders the pending streamed text as markdown (glamour) plus
// any tool lines, and returns a Cmd that prints them ABOVE the managed
// region via program.Println — this is what puts the transcript into real
// terminal scrollback (the DECSTBM class of loss is absent by
// construction).
//
// The Println MUST happen inside the returned Cmd, never inline in Update:
// v2's Program.Println does a blocking send on the unbuffered p.msgs
// channel, and the event loop is busy running Update — a synchronous call
// deadlocks the program (verified by the split-csi drill: submit delivered,
// then the loop wedged and even tea.Quit stopped processing).
func (m *rootModel) commitLive(markdown string) tea.Cmd {
	var block strings.Builder
	text := markdown
	if text == "" {
		text = m.live.String()
	}
	if strings.TrimSpace(text) != "" {
		rendered, err := renderMarkdown(text, m.width)
		if err != nil {
			// Named fallback, never silent (bi#55).
			m.debug.log("glamour_error", map[string]any{"err": err.Error()})
			rendered = text
		}
		block.WriteString(strings.TrimRight(rendered, "\n"))
	}
	for _, l := range m.tools {
		block.WriteString("\n  " + l)
	}
	m.live.Reset()
	m.tools = nil
	m.refreshLive()
	if block.Len() == 0 {
		return nil
	}
	out := block.String()
	m.debug.log("commit", map[string]any{
		"lines": strings.Count(out, "\n") + 1,
	})
	p := m.program
	return func() tea.Msg {
		p.Println(out)
		return nil
	}
}

func renderMarkdown(md string, width int) (string, error) {
	r, err := glamour.NewTermRenderer(
		glamour.WithStandardStyle("dark"),
		glamour.WithWordWrap(max(width-2, 20)),
		glamour.WithPreservedNewLines(),
	)
	if err != nil {
		return "", err
	}
	return r.Render(md)
}

func (m *rootModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {

	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		m.layout()
		// Self-check the layout invariant the sigwinch drill asserts on:
		// no rendered line may exceed the terminal width (a "torn row").
		// The drill has TWO nets, each red-checked (bi#57):
		//   vpWidth  — catches m.layout() removal (components keep old
		//              geometry; vp stays 0/80 wide after the shrink).
		//   maxLineWidth/footerOk — catches clampLines removal in View
		//              (the clamp is what ENFORCES the no-torn-row
		//              invariant; without it a 70-col footer renders into
		//              a 60-col terminal).
		// (2026-09-08: before the vpWidth net existed, removing layout()
		// still passed — View clamps whatever components produce. A net
		// that cannot go red is camouflage; both hunks are now live.)
		maxW := 0
		worst := ""
		for _, line := range strings.Split(m.View().Content, "\n") {
			if w := lipgloss.Width(ansi.Strip(line)); w > maxW {
				maxW = w
				worst = ansi.Strip(line)
			}
		}
		m.debug.log("resize", map[string]any{
			"width": msg.Width, "height": msg.Height,
			"vpHeight": m.vp.Height(), "vpWidth": m.vp.Width(), "taWidth": m.ta.Width(), "maxLineWidth": maxW,
			"worstLine": worst,
			"footerOk":  maxW <= msg.Width,
		})
		return m, nil

	case tea.KeyboardEnhancementsMsg:
		m.debug.log("kitty", map[string]any{"flags": msg.Flags})
		return m, nil

	case tea.KeyReleaseMsg:
		// Kitty release events are NOT text. Dropping them here is the
		// load-bearing hunk for the split-CSI drill (proposals/14): a
		// release that straddles a slow-link window must type nothing.
		m.debug.log("key_release", map[string]any{"key": msg.String()})
		return m, nil

	case tea.PasteMsg:
		// Native bracketed paste: exactly one PasteMsg per paste, however
		// the bytes were chunked (no paste-burst heuristic).
		m.debug.log("paste", map[string]any{
			"chars": len(msg.Content),
			"lines": strings.Count(msg.Content, "\n") + 1,
		})
		if m.picker == nil {
			var cmd tea.Cmd
			m.ta, cmd = m.ta.Update(msg)
			return m, cmd
		}
		return m, nil

	case tea.KeyPressMsg:
		if msg.String() == "ctrl+c" {
			m.debug.log("quit", map[string]any{"reason": "ctrl+c"})
			return m, tea.Quit
		}
		if m.picker != nil {
			cmd, done := m.picker.update(msg)
			if done {
				m.answerPicker()
			}
			return m, cmd
		}
		switch msg.String() {
		case "enter":
			text := strings.TrimRight(m.ta.Value(), "\n")
			if strings.TrimSpace(text) == "" {
				m.ta.SetValue("")
				return m, nil
			}
			if m.seam.out == nil {
				m.status = "no seam back-channel — submit not delivered (interactive-only mode)"
				m.debug.log("submit_dropped", map[string]any{"reason": "no back-channel"})
				m.ta.SetValue("")
				return m, nil
			}
			if err := m.seam.out.submit(text); err != nil {
				m.status = err.Error()
				m.ta.SetValue("")
				return m, nil
			}
			echo := lipgloss.NewStyle().
				Foreground(lipgloss.Color("212")).
				Render("> " + m.ta.Value())
			m.ta.SetValue("")
			m.debug.log("submit", map[string]any{
				"chars": len(text),
				"lines": strings.Count(text, "\n") + 1,
			})
			p := m.program
			return m, func() tea.Msg { // see commitLive: never Println inline
				p.Println(echo)
				return nil
			}
		case "pgup", "pgdown", "shift+up", "shift+down":
			var cmd tea.Cmd
			m.vp, cmd = m.vp.Update(msg)
			return m, cmd
		}
		var cmd tea.Cmd
		m.ta, cmd = m.ta.Update(msg)
		return m, cmd

	case spinner.TickMsg:
		if !m.spinning {
			return m, nil
		}
		var cmd tea.Cmd
		m.sp, cmd = m.sp.Update(msg)
		return m, cmd

	case seamMsg:
		return m.handleSeam(seamEvent(msg))

	case uv.UnknownEvent:
		// Undecodable input (e.g. a reassembly tail that expired upstream
		// of seqReader). Named, never silently dropped (bi#55).
		m.debug.log("unknown_input", map[string]any{"seq": string(msg)})
		m.status = "input: undecodable sequence dropped (see debug log)"
		return m, nil
	}
	return m, nil
}

func (m *rootModel) answerPicker() {
	p := m.picker
	m.picker = nil
	if p.chosen != nil {
		m.debug.log("picker_choice", map[string]any{"id": p.reqID, "itemId": p.chosen.ID})
		if err := m.seam.out.pickerChoice(p.reqID, *p.chosen); err != nil {
			m.status = err.Error()
		}
	} else {
		m.debug.log("picker_cancel", map[string]any{"id": p.reqID})
		if err := m.seam.out.pickerCancel(p.reqID); err != nil {
			m.status = err.Error()
		}
	}
}

func (m *rootModel) handleSeam(ev seamEvent) (tea.Model, tea.Cmd) {
	next := func() tea.Cmd { return waitForSeam(m.seamCh) }

	if ev.eof {
		cmd := m.commitLive("")
		m.debug.log("seam_eof", nil)
		if cmd != nil {
			// Sequence so the scrollback commit lands before teardown.
			return m, tea.Sequence(cmd, tea.Quit)
		}
		return m, tea.Quit
	}
	if ev.err != nil {
		m.status = ev.err.Error()
		m.debug.log("seam_error", map[string]any{"err": ev.err.Error()})
		return m, next()
	}

	env := ev.env
	params := func(v any) bool {
		if err := json.Unmarshal(env.Params, v); err != nil {
			m.status = fmt.Sprintf("seam: %s: bad params: %v", env.Method, err)
			m.debug.log("seam_error", map[string]any{"method": env.Method, "err": err.Error()})
			return false
		}
		return true
	}

	switch env.Method {
	case "agent/event":
		var p agentEventParams
		if !params(&p) {
			break
		}
		switch p.Kind {
		case "spinner_start":
			m.spinning = true
			m.status = p.Label
			m.debug.log("agent_event", map[string]any{"kind": p.Kind, "label": p.Label})
			return m, tea.Batch(next(), m.sp.Tick)
		case "spinner_stop":
			m.spinning = false
			m.status = ""
		case "status":
			m.status = p.Label
		}
		m.debug.log("agent_event", map[string]any{"kind": p.Kind, "label": p.Label})

	case "assistant/delta":
		var p deltaParams
		if !params(&p) {
			break
		}
		m.live.WriteString(p.Text)
		m.refreshLive()
		// Per-delta witness for the session drill: a monotonically
		// growing total across many events IS the incremental-streaming
		// evidence (byte-stream substring checks are unreliable under a
		// cell-diffed renderer — fragments interleave).
		m.debug.log("delta", map[string]any{"chars": len(p.Text), "total": m.live.Len()})

	case "tool/start":
		var p toolStartParams
		if !params(&p) {
			break
		}
		m.tools = append(m.tools, fmt.Sprintf("⚙ %s: %s", p.Name, p.Summary))
		m.refreshLive()
		m.debug.log("tool_line", map[string]any{"kind": "start", "id": p.ID, "name": p.Name})

	case "tool/done":
		var p toolDoneParams
		if !params(&p) {
			break
		}
		mark := "✓"
		if !p.OK {
			mark = "✗"
		}
		m.tools = append(m.tools, fmt.Sprintf("%s %s", mark, p.Line))
		m.refreshLive()
		m.debug.log("tool_line", map[string]any{"kind": "done", "id": p.ID, "ok": p.OK})

	case "turn/result":
		var p turnResultParams
		if !params(&p) {
			break
		}
		return m, tea.Batch(next(), m.commitLive(p.Markdown))

	case "footer/frame":
		var p footerFrameParams
		if !params(&p) {
			break
		}
		m.footer = p
		ev := map[string]any{
			"provider": p.Provider, "model": p.Model, "thinking": p.Thinking,
			"tokensIn": p.TokensIn, "tokensOut": p.TokensOut,
		}
		if p.Turn != nil {
			ev["turn"] = *p.Turn
		}
		if p.Messages != nil {
			ev["messages"] = *p.Messages
		}
		if p.Branch != "" {
			ev["branch"] = p.Branch
		}
		m.debug.log("footer", ev)

	case "picker/open":
		var p pickerOpenParams
		if !params(&p) {
			break
		}
		if env.ID == nil {
			m.status = "seam: picker/open without id — cannot answer (refused)"
			m.debug.log("seam_error", map[string]any{"method": env.Method, "err": "missing id"})
			break
		}
		if len(p.Items) == 0 {
			m.status = "seam: picker/open with zero items (refused)"
			m.debug.log("seam_error", map[string]any{"method": env.Method, "err": "zero items"})
			break
		}
		pm := newPicker(*env.ID, p, m.width, m.height)
		m.picker = &pm
		m.debug.log("picker_open", map[string]any{"id": *env.ID, "items": len(p.Items)})

	default:
		// Named, visible rejection — unknown methods are never dropped
		// silently (bi#55).
		m.status = "seam: unknown method " + env.Method
		m.debug.log("seam_unknown", map[string]any{"method": env.Method})
	}
	return m, next()
}

func (m *rootModel) footerView() string {
	left := ""
	if m.spinning {
		left = m.sp.View() + " "
	}
	if m.status != "" {
		left += statusStyle.Render(m.status) + "  "
	}
	f := m.footer
	segs := []string{f.Provider, f.Model, "thinking:" + f.Thinking}
	if f.TokensIn > 0 || f.TokensOut > 0 {
		segs = append(segs, fmt.Sprintf("↑%d ↓%d", f.TokensIn, f.TokensOut))
	}
	// bi#188: host-carried turn/message counts and branch render only
	// when present — the bi#187 fixture's token footer is unchanged.
	if f.Turn != nil {
		seg := fmt.Sprintf("turn:%d", *f.Turn)
		if f.Messages != nil {
			seg += fmt.Sprintf(" msgs:%d", *f.Messages)
		}
		segs = append(segs, seg)
	}
	if f.Branch != "" {
		segs = append(segs, f.Branch)
	}
	segs = append(segs, f.CWD)
	right := footerStyle.Render(strings.Join(segs, " | "))
	return footerStyle.Render(left + right) // width-clamped in View
}

func clampLines(s string, w int) string {
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		lines[i] = ansi.Truncate(l, w, "")
	}
	return strings.Join(lines, "\n")
}

func (m *rootModel) View() tea.View {
	w := max(m.width, 1)
	base := lipgloss.JoinVertical(lipgloss.Left,
		clampLines(m.vp.View(), w),
		clampLines(m.ta.View(), w),
		clampLines(m.footerView(), w),
	)
	if m.picker == nil {
		return tea.NewView(base)
	}
	pv := m.picker.view()
	x := max((m.width-lipgloss.Width(pv))/2, 0)
	y := max((m.height-lipgloss.Height(pv))/2, 0)
	return tea.NewView(lipgloss.NewCompositor(
		lipgloss.NewLayer(base),
		lipgloss.NewLayer(pv).X(x).Y(y).Z(1),
	).Render())
}
