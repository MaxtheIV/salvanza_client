package api

import (
	"encoding/json"
	"testing"
)

// The frontend reads these keys by name (snake_case); a renamed tag silently
// blanks a stat tile, so pin the wire format.
func TestActivitySnapshotJSONKeys(t *testing.T) {
	s := ActivitySnapshot{
		Running: true, RunID: "r1", BackupID: "host", Target: "https://pbs:8007/ds",
		Stats: BackupProgressStats{
			Phase: "upload", Percent: 0.5, BytesDone: 10, BytesTotal: 20,
			FilesDone: 3, EtaSeconds: 42, BytesPerSec: 1.5, ElapsedSeconds: 7,
			DirIndex: 1, DirCount: 2, CurrentFile: `C:\x`,
		},
		LogNext: 9,
	}
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"running", "run_id", "backup_id", "target", "complete", "success", "message", "stats", "log_next"} {
		if _, ok := m[k]; !ok {
			t.Errorf("missing top-level key %q in %s", k, b)
		}
	}
	st := m["stats"].(map[string]any)
	for _, k := range []string{"phase", "indeterminate", "percent", "bytes_done", "bytes_total", "new_chunks",
		"reused_chunks", "failed_chunks", "files_done", "current_file", "dir_index", "dir_count",
		"bytes_per_sec", "eta_seconds", "elapsed_seconds", "message"} {
		if _, ok := st[k]; !ok {
			t.Errorf("missing stats key %q in %s", k, b)
		}
	}
	var back ActivitySnapshot
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}
	if back.Stats.EtaSeconds != 42 || back.LogNext != 9 || back.Stats.CurrentFile != `C:\x` {
		t.Errorf("round-trip mismatch: %+v", back)
	}
}

func TestRunLogEntryJSON(t *testing.T) {
	e := RunLogEntry{Seq: 7, TS: "2026-08-30T10:00:00Z", Level: "warn", Msg: "hi"}
	b, _ := json.Marshal(e)
	want := `{"seq":7,"ts":"2026-08-30T10:00:00Z","level":"warn","msg":"hi"}`
	if string(b) != want {
		t.Errorf("got %s want %s", b, want)
	}
}
