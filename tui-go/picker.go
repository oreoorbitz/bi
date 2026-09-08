package main

// picker.go — the one stacked modal. Child-model pattern (crush): the root
// model owns a *pickerModel; while non-nil it swallows all key input and is
// composited on top of the base view as a lipgloss layer.

import (
	"charm.land/bubbles/v2/list"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

func (p pickerItem) FilterValue() string { return p.Label }

type pickerModel struct {
	reqID  int64
	title  string
	list   list.Model
	chosen *pickerItem
}

func newPicker(reqID int64, params pickerOpenParams, width, height int) pickerModel {
	items := make([]list.Item, len(params.Items))
	for i, it := range params.Items {
		items[i] = it
	}
	w := min(max(width*2/3, 40), width-4)
	h := min(max(len(items)+6, 8), height-4)
	delegate := list.NewDefaultDelegate()
	m := list.New(items, delegate, w, h)
	m.Title = params.Title
	m.SetShowStatusBar(false)
	m.SetFilteringEnabled(true)
	return pickerModel{reqID: reqID, title: params.Title, list: m}
}

// update handles one key. done=true means the root must close the picker
// and answer on the back-channel (chosen==nil → cancel).
func (p *pickerModel) update(msg tea.Msg) (cmd tea.Cmd, done bool) {
	if kp, ok := msg.(tea.KeyPressMsg); ok {
		switch kp.String() {
		case "enter":
			if it, ok := p.list.SelectedItem().(pickerItem); ok {
				p.chosen = &it
			}
			return nil, true
		case "esc":
			return nil, true
		}
	}
	var c tea.Cmd
	p.list, c = p.list.Update(msg)
	return c, false
}

func (p *pickerModel) view() string {
	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("62")).
		Padding(0, 1).
		Render(p.list.View())
}
