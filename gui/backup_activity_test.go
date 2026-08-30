package main

import (
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
}

func TestActivityTrackerPercentAcrossDirectories(t *testing.T) {
	tr := newTestTracker()
	var last api.BackupProgressStats
	tr.SetSinks(nil, func(s api.BackupProgressStats) { last = s }, nil)
	tr.BeginRun("h", "t", 2)

	tr.BeginDir(1, `C:\a`)
	st := tr.Progress(50, 1, 2, 0, "m")
	if !st.Indeterminate || st.Percent != 0 || st.Phase != "upload" || st.DirIndex != 1 || st.CurrentDir != `C:\a` {
		t.Errorf("unknown total must be indeterminate: %+v", st)
	}
	if last.BytesDone != 50 || last.NewChunks != 1 || last.ReusedChunks != 2 {
		t.Errorf("onStats sink got %+v", last)
	}

	tr.SetDirTotal(100)
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
	tr.SetDirTotal(300)
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
	tr.BeginDir(1, "a")
	tr.SetDirTotal(100)
	st := tr.Progress(40, 0, 0, 0, "")
	if st.Percent != 0.4 {
		t.Fatalf("percent = %v", st.Percent)
	}
	tr.EndDir(40, 100)
	tr.BeginDir(2, "b")
	tr.SetDirTotal(100)
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
	entries, _ := tr.LogSince(0)
	if len(entries) != 0 {
		t.Errorf("log not reset on BeginRun: %+v", entries)
	}
	if s := tr.Snapshot(); s.Complete || s.Stats.FilesDone != 0 || s.Stats.Percent != 0 {
		t.Errorf("stats not reset on BeginRun: %+v", s)
	}
}
