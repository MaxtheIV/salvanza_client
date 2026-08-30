package main

import (
	"strings"
	"sync"
	"time"

	"github.com/tizbac/proxmoxbackupclient_go/gui/api"
)

// runLogCapacity bounds the in-memory MILESTONE run log (info/warn/error).
// 2000 lines is a long backup's worth of milestones and well under the 1 MiB API
// body cap; the per-run log FILE keeps everything, this buffer only feeds the GUI.
const runLogCapacity = 2000

// fileLogCapacity bounds the separate per-file (debug) ring. Per-file lines are
// emitted once per archived entry, so on a big folder they would evict every
// milestone from a single shared ring within seconds — and the log pane's default
// "info+" filter would then show an empty pane. Keeping them in their own small
// ring means the milestones survive and the debug view still has recent context.
const fileLogCapacity = 300

// runLogSeq is the sequence counter shared by the two rings of one run. Seqs must
// be globally monotonic across both rings: the GUI merges them into one ordered
// pane and pages with a single "since" cursor, so per-ring counters would
// interleave wrongly and break the cursor.
type runLogSeq struct {
	mu   sync.Mutex
	next uint64
}

func newRunLogSeq() *runLogSeq { return &runLogSeq{next: 1} }

// take reserves and returns the next sequence number.
func (s *runLogSeq) take() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := s.next
	s.next++
	return n
}

// peek returns the seq the next Append will use, without consuming it.
func (s *runLogSeq) peek() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.next
}

// RunLog is a fixed-capacity ring of log lines with monotonically increasing
// sequence numbers, so a poller can ask "everything since seq N" and detect that
// it fell behind (first returned Seq > N).
type RunLog struct {
	mu   sync.Mutex
	buf  []api.RunLogEntry
	head int // index of the oldest entry
	size int
	seq  *runLogSeq // may be shared with a sibling ring (see fileLogCapacity)
}

// NewRunLog returns a ring with a private sequence counter.
func NewRunLog(capacity int) *RunLog {
	return newRunLogShared(capacity, newRunLogSeq())
}

// newRunLogShared returns a ring that draws its sequence numbers from seq, so
// several rings of the same run stay on one ordered, gap-free numbering.
func newRunLogShared(capacity int, seq *runLogSeq) *RunLog {
	if capacity < 1 {
		capacity = 1
	}
	return &RunLog{buf: make([]api.RunLogEntry, capacity), seq: seq}
}

func (l *RunLog) Append(level, msg string) api.RunLogEntry {
	l.mu.Lock()
	defer l.mu.Unlock()
	e := api.RunLogEntry{
		Seq:   l.seq.take(),
		TS:    time.Now().Format(time.RFC3339Nano),
		Level: level,
		Msg:   msg,
	}
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
	return out, l.seq.peek()
}

func (l *RunLog) Next() uint64 {
	return l.seq.peek()
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
