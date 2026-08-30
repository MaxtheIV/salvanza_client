package main

import (
	"strings"
	"sync"
	"time"

	"github.com/tizbac/proxmoxbackupclient_go/gui/api"
)

// runLogCapacity bounds the in-memory run log. 2000 lines is a few minutes of
// per-file output on a fast disk and well under the 1 MiB API body cap; the
// per-run log FILE keeps everything, this buffer only feeds the GUI.
const runLogCapacity = 2000

// RunLog is a fixed-capacity ring of log lines with monotonically increasing
// sequence numbers, so a poller can ask "everything since seq N" and detect that
// it fell behind (first returned Seq > N).
type RunLog struct {
	mu   sync.Mutex
	buf  []api.RunLogEntry
	head int // index of the oldest entry
	size int
	next uint64 // seq assigned to the next Append; starts at 1
}

func NewRunLog(capacity int) *RunLog {
	if capacity < 1 {
		capacity = 1
	}
	return &RunLog{buf: make([]api.RunLogEntry, capacity), next: 1}
}

func (l *RunLog) Append(level, msg string) api.RunLogEntry {
	l.mu.Lock()
	defer l.mu.Unlock()
	e := api.RunLogEntry{
		Seq:   l.next,
		TS:    time.Now().Format(time.RFC3339Nano),
		Level: level,
		Msg:   msg,
	}
	l.next++
	if l.size < len(l.buf) {
		l.buf[(l.head+l.size)%len(l.buf)] = e
		l.size++
	} else {
		l.buf[l.head] = e
		l.head = (l.head + 1) % len(l.buf)
	}
	return e
}

// Since returns the retained entries with Seq >= seq, oldest first, and the seq
// the caller should pass next time. Evicted history is simply absent.
func (l *RunLog) Since(seq uint64) ([]api.RunLogEntry, uint64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]api.RunLogEntry, 0, l.size)
	for i := 0; i < l.size; i++ {
		e := l.buf[(l.head+i)%len(l.buf)]
		if e.Seq >= seq {
			out = append(out, e)
		}
	}
	return out, l.next
}

func (l *RunLog) Next() uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.next
}

// Reset drops the retained lines but keeps counting seq, so a client holding a
// cursor from the previous run never sees a seq twice.
func (l *RunLog) Reset() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.head, l.size = 0, 0
}

// classifyLogLevel derives a GUI log level from the free-form prefixes the
// engine has used for years, so we don't have to touch every writeBackupLog
// call site. Progress ticks are demoted to debug: the bar shows them already.
func classifyLogLevel(msg string) string {
	switch {
	case strings.HasPrefix(msg, "[ERROR]"),
		strings.HasPrefix(msg, "CRITICAL"),
		strings.Contains(msg, "Failed to upload"),
		strings.HasPrefix(msg, "Stack trace"):
		return "error"
	case strings.HasPrefix(msg, "WARNING"),
		strings.HasPrefix(msg, "Warning"),
		strings.HasPrefix(msg, "[WARN]"):
		return "warn"
	case strings.HasPrefix(msg, "[DEBUG]"),
		strings.HasPrefix(msg, "Backup progress:"):
		return "debug"
	default:
		return "info"
	}
}
