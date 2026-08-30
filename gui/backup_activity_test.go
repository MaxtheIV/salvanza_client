package main

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tizbac/proxmoxbackupclient_go/gui/api"
)

func newTestTracker() *activityTracker {
	tr := newActivityTracker()
	tr.logFlushInterval = 5 * time.Millisecond
	return tr
}

func TestActivityTrackerRunLifecycle(t *testing.T) {
	tr := newTestTracker()
	var mu sync.Mutex
	var runs []api.ActivitySnapshot
	tr.SetSinks(func(s api.ActivitySnapshot) { mu.Lock(); runs = append(runs, s); mu.Unlock() }, nil, nil)

	if s := tr.Snapshot(); s.Running || s.RunID != "" {
		t.Fatalf("fresh tracker must be idle: %+v", s)
	}
	id := tr.BeginRun("host-01", "https://pbs:8007/ds", 2)
	s := tr.Snapshot()
	if !s.Running || s.RunID != id || s.BackupID != "host-01" || s.Target != "https://pbs:8007/ds" ||
		s.Stats.Phase != "connect" || s.Stats.DirCount != 2 || s.StartTime == "" {
		t.Errorf("after BeginRun: %+v", s)
	}
	tr.EndRun(true, "verified_success", "done")
	s = tr.Snapshot()
	if s.Running || !s.Complete || !s.Success || s.Outcome != "verified_success" || s.Message != "done" ||
		s.EndTime == "" || s.Stats.Percent != 1.0 {
		t.Errorf("after EndRun: %+v", s)
	}
	// mu is unlocked before the second BeginRun call, not deferred: BeginRun
	// invokes onRun synchronously on the calling goroutine (see
	// TestActivityTrackerPercentAcrossDirectories, which reads its onStats
	// result with no synchronization immediately after Progress returns — that
	// only works if the sink runs before the call returns). Holding mu via
	// defer across a call that re-enters this same closure would self-deadlock
	// on Go's non-reentrant sync.Mutex.
	mu.Lock()
	if len(runs) != 2 || !runs[0].Running || runs[1].Running {
		t.Errorf("onRun sink calls: %+v", runs)
	}
	mu.Unlock()
	id2 := tr.BeginRun("host-01", "x", 1)
	if id2 == id {
		t.Errorf("run ids must differ")
	}
	// Every BeginRun starts a flushLoop goroutine; end the run so it stops (M-6).
	tr.EndRun(true, "verified_success", "done")
}

func TestActivityTrackerPercentAcrossDirectories(t *testing.T) {
	tr := newTestTracker()
	var last api.BackupProgressStats
	tr.SetSinks(nil, func(s api.BackupProgressStats) { last = s }, nil)
	tr.BeginRun("h", "t", 2)
	defer tr.EndRun(true, "verified_success", "done")

	tr.BeginDir(1, `C:\a`)
	st := tr.Progress(50, 1, 2, 0, "m")
	if !st.Indeterminate || st.Percent != 0 || st.Phase != "upload" || st.DirIndex != 1 || st.CurrentDir != `C:\a` {
		t.Errorf("unknown total must be indeterminate: %+v", st)
	}
	if last.BytesDone != 50 || last.NewChunks != 1 || last.ReusedChunks != 2 {
		t.Errorf("onStats sink got %+v", last)
	}

	tr.SetDirTotal(1, 100)
	st = tr.Progress(50, 1, 2, 0, "m")
	if st.Indeterminate || st.Percent != 0.5 || st.BytesTotal != 100 {
		t.Errorf("dir1 half: %+v", st)
	}
	// Overshoot (pxar framing > file bytes) is clamped, never > 0.99.
	st = tr.Progress(150, 1, 2, 0, "m")
	if st.Percent != 0.99 {
		t.Errorf("overshoot percent = %v want 0.99", st.Percent)
	}
	tr.EndDir(150, 100)

	tr.BeginDir(2, `C:\b`)
	st = tr.Progress(0, 1, 2, 0, "m")
	// Percent never goes backwards even though dir 2's total is unknown.
	if st.Percent != 0.99 || !st.Indeterminate || st.DirIndex != 2 {
		t.Errorf("dir2 start: %+v", st)
	}
	tr.SetDirTotal(2, 300)
	st = tr.Progress(150, 1, 2, 0, "m")
	// run-level: done 150+150 = 300 of total 100+300 = 400 → 0.75, but clamped to
	// the monotonic floor of 0.99 reached earlier.
	if st.Percent != 0.99 || st.BytesDone != 300 || st.BytesTotal != 400 {
		t.Errorf("dir2 progress: %+v", st)
	}
}

func TestActivityTrackerMonotonicWithoutOvershoot(t *testing.T) {
	tr := newTestTracker()
	tr.BeginRun("h", "t", 2)
	defer tr.EndRun(true, "verified_success", "done")
	tr.BeginDir(1, "a")
	tr.SetDirTotal(1, 100)
	st := tr.Progress(40, 0, 0, 0, "")
	if st.Percent != 0.4 {
		t.Fatalf("percent = %v", st.Percent)
	}
	tr.EndDir(40, 100)
	tr.BeginDir(2, "b")
	tr.SetDirTotal(2, 100)
	st = tr.Progress(10, 0, 0, 0, "")
	if st.Percent != 0.4 { // 50/200 = 0.25 < floor 0.4
		t.Errorf("percent regressed: %v", st.Percent)
	}
	st = tr.Progress(80, 0, 0, 0, "")
	if st.Percent != 0.6 { // 120/200
		t.Errorf("percent = %v want 0.6", st.Percent)
	}
}

func TestActivityTrackerEntriesAndLog(t *testing.T) {
	tr := newTestTracker()
	var mu sync.Mutex
	var pushed []api.RunLogEntry
	tr.SetSinks(nil, nil, func(es []api.RunLogEntry) { mu.Lock(); pushed = append(pushed, es...); mu.Unlock() })
	tr.BeginRun("h", "t", 1)
	tr.BeginDir(1, "a")
	tr.EntryDone(`C:\a\f.txt`, 2048, false)
	tr.EntryDone(`C:\a\sub`, 0, true)
	tr.Log("info", "hello")
	st := tr.Snapshot().Stats
	if st.FilesDone != 1 || st.CurrentFile != `C:\a\sub` {
		t.Errorf("entries: %+v", st)
	}
	entries, next := tr.LogSince(0)
	if len(entries) != 3 || next != 4 {
		t.Fatalf("LogSince = %+v next %d", entries, next)
	}
	if entries[0].Level != "debug" || !strings.HasPrefix(entries[0].Msg, "[File] C:\\a\\f.txt (") {
		t.Errorf("file line: %+v", entries[0])
	}
	if entries[1].Msg != "[Dir] C:\\a\\sub" || entries[2].Msg != "hello" {
		t.Errorf("lines: %+v", entries[1:])
	}
	tr.EndRun(true, "verified_success", "ok")
	deadline := time.Now().Add(time.Second)
	for {
		mu.Lock()
		n := len(pushed)
		mu.Unlock()
		if n >= 3 || time.Now().After(deadline) {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(pushed) < 3 {
		t.Errorf("onLog sink received %d entries, want >= 3", len(pushed))
	}
	if s := tr.Snapshot(); s.LogNext != 4 {
		t.Errorf("LogNext = %d want 4", s.LogNext)
	}
}

func TestActivityTrackerBeginRunResetsLog(t *testing.T) {
	tr := newTestTracker()
	tr.BeginRun("h", "t", 1)
	tr.Log("info", "old")
	tr.EndRun(false, "failed", "x")
	tr.BeginRun("h", "t", 1)
	defer tr.EndRun(true, "verified_success", "done")
	entries, _ := tr.LogSince(0)
	if len(entries) != 0 {
		t.Errorf("log not reset on BeginRun: %+v", entries)
	}
	if s := tr.Snapshot(); s.Complete || s.Stats.FilesDone != 0 || s.Stats.Percent != 0 {
		t.Errorf("stats not reset on BeginRun: %+v", s)
	}
}

// I-1: the sinks are process-level and permanent, but the flush loop only exists
// during a run. Anything logged outside a run must be dropped on the floor, not
// buffered until it pollutes the next run.
func TestActivityTrackerLogOnlyWhileRunning(t *testing.T) {
	tr := newTestTracker()
	tr.SetSinks(nil, nil, func([]api.RunLogEntry) {})

	tr.Log("info", "restore line before any run")
	tr.EntryDone(`C:\tmp\x.txt`, 1, false)
	if entries, next := tr.LogSince(0); len(entries) != 0 || next != 1 {
		t.Fatalf("logging before BeginRun leaked: %+v next %d", entries, next)
	}
	tr.mu.Lock()
	pending := len(tr.pendingLog)
	tr.mu.Unlock()
	if pending != 0 {
		t.Errorf("pendingLog grew outside a run: %d", pending)
	}

	tr.BeginRun("h", "t", 1)
	tr.Log("info", "during")
	tr.EndRun(true, "verified_success", "ok")
	during, nextAfterRun := tr.LogSince(0)
	if len(during) != 1 || during[0].Msg != "during" {
		t.Fatalf("in-run line missing: %+v", during)
	}

	tr.Log("warn", "cache line after the run")
	tr.EntryDone(`C:\tmp\x.txt`, 1, false)
	after, next := tr.LogSince(0)
	if len(after) != 1 || after[0].Msg != "during" || next != nextAfterRun {
		t.Errorf("logging after EndRun leaked: %+v next %d", after, next)
	}
}

// I-1: pendingLog is drained by flushLoop every 250 ms, but a burst between two
// ticks (or a sink that stalls) must not grow it without bound.
func TestActivityTrackerPendingLogIsCapped(t *testing.T) {
	tr := newTestTracker()
	tr.logFlushInterval = time.Hour // never flush during this test
	tr.SetSinks(nil, nil, func([]api.RunLogEntry) {})
	tr.BeginRun("h", "t", 1)
	for i := 0; i < runLogCapacity+64; i++ {
		tr.Log("info", "x")
	}
	tr.mu.Lock()
	pending := len(tr.pendingLog)
	tr.mu.Unlock()
	if pending > runLogCapacity {
		t.Errorf("pendingLog = %d entries, want <= %d", pending, runLogCapacity)
	}
	tr.EndRun(true, "verified_success", "ok")
}

// I-2: per-file debug lines live in their own small ring, so a folder with far
// more files than the ring holds cannot evict the milestones the default "info+"
// filter shows.
func TestActivityTrackerFileLinesDoNotEvictMilestones(t *testing.T) {
	tr := newTestTracker()
	tr.BeginRun("h", "t", 1)
	defer tr.EndRun(true, "verified_success", "ok")
	tr.BeginDir(1, "a")
	tr.Log("info", "first milestone")
	for i := 0; i < fileLogCapacity+128; i++ {
		tr.EntryDone(fmt.Sprintf(`C:\a\f%d.txt`, i), 1024, false)
	}
	tr.Log("info", "last milestone")

	entries, _ := tr.LogSince(0)
	var milestones []string
	debugCount := 0
	for _, e := range entries {
		if e.Level == "debug" {
			debugCount++
			continue
		}
		milestones = append(milestones, e.Msg)
	}
	if len(milestones) != 2 || milestones[0] != "first milestone" || milestones[1] != "last milestone" {
		t.Errorf("milestones evicted by per-file lines: %+v", milestones)
	}
	if debugCount != fileLogCapacity {
		t.Errorf("per-file ring kept %d lines, want %d", debugCount, fileLogCapacity)
	}
	// The merge must stay strictly ordered by the shared sequence counter.
	for i := 1; i < len(entries); i++ {
		if entries[i].Seq <= entries[i-1].Seq {
			t.Fatalf("merged log out of order at %d: %d after %d", i, entries[i].Seq, entries[i-1].Seq)
		}
	}
}

// M-7: the background size scan outlives the directory it was started for, so a
// late result for a previous directory must not overwrite the current total.
func TestActivityTrackerSetDirTotalIgnoresStaleDirectory(t *testing.T) {
	tr := newTestTracker()
	tr.BeginRun("h", "t", 2)
	defer tr.EndRun(true, "verified_success", "ok")
	tr.BeginDir(1, "a")
	tr.SetDirTotal(1, 100)
	tr.EndDir(100, 100)

	tr.BeginDir(2, "b")
	tr.SetDirTotal(1, 999999) // late result from directory 1
	if st := tr.Progress(10, 0, 0, 0, ""); !st.Indeterminate || st.BytesTotal != 100 {
		t.Errorf("stale SetDirTotal applied: %+v", st)
	}
	tr.SetDirTotal(2, 200)
	if st := tr.Progress(10, 0, 0, 0, ""); st.Indeterminate || st.BytesTotal != 300 {
		t.Errorf("current SetDirTotal ignored: %+v", st)
	}
}
