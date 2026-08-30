package main

import "testing"

func TestRunLogAppendAndSince(t *testing.T) {
	l := NewRunLog(10)
	if _, next := l.Since(0); next != 1 {
		t.Fatalf("empty log next = %d, want 1", next)
	}
	e1 := l.Append("info", "one")
	e2 := l.Append("warn", "two")
	if e1.Seq != 1 || e2.Seq != 2 {
		t.Fatalf("seq = %d,%d want 1,2", e1.Seq, e2.Seq)
	}
	got, next := l.Since(0)
	if len(got) != 2 || got[0].Msg != "one" || got[1].Msg != "two" || next != 3 {
		t.Errorf("Since(0) = %+v next %d", got, next)
	}
	got, next = l.Since(2)
	if len(got) != 1 || got[0].Msg != "two" || next != 3 {
		t.Errorf("Since(2) = %+v next %d", got, next)
	}
	got, next = l.Since(3)
	if len(got) != 0 || next != 3 {
		t.Errorf("Since(future) = %+v next %d, want empty,3", got, next)
	}
	if e1.TS == "" || e1.Level != "info" {
		t.Errorf("entry not filled: %+v", e1)
	}
}

func TestRunLogWrapsAtCapacity(t *testing.T) {
	l := NewRunLog(3)
	for i := 0; i < 5; i++ {
		l.Append("info", string(rune('a'+i)))
	}
	got, next := l.Since(0)
	if len(got) != 3 || got[0].Msg != "c" || got[2].Msg != "e" || got[0].Seq != 3 || next != 6 {
		t.Errorf("wrapped Since(0) = %+v next %d", got, next)
	}
	// Asking for an evicted seq returns what is left, starting at the oldest kept.
	got, _ = l.Since(1)
	if len(got) != 3 || got[0].Seq != 3 {
		t.Errorf("Since(evicted) = %+v", got)
	}
}

func TestRunLogResetKeepsSeqMonotonic(t *testing.T) {
	l := NewRunLog(3)
	l.Append("info", "x")
	l.Append("info", "y")
	l.Reset()
	got, next := l.Since(0)
	if len(got) != 0 || next != 3 {
		t.Errorf("after reset Since(0) = %+v next %d, want empty,3", got, next)
	}
	e := l.Append("info", "z")
	if e.Seq != 3 {
		t.Errorf("seq after reset = %d, want 3", e.Seq)
	}
}

func TestClassifyLogLevel(t *testing.T) {
	cases := map[string]string{
		"[ERROR] boom":                     "error",
		"CRITICAL: Backup panic":           "error",
		"⚠️  Failed to upload chunk":       "error",
		"WARNING: Size calculation":        "warn",
		"Warning: Failed to add":           "warn",
		"[WARN] x":                         "warn",
		"[DEBUG] Validating":               "debug",
		"Backup progress: 12.0% - x":       "debug",
		"Starting backup of directory 1/2": "info",
		"":                                 "info",
	}
	for msg, want := range cases {
		if got := classifyLogLevel(msg); got != want {
			t.Errorf("classifyLogLevel(%q) = %q, want %q", msg, got, want)
		}
	}
}

// I-2: the milestone ring and the per-file ring of one run draw from a single
// counter, so the GUI can merge them into one ordered pane and page both with a
// single "since" cursor.
func TestRunLogSharedSeqIsGlobalAcrossRings(t *testing.T) {
	seq := newRunLogSeq()
	milestones := newRunLogShared(4, seq)
	files := newRunLogShared(2, seq)

	e1 := milestones.Append("info", "m1")
	e2 := files.Append("debug", "f1")
	e3 := files.Append("debug", "f2")
	e4 := milestones.Append("warn", "m2")
	if e1.Seq != 1 || e2.Seq != 2 || e3.Seq != 3 || e4.Seq != 4 {
		t.Fatalf("shared seqs = %d,%d,%d,%d want 1,2,3,4", e1.Seq, e2.Seq, e3.Seq, e4.Seq)
	}
	if milestones.Next() != 5 || files.Next() != 5 {
		t.Errorf("Next() = %d/%d, want 5/5", milestones.Next(), files.Next())
	}

	// The small ring evicts on its own without disturbing the other ring or the
	// counter: seqs stay unique and monotonic for the whole run.
	e5 := files.Append("debug", "f3")
	got, next := files.Since(0)
	if len(got) != 2 || got[0].Msg != "f2" || got[1].Msg != "f3" || next != 6 || e5.Seq != 5 {
		t.Errorf("evicting ring = %+v next %d", got, next)
	}
	if got, _ := milestones.Since(0); len(got) != 2 || got[0].Msg != "m1" {
		t.Errorf("sibling ring disturbed: %+v", got)
	}

	// Reset drops the retained lines of one ring but never rewinds the counter.
	files.Reset()
	if got, next := files.Since(0); len(got) != 0 || next != 6 {
		t.Errorf("after Reset = %+v next %d, want empty,6", got, next)
	}
	if e := milestones.Append("info", "m3"); e.Seq != 6 {
		t.Errorf("seq after sibling Reset = %d, want 6", e.Seq)
	}
}
