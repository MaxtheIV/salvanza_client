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
