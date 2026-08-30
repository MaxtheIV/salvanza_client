# Backup Activity View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dedicated "Activity" tab that shows a bytes-accurate progress bar, engine-computed ETA, live statistics and a scrolling verbose log for the running backup — identically in standalone and service mode.

**Architecture:** A process-wide `activityTracker` in the `gui` package is fed directly by the backup engine (`RunBackupInline` / `backupReal` / `ChunkState` / `PXARArchive.OnEntry`), regardless of who started the run. In the standalone GUI the tracker pushes to Wails events through sinks registered at startup; in the service process the local API exposes `GET /activity` and `GET /activity/log?since=` and the GUI polls them and re-emits the same Wails events, so the React panel has one code path.

**Tech Stack:** Go 1.25 (multi-module workspace, build tags `service`/`!service`), Wails v2.8 (library) / CLI v2.12.0, React 18 + Vite, `@phosphor-icons/react`.

**Spec:** `docs/superpowers/specs/2026-08-30-backup-activity-view-design.md`

## Global Constraints

- Always `$env:GOWORK = "off"` and run `go mod tidy` in a module before its first build/test; build and test **per module** (`gui`, `gui/api`, `pbscommon`), never from the repo root.
- Go is at `C:\Program Files\Go\bin` and may not be on PATH: `$env:PATH = "C:\Program Files\Go\bin;" + $env:PATH`.
- Do not use `-race` on Windows (no C toolchain). Do not run `TestConfigSaveLoad` / `TestGetConfigPath` on a machine with a real Nimbus install (they write `C:\ProgramData\NimbusBackup\config.json`); use `-run` filters or `-skip 'TestConfigSaveLoad|TestGetConfigPath'`.
- After every Go change to `gui/` verify **both** builds: `go build ./...` and `go build -tags service ./...`.
- `gui/` is one `package main`; files without build tags compile into both binaries. New `App` methods that only exist in `main.go` (`!service`) need a stub in `app_service_stubs.go`.
- Code comments explain *why*; preserve existing audit-ID references (`H-01`, `v2-H-02`, …). Comments in English. New UI text goes into `gui/frontend/src/i18n/translations.js` for **all three** languages (`fr`, `en`, `de`) — never hard-code UI strings in JSX or Go.
- `CHANGELOG.md` (Keep a Changelog, English) gets an `Unreleased` entry.
- Commit after every task. Git identity for this repo (GitHub origin) is the global one — no override needed. End commit messages with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Working directory for all commands: `C:\Users\Max\Desktop\Persönliche Projekte\NimbusBackuClient` (note the non-ASCII path; quote it).

PowerShell preamble used by every Go step below:

```powershell
$env:PATH = "C:\Program Files\Go\bin;" + $env:PATH
$env:GOWORK = "off"
```

---

### Task 1: `PXARArchive.OnEntry` callback in pbscommon

**Files:**
- Modify: `pbscommon/pxar.go:277-310` (struct), `pbscommon/pxar.go:700-706` (end of `WriteDir`), `pbscommon/pxar.go:843-851` (end of `WriteFile`)
- Test: `pbscommon/pxar_onentry_test.go` (new)

**Interfaces:**
- Produces: `PXARArchive.OnEntry func(path string, size uint64, isDir bool)` — optional; fires once per fully written regular file (size = declared file size) and once per directory (size 0) after its children. Not fired for skipped/excluded entries.

- [ ] **Step 1: Write the failing test**

```go
package pbscommon

import (
	"os"
	"path/filepath"
	"testing"
)

// TestOnEntryFiresPerArchivedEntry: the GUI's live "current file" / file counter
// rides on OnEntry, so it must fire exactly once per archived file and directory,
// and not for entries the exclude policy pruned.
func TestOnEntryFiresPerArchivedEntry(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "sub", "b.txt"), []byte("world!"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "skip.tmp"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	type ev struct {
		path  string
		size  uint64
		isDir bool
	}
	var got []ev
	a := &PXARArchive{
		WriteCB:     func([]byte) error { return nil },
		ExcludeList: []string{"*.tmp"},
		ExcludeRoot: root,
		OnEntry: func(p string, size uint64, isDir bool) {
			got = append(got, ev{p, size, isDir})
		},
	}
	if _, err := a.WriteDir(root, "", true); err != nil {
		t.Fatalf("WriteDir: %v", err)
	}

	files := map[string]uint64{}
	dirs := map[string]bool{}
	for _, e := range got {
		if e.isDir {
			dirs[e.path] = true
		} else {
			files[e.path] = e.size
		}
	}
	if len(files) != 2 {
		t.Fatalf("want 2 file events, got %d: %+v", len(files), got)
	}
	if files[filepath.Join(root, "a.txt")] != 5 {
		t.Errorf("a.txt size = %d, want 5", files[filepath.Join(root, "a.txt")])
	}
	if files[filepath.Join(root, "sub", "b.txt")] != 6 {
		t.Errorf("sub/b.txt size = %d, want 6", files[filepath.Join(root, "sub", "b.txt")])
	}
	if _, excluded := files[filepath.Join(root, "skip.tmp")]; excluded {
		t.Errorf("excluded skip.tmp must not fire OnEntry")
	}
	if !dirs[root] || !dirs[filepath.Join(root, "sub")] {
		t.Errorf("want dir events for root and sub, got %v", dirs)
	}
	if len(dirs) != 2 {
		t.Errorf("want exactly 2 dir events, got %d", len(dirs))
	}
}

// A nil OnEntry must be a no-op (every existing caller leaves it unset).
func TestOnEntryNilIsNoop(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	a := &PXARArchive{WriteCB: func([]byte) error { return nil }}
	if _, err := a.WriteDir(root, "", true); err != nil {
		t.Fatalf("WriteDir with nil OnEntry: %v", err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run (PowerShell):
```powershell
$env:PATH = "C:\Program Files\Go\bin;" + $env:PATH; $env:GOWORK = "off"
Set-Location pbscommon; go mod tidy; go test -run 'TestOnEntry' ./...
```
Expected: compile error `unknown field OnEntry in struct literal of type PXARArchive`.

- [ ] **Step 3: Add the field and the two call sites**

In the `PXARArchive` struct (`pbscommon/pxar.go`, after the `ExcludeRoot` field), add:

```go
	// OnEntry, when set, is called once per archived entry (directory or regular
	// file) after it has been fully written: files with their declared size,
	// directories with size 0 after their children. It exists so the GUI can show
	// a live "current file" and file counter without pbscommon depending on a
	// logger. Skipped / excluded entries never reach it — they are reported via
	// SkippedFiles / ReadErrors / ExcludedFiles instead.
	OnEntry func(path string, size uint64, isDir bool)
```

At the end of `WriteDir`, immediately before `return CatalogDir{`:

```go
	if a.OnEntry != nil {
		a.OnEntry(path, 0, true)
	}
```

At the end of `WriteFile`, after the `a.Flush()` check and before `return CatalogFile{`:

```go
	if a.OnEntry != nil {
		a.OnEntry(path, uint64(fileInfo.Size()), false)
	}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `Set-Location pbscommon; go test ./...`
Expected: PASS (all pbscommon tests, including the two new ones).

- [ ] **Step 5: Commit**

```powershell
git add pbscommon/pxar.go pbscommon/pxar_onentry_test.go
git commit -m "feat(pxar): OnEntry callback for per-file progress reporting" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Shared activity types in `gui/api` and alias in `gui`

**Files:**
- Modify: `gui/api/types.go` (append)
- Modify: `gui/backup_status.go:172-183` (replace struct with alias)
- Test: `gui/api/types_test.go` (new)

**Interfaces:**
- Produces (package `api`):
  - `type BackupProgressStats struct` (fields below)
  - `type RunLogEntry struct { Seq uint64; TS string; Level string; Msg string }`
  - `type ActivitySnapshot struct` (fields below)
  - `type ActivityLogResponse struct { Entries []RunLogEntry; Next uint64 }`
- Produces (package `main` in `gui`): `type BackupProgressStats = api.BackupProgressStats`

- [ ] **Step 1: Write the failing test**

```go
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `Set-Location gui/api; go mod tidy; go test ./...`
Expected: compile errors `undefined: ActivitySnapshot`, `undefined: RunLogEntry`.

- [ ] **Step 3: Add the types to `gui/api/types.go`**

Append:

```go
// BackupProgressStats is a structured snapshot of in-flight backup progress so the
// GUI can render real statistics instead of parsing them out of a log string.
// Percent is bytes-based (BytesDone/BytesTotal over the whole run); while the
// background size scan of the current directory has not finished, BytesTotal is
// unknown and Indeterminate is set so the bar can show an indeterminate state
// instead of a fake number.
type BackupProgressStats struct {
	Phase          string  `json:"phase"`         // "connect" | "vss" | "upload" | "finalize"
	Indeterminate  bool    `json:"indeterminate"` // true while the size of the current dir is unknown
	Percent        float64 `json:"percent"`       // 0.0 - 1.0
	BytesDone      uint64  `json:"bytes_done"`
	BytesTotal     uint64  `json:"bytes_total"` // 0 when unknown
	NewChunks      uint64  `json:"new_chunks"`
	ReusedChunks   uint64  `json:"reused_chunks"`
	FailedChunks   uint64  `json:"failed_chunks"`
	FilesDone      uint64  `json:"files_done"`
	CurrentDir     string  `json:"current_dir,omitempty"`
	CurrentFile    string  `json:"current_file,omitempty"`
	DirIndex       int     `json:"dir_index"` // 1-based index of the directory being archived
	DirCount       int     `json:"dir_count"`
	BytesPerSec    float64 `json:"bytes_per_sec"`
	EtaSeconds     int64   `json:"eta_seconds"` // -1 when unknown
	ElapsedSeconds float64 `json:"elapsed_seconds"`
	Message        string  `json:"message"`
}

// RunLogEntry is one line of the in-memory run log shown in the GUI's Activity
// tab. Seq is monotonically increasing per process so clients can page with
// "since".
type RunLogEntry struct {
	Seq   uint64 `json:"seq"`
	TS    string `json:"ts"`    // RFC3339Nano
	Level string `json:"level"` // "debug" | "info" | "warn" | "error"
	Msg   string `json:"msg"`
}

// ActivitySnapshot describes the current (or last finished) backup run of a
// process. One run at a time is tracked; see gui/backup_activity.go.
type ActivitySnapshot struct {
	Running   bool                `json:"running"`
	RunID     string              `json:"run_id"`
	BackupID  string              `json:"backup_id"`
	Target    string              `json:"target"` // "<baseurl>/<datastore>"
	StartTime string              `json:"start_time,omitempty"`
	EndTime   string              `json:"end_time,omitempty"`
	Complete  bool                `json:"complete"`
	Success   bool                `json:"success"`
	Outcome   string              `json:"outcome,omitempty"` // BackupStatus.Outcome when Complete
	Message   string              `json:"message"`
	Stats     BackupProgressStats `json:"stats"`
	LogNext   uint64              `json:"log_next"` // next log seq a client should ask for
}

// ActivityLogResponse is the payload of GET /activity/log?since=<seq>.
type ActivityLogResponse struct {
	Entries []RunLogEntry `json:"entries"`
	Next    uint64        `json:"next"`
}
```

- [ ] **Step 4: Replace the `gui` struct with an alias**

In `gui/backup_status.go`, replace the whole `BackupProgressStats` struct (lines 172-183) with:

```go
// BackupProgressStats lives in gui/api so the service API can serve it verbatim;
// gui imports api, never the reverse.
type BackupProgressStats = api.BackupProgressStats
```

and add `"github.com/tizbac/proxmoxbackupclient_go/gui/api"` to the imports of `gui/backup_status.go` if not present.

- [ ] **Step 5: Run tests and both builds**

```powershell
Set-Location gui/api; go test ./...
Set-Location ../; go mod tidy; go build ./...; go build -tags service ./...
go test -run 'TestReconcileProvisionedJobs|TestSlugifyJobID' ./...
```
Expected: api tests PASS; both builds succeed; gui subset PASS.

- [ ] **Step 6: Commit**

```powershell
git add gui/api/types.go gui/api/types_test.go gui/backup_status.go
git commit -m "feat(api): activity snapshot, run-log entry and extended progress stats types" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Run-log ring buffer

**Files:**
- Create: `gui/backup_runlog.go`
- Test: `gui/backup_runlog_test.go`

**Interfaces:**
- Produces:
  - `func NewRunLog(capacity int) *RunLog`
  - `func (l *RunLog) Append(level, msg string) api.RunLogEntry`
  - `func (l *RunLog) Since(seq uint64) ([]api.RunLogEntry, uint64)` — entries with `Seq >= seq` in order; second value is the next seq to ask for.
  - `func (l *RunLog) Next() uint64`
  - `func (l *RunLog) Reset()` — drops entries; seq keeps counting (never reused within a process).
  - `func classifyLogLevel(msg string) string`

- [ ] **Step 1: Write the failing test**

```go
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
		"[ERROR] boom":                      "error",
		"CRITICAL: Backup panic":            "error",
		"⚠️  Failed to upload chunk":        "error",
		"WARNING: Size calculation":         "warn",
		"Warning: Failed to add":            "warn",
		"[WARN] x":                          "warn",
		"[DEBUG] Validating":                "debug",
		"Backup progress: 12.0% - x":        "debug",
		"Starting backup of directory 1/2":  "info",
		"":                                  "info",
	}
	for msg, want := range cases {
		if got := classifyLogLevel(msg); got != want {
			t.Errorf("classifyLogLevel(%q) = %q, want %q", msg, got, want)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `Set-Location gui; go test -run 'TestRunLog|TestClassifyLogLevel' ./...`
Expected: `undefined: NewRunLog`.

- [ ] **Step 3: Implement `gui/backup_runlog.go`**

```go
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `Set-Location gui; go test -run 'TestRunLog|TestClassifyLogLevel' ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add gui/backup_runlog.go gui/backup_runlog_test.go
git commit -m "feat(gui): in-memory run log ring buffer for the activity view" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Throughput meter and ETA

**Files:**
- Create: `gui/backup_eta.go`
- Test: `gui/backup_eta_test.go`

**Interfaces:**
- Produces:
  - `func newThroughputMeter(window time.Duration) *throughputMeter`
  - `func (m *throughputMeter) Add(now time.Time, bytesDone uint64)`
  - `func (m *throughputMeter) BytesPerSec(now time.Time) float64`
  - `func (m *throughputMeter) ETA(now time.Time, done, total uint64) int64` — seconds, `-1` unknown
  - `func (m *throughputMeter) Reset()`

- [ ] **Step 1: Write the failing test**

```go
package main

import (
	"testing"
	"time"
)

func TestThroughputMeter(t *testing.T) {
	t0 := time.Date(2026, 8, 30, 10, 0, 0, 0, time.UTC)
	mb := uint64(1024 * 1024)

	t.Run("no samples", func(t *testing.T) {
		m := newThroughputMeter(30 * time.Second)
		if got := m.BytesPerSec(t0); got != 0 {
			t.Errorf("BytesPerSec = %v want 0", got)
		}
		if got := m.ETA(t0, 0, 100); got != -1 {
			t.Errorf("ETA = %d want -1", got)
		}
	})

	t.Run("single sample is not a rate", func(t *testing.T) {
		m := newThroughputMeter(30 * time.Second)
		m.Add(t0, 10*mb)
		if got := m.BytesPerSec(t0.Add(time.Second)); got != 0 {
			t.Errorf("BytesPerSec = %v want 0", got)
		}
	})

	t.Run("constant rate", func(t *testing.T) {
		m := newThroughputMeter(30 * time.Second)
		for i := 0; i <= 10; i++ {
			m.Add(t0.Add(time.Duration(i)*time.Second), uint64(i)*10*mb)
		}
		now := t0.Add(10 * time.Second)
		if got := m.BytesPerSec(now); got != float64(10*mb) {
			t.Errorf("BytesPerSec = %v want %v", got, 10*mb)
		}
		// 100 MB done of 400 MB at 10 MB/s → 30 s left.
		if got := m.ETA(now, 100*mb, 400*mb); got != 30 {
			t.Errorf("ETA = %d want 30", got)
		}
	})

	t.Run("window eviction uses only recent samples", func(t *testing.T) {
		m := newThroughputMeter(10 * time.Second)
		m.Add(t0, 0)
		m.Add(t0.Add(5*time.Second), 100*mb) // 20 MB/s burst, later evicted
		m.Add(t0.Add(20*time.Second), 100*mb)
		m.Add(t0.Add(30*time.Second), 110*mb) // 1 MB/s recently
		got := m.BytesPerSec(t0.Add(30 * time.Second))
		if got != float64(1*mb) {
			t.Errorf("BytesPerSec = %v want %v", got, 1*mb)
		}
	})

	t.Run("unknown or finished total", func(t *testing.T) {
		m := newThroughputMeter(30 * time.Second)
		m.Add(t0, 0)
		m.Add(t0.Add(time.Second), mb)
		now := t0.Add(time.Second)
		if got := m.ETA(now, mb, 0); got != -1 {
			t.Errorf("ETA total=0 = %d want -1", got)
		}
		if got := m.ETA(now, 2*mb, mb); got != -1 {
			t.Errorf("ETA done>=total = %d want -1", got)
		}
	})

	t.Run("non-monotonic bytes yield zero not negative", func(t *testing.T) {
		m := newThroughputMeter(30 * time.Second)
		m.Add(t0, 50*mb)
		m.Add(t0.Add(time.Second), 10*mb)
		if got := m.BytesPerSec(t0.Add(time.Second)); got != 0 {
			t.Errorf("BytesPerSec = %v want 0", got)
		}
	})

	t.Run("reset", func(t *testing.T) {
		m := newThroughputMeter(30 * time.Second)
		m.Add(t0, 0)
		m.Add(t0.Add(time.Second), mb)
		m.Reset()
		if got := m.BytesPerSec(t0.Add(time.Second)); got != 0 {
			t.Errorf("after Reset BytesPerSec = %v want 0", got)
		}
	})
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `Set-Location gui; go test -run TestThroughputMeter ./...`
Expected: `undefined: newThroughputMeter`.

- [ ] **Step 3: Implement `gui/backup_eta.go`**

```go
package main

import (
	"math"
	"time"
)

// throughputMeter estimates upload throughput over a sliding time window. The
// ETA is derived from run-level BytesDone, which is monotonic across
// directories, so a multi-folder run does not restart its estimate per folder.
// Chunk uploads are bursty (dedup hits cost ~0 s, new chunks cost network time),
// so a 30 s window smooths that without lagging a real speed change by minutes.
type throughputMeter struct {
	window  time.Duration
	samples []tpSample
}

type tpSample struct {
	t     time.Time
	bytes uint64
}

func newThroughputMeter(window time.Duration) *throughputMeter {
	return &throughputMeter{window: window}
}

func (m *throughputMeter) Add(now time.Time, bytesDone uint64) {
	m.samples = append(m.samples, tpSample{t: now, bytes: bytesDone})
	m.evict(now)
}

// evict drops samples older than the window, always keeping at least the two
// newest so a rate can still be formed right after a quiet period.
func (m *throughputMeter) evict(now time.Time) {
	cutoff := now.Add(-m.window)
	i := 0
	for i < len(m.samples)-2 && m.samples[i].t.Before(cutoff) {
		i++
	}
	if i > 0 {
		m.samples = append([]tpSample(nil), m.samples[i:]...)
	}
}

// BytesPerSec returns the average rate between the oldest and newest retained
// samples, or 0 when there is no rate to speak of (fewer than two samples, no
// elapsed time, or a byte counter that went backwards).
func (m *throughputMeter) BytesPerSec(now time.Time) float64 {
	m.evict(now)
	if len(m.samples) < 2 {
		return 0
	}
	first, last := m.samples[0], m.samples[len(m.samples)-1]
	dt := last.t.Sub(first.t).Seconds()
	if dt <= 0 || last.bytes <= first.bytes {
		return 0
	}
	return float64(last.bytes-first.bytes) / dt
}

// ETA returns the estimated seconds remaining, or -1 when it cannot be known.
func (m *throughputMeter) ETA(now time.Time, done, total uint64) int64 {
	if total == 0 || done >= total {
		return -1
	}
	rate := m.BytesPerSec(now)
	if rate <= 0 {
		return -1
	}
	return int64(math.Round(float64(total-done) / rate))
}

func (m *throughputMeter) Reset() {
	m.samples = nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `Set-Location gui; go test -run TestThroughputMeter ./...`
Expected: PASS (all subtests).

- [ ] **Step 5: Commit**

```powershell
git add gui/backup_eta.go gui/backup_eta_test.go
git commit -m "feat(gui): sliding-window throughput meter with ETA" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: The process-wide activity tracker

**Files:**
- Create: `gui/backup_activity.go`
- Test: `gui/backup_activity_test.go`

**Interfaces:**
- Consumes: `RunLog` (Task 3), `throughputMeter` (Task 4), `api.ActivitySnapshot` / `api.BackupProgressStats` / `api.RunLogEntry` (Task 2).
- Produces (all methods safe for concurrent use):
  - `var activity = newActivityTracker()`
  - `func (t *activityTracker) SetSinks(onRun func(api.ActivitySnapshot), onStats func(api.BackupProgressStats), onLog func([]api.RunLogEntry))`
  - `func (t *activityTracker) BeginRun(backupID, target string, dirCount int) string` — returns run id; resets accounting + log; phase `"connect"`.
  - `func (t *activityTracker) SetPhase(phase string)`
  - `func (t *activityTracker) BeginDir(index int, dir string)` — 1-based; resets current-dir counters.
  - `func (t *activityTracker) SetDirTotal(total uint64)`
  - `func (t *activityTracker) Progress(dirBytesDone, newChunks, reusedChunks, failedChunks uint64, message string) api.BackupProgressStats` — recomputes percent/ETA, stores, emits `onStats`, returns the stats.
  - `func (t *activityTracker) EntryDone(path string, size uint64, isDir bool)`
  - `func (t *activityTracker) EndDir(dirBytes, dirTotal uint64)`
  - `func (t *activityTracker) Log(level, msg string)`
  - `func (t *activityTracker) EndRun(success bool, outcome, message string)`
  - `func (t *activityTracker) Snapshot() api.ActivitySnapshot`
  - `func (t *activityTracker) LogSince(seq uint64) ([]api.RunLogEntry, uint64)`

- [ ] **Step 1: Write the failing test**

```go
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
	mu.Lock()
	defer mu.Unlock()
	if len(runs) != 2 || !runs[0].Running || runs[1].Running {
		t.Errorf("onRun sink calls: %+v", runs)
	}
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `Set-Location gui; go test -run TestActivityTracker ./...`
Expected: `undefined: newActivityTracker`.

- [ ] **Step 3: Implement `gui/backup_activity.go`**

```go
package main

import (
	"fmt"
	"sync"
	"time"

	"github.com/tizbac/proxmoxbackupclient_go/gui/api"
)

// activityTracker is the single source of truth for "what is the backup doing
// right now" in this process. The engine feeds it directly — whether the run was
// started by the GUI, by the local API, or by the scheduler — which is what lets
// the service-mode GUI show real progress and join a run it did not start.
//
// Only one run is tracked at a time: the per-destination backup mutex serialises
// runs against the same PBS; two runs to different servers would overlap here and
// the later BeginRun wins. That is a known limitation, not a data-loss risk (the
// per-run log files are untouched).
type activityTracker struct {
	mu   sync.Mutex
	snap api.ActivitySnapshot
	log  *RunLog

	meter     *throughputMeter
	startedAt time.Time

	// Run-level byte accounting. ChunkState reports bytes per directory (its pos
	// restarts for every PXAR stream), so the finished directories are summed here
	// and the current one is added on top to get a run-wide percent.
	completedBytes uint64
	completedTotal uint64
	curDone        uint64
	curTotal       uint64 // 0 until the background size scan of the current dir finishes
	lastPercent    float64

	// Sinks are process-level (registered once at GUI startup), not per run.
	onRun   func(api.ActivitySnapshot)
	onStats func(api.BackupProgressStats)
	onLog   func([]api.RunLogEntry)

	pendingLog       []api.RunLogEntry
	logFlushInterval time.Duration
	flushStop        chan struct{}
}

var activity = newActivityTracker()

func newActivityTracker() *activityTracker {
	return &activityTracker{
		log:              NewRunLog(runLogCapacity),
		meter:            newThroughputMeter(30 * time.Second),
		logFlushInterval: 250 * time.Millisecond,
	}
}

func (t *activityTracker) SetSinks(onRun func(api.ActivitySnapshot), onStats func(api.BackupProgressStats), onLog func([]api.RunLogEntry)) {
	t.mu.Lock()
	t.onRun, t.onStats, t.onLog = onRun, onStats, onLog
	t.mu.Unlock()
}

// BeginRun resets all per-run state and announces the new run. Returns the run id.
func (t *activityTracker) BeginRun(backupID, target string, dirCount int) string {
	t.mu.Lock()
	if t.flushStop != nil {
		close(t.flushStop)
		t.flushStop = nil
	}
	now := time.Now()
	t.startedAt = now
	t.log.Reset()
	t.meter.Reset()
	t.completedBytes, t.completedTotal, t.curDone, t.curTotal, t.lastPercent = 0, 0, 0, 0, 0
	t.pendingLog = nil
	t.snap = api.ActivitySnapshot{
		Running:   true,
		RunID:     fmt.Sprintf("%d-%s", now.UnixNano(), backupID),
		BackupID:  backupID,
		Target:    target,
		StartTime: now.Format(time.RFC3339),
		Stats:     api.BackupProgressStats{Phase: "connect", DirCount: dirCount, EtaSeconds: -1},
		LogNext:   t.log.Next(),
	}
	stop := make(chan struct{})
	t.flushStop = stop
	onRun, snap, interval := t.onRun, t.snap, t.logFlushInterval
	t.mu.Unlock()

	go t.flushLoop(stop, interval)
	if onRun != nil {
		onRun(snap)
	}
	return snap.RunID
}

// flushLoop batches log lines to the onLog sink so a busy walk emits at most a
// few Wails events per second instead of one per file.
func (t *activityTracker) flushLoop(stop chan struct{}, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			t.flushLog()
		case <-stop:
			t.flushLog()
			return
		}
	}
}

func (t *activityTracker) flushLog() {
	t.mu.Lock()
	batch, sink := t.pendingLog, t.onLog
	t.pendingLog = nil
	t.mu.Unlock()
	if sink != nil && len(batch) > 0 {
		sink(batch)
	}
}

func (t *activityTracker) SetPhase(phase string) {
	t.mu.Lock()
	t.snap.Stats.Phase = phase
	t.snap.Stats.ElapsedSeconds = time.Since(t.startedAt).Seconds()
	stats, sink := t.snap.Stats, t.onStats
	t.mu.Unlock()
	if sink != nil {
		sink(stats)
	}
}

func (t *activityTracker) BeginDir(index int, dir string) {
	t.mu.Lock()
	t.curDone, t.curTotal = 0, 0
	t.snap.Stats.DirIndex = index
	t.snap.Stats.CurrentDir = dir
	t.snap.Stats.CurrentFile = ""
	t.snap.Stats.Phase = "upload"
	t.mu.Unlock()
}

func (t *activityTracker) SetDirTotal(total uint64) {
	t.mu.Lock()
	t.curTotal = total
	t.mu.Unlock()
}

// Progress ingests the per-directory counters from ChunkState and turns them into
// the run-level snapshot. Percent is monotonic: BytesTotal can still grow (scan in
// flight) and pxar framing makes done overshoot total, so it is clamped to
// [lastPercent, 0.99] — 1.0 is reserved for EndRun.
func (t *activityTracker) Progress(dirBytesDone, newChunks, reusedChunks, failedChunks uint64, message string) api.BackupProgressStats {
	t.mu.Lock()
	now := time.Now()
	t.curDone = dirBytesDone
	done := t.completedBytes + t.curDone
	total := t.completedTotal + t.curTotal
	st := &t.snap.Stats
	st.Phase = "upload"
	st.BytesDone = done
	st.BytesTotal = total
	st.NewChunks, st.ReusedChunks, st.FailedChunks = newChunks, reusedChunks, failedChunks
	st.Message = message
	st.ElapsedSeconds = now.Sub(t.startedAt).Seconds()
	st.Indeterminate = t.curTotal == 0
	if !st.Indeterminate {
		p := float64(done) / float64(total)
		if p > 0.99 {
			p = 0.99
		}
		if p > t.lastPercent {
			t.lastPercent = p
		}
	}
	st.Percent = t.lastPercent
	t.meter.Add(now, done)
	st.BytesPerSec = t.meter.BytesPerSec(now)
	st.EtaSeconds = t.meter.ETA(now, done, total)
	stats, sink := *st, t.onStats
	t.mu.Unlock()
	if sink != nil {
		sink(stats)
	}
	return stats
}

// EntryDone records a finished file/dir for the counter, the "current file" line
// and the debug-level log stream. These lines are GUI-only on purpose: writing one
// line per file into the per-run log file would multiply its size.
func (t *activityTracker) EntryDone(path string, size uint64, isDir bool) {
	t.mu.Lock()
	t.snap.Stats.CurrentFile = path
	var line string
	if isDir {
		line = "[Dir] " + path
	} else {
		t.snap.Stats.FilesDone++
		line = fmt.Sprintf("[File] %s (%s)", path, formatBytesHuman(size))
	}
	t.appendLogLocked("debug", line)
	t.mu.Unlock()
}

// EndDir folds the finished directory into the run-level totals. dirTotal is the
// scanned size (0 if the scan never finished — then the archived bytes stand in
// so the ratio stays sane).
func (t *activityTracker) EndDir(dirBytes, dirTotal uint64) {
	t.mu.Lock()
	if dirTotal == 0 {
		dirTotal = dirBytes
	}
	t.completedBytes += dirBytes
	t.completedTotal += dirTotal
	t.curDone, t.curTotal = 0, 0
	t.mu.Unlock()
}

func (t *activityTracker) Log(level, msg string) {
	t.mu.Lock()
	t.appendLogLocked(level, msg)
	t.mu.Unlock()
}

func (t *activityTracker) appendLogLocked(level, msg string) {
	e := t.log.Append(level, msg)
	t.snap.LogNext = e.Seq + 1
	if t.onLog != nil {
		t.pendingLog = append(t.pendingLog, e)
	}
}

func (t *activityTracker) EndRun(success bool, outcome, message string) {
	t.mu.Lock()
	if t.flushStop != nil {
		close(t.flushStop)
		t.flushStop = nil
	}
	t.snap.Running = false
	t.snap.Complete = true
	t.snap.Success = success
	t.snap.Outcome = outcome
	t.snap.Message = message
	t.snap.EndTime = time.Now().Format(time.RFC3339)
	t.snap.Stats.Phase = "done"
	t.snap.Stats.Indeterminate = false
	t.snap.Stats.Percent = 1.0
	t.snap.Stats.EtaSeconds = -1
	t.snap.Stats.ElapsedSeconds = time.Since(t.startedAt).Seconds()
	onRun, snap := t.onRun, t.snap
	t.mu.Unlock()
	t.flushLog()
	if onRun != nil {
		onRun(snap)
	}
}

func (t *activityTracker) Snapshot() api.ActivitySnapshot {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.snap.Running {
		t.snap.Stats.ElapsedSeconds = time.Since(t.startedAt).Seconds()
	}
	return t.snap
}

func (t *activityTracker) LogSince(seq uint64) ([]api.RunLogEntry, uint64) {
	return t.log.Since(seq)
}

// formatBytesHuman renders a byte count for log lines ("12.4 KB").
func formatBytesHuman(n uint64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := uint64(unit), 0
	for m := n / unit; m >= unit && exp < 3; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(n)/float64(div), "KMGT"[exp])
}
```

Note on the `EndRun` race with `flushLoop`: `flushLoop` calls `flushLog()` once more after `stop` is closed; `EndRun` also calls it. Both are idempotent (they drain `pendingLog`), so ordering does not matter.

- [ ] **Step 4: Run tests to verify they pass**

Run: `Set-Location gui; go test -run 'TestActivityTracker' ./...`
Expected: PASS. Then `go vet ./...` — expected clean.

- [ ] **Step 5: Commit**

```powershell
git add gui/backup_activity.go gui/backup_activity_test.go
git commit -m "feat(gui): process-wide activity tracker for live backup state" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Wire the engine into the tracker

**Files:**
- Modify: `gui/backup_inline.go` — `ChunkState` struct + `Init` (lines 160-200), the progress block in `HandleData` (lines 270-330), `RunBackupInline` (lines 448-900), `backupDirectory` / `backupReal` (lines 955-1100)
- Modify: `gui/logging_gui.go:128-138` and `gui/logging_service.go:128-138` (`writeBackupLog`)
- Modify: `gui/main.go:895-935` (`startBackupDirect`'s `opts.OnStats` block)
- Test: existing suites + both builds (no new unit test; the tracker is unit-tested, this task is wiring — verified by build + a targeted grep)

**Interfaces:**
- Consumes: `activity.*` (Task 5), `PXARArchive.OnEntry` (Task 1).
- Changes: `ChunkState.Init` loses the `onStats` parameter; `backupDirectory` / `backupReal` lose their `onStats` parameter. `BackupOptions.OnStats` stays (main.go still sets it) but is now fed by the tracker's sink, see Step 6.

- [ ] **Step 1: `ChunkState` reports to the tracker**

In `gui/backup_inline.go`:

1. Remove the fields `onStats` and `lastProgressPercent` from `ChunkState`; keep `currentDir` (used for the log message) and `totalSize`.
2. Change the signature to
   `func (c *ChunkState) Init(newchunk *atomic.Uint64, reusechunk *atomic.Uint64, failedchunk *atomic.Uint64, knownChunks *hashmap.Map[string, bool], onProgress func(float64, string), totalSize *atomic.Uint64, currentDir string)`
   and delete the `c.onStats = onStats` and `c.lastProgressPercent = 0.0` lines in its body.
3. Replace the block in `HandleData` from `// Calculate progress based on total size if available` down to and including the `if c.onStats != nil { ... }` block with:

```go
				// Run-level percent / ETA are owned by the activity tracker; it also
				// forwards the structured stats to the GUI. The 10%→90% mapping that
				// used to live here is gone: the bar now shows real bytes.
				stats := activity.Progress(c.pos, c.newchunk.Load(), c.reusechunk.Load(), failed, msg)
				c.onProgress(stats.Percent, msg)
```

   Keep the `msg` construction above it (the "Traité: … MB" strings) — but now build the `/ total` variant from `totalSize` exactly as before, i.e. keep:

```go
				totalSize := c.totalSize.Load()
				if totalSize > 0 {
					if failed > 0 {
						msg = fmt.Sprintf("Traité: %d / %d MB (New: %d, Reused: %d, ⚠️ Failed: %d chunks)",
							sizeMB, totalSize/(1024*1024), c.newchunk.Load(), c.reusechunk.Load(), failed)
					} else {
						msg = fmt.Sprintf("Traité: %d / %d MB (New: %d, Reused: %d chunks)",
							sizeMB, totalSize/(1024*1024), c.newchunk.Load(), c.reusechunk.Load())
					}
				}
```

   The `c.onProgress != nil` guard on the enclosing `if` stays as is, so the catalog stream (`onProgress == nil`) never reports.

- [ ] **Step 2: `backupReal` feeds directory totals, phases and entries**

In `backupReal` (drop the `onStats` parameter from its signature and from `backupDirectory`'s, and from the two call sites `backupDirectory(...)` in `RunBackupInline` and `backupReal(...)` in `backupDirectory`):

1. In the background size goroutine, after `totalSize.Store(size)` add:
```go
		activity.SetDirTotal(size)
```
2. After `archive.ExcludeRoot = originalPath` add:
```go
	// Live per-entry feed for the Activity tab. Paths are mapped from the VSS
	// shadow path back to the logical root the user selected.
	archive.OnEntry = func(p string, size uint64, isDir bool) {
		if backupdir != originalPath && strings.HasPrefix(p, backupdir) {
			p = originalPath + strings.TrimPrefix(p, backupdir)
		}
		activity.EntryDone(p, size, isDir)
	}
```
3. Change the two `Init` calls to the new signature:
```go
	pxarChunk.Init(newchunk, reusechunk, failedchunk, knownChunks, progress, totalSize, backupdir)
	pcat1Chunk.Init(newchunk, reusechunk, failedchunk, knownChunks, nil, totalSize, "")
```
4. Immediately after the `archive.WriteDir(...)` call succeeds (before `logicalSkipped := ...`) add:
```go
	activity.SetPhase("finalize")
```
5. Find where `backupReal` returns its byte count on success (the final `return <bytes>, nil` — look for the value that becomes `dirBytes` in `RunBackupInline`, it is `pxarChunk.pos` or the variable holding it). Immediately before that return add:
```go
	activity.EndDir(pxarChunk.pos, totalSize.Load())
```
   (If the returned variable is named differently, use that variable in place of `pxarChunk.pos`; do not add a new one.)

In `backupDirectory`, inside `if usevss {` before `snapshot.CreateVSSSnapshot(` add:
```go
		activity.SetPhase("vss")
```

- [ ] **Step 3: `RunBackupInline` begins/ends the run and marks directories**

1. Immediately after `defer EndBackupRunLog(runLogger)` add:
```go
	// Announce the run to the activity tracker (GUI Activity tab / API /activity).
	// Target is filled in once options are validated; BackupID may still be empty
	// here and is corrected below once it is generated.
	activity.BeginRun(opts.BackupID, fmt.Sprintf("%s/%s", opts.BaseURL, opts.Datastore), len(opts.BackupDirs))
	runEnded := false
	endRun := func(success bool, outcome, message string) {
		if runEnded {
			return
		}
		runEnded = true
		activity.EndRun(success, outcome, message)
	}
	defer func() {
		// Any early return / panic path that did not report explicitly ends the
		// run as failed so the GUI never shows a stuck "running" state.
		if returnErr != nil {
			endRun(false, string(OutcomeFailed), returnErr.Error())
		} else {
			endRun(false, string(OutcomeFailed), "backup ended without result")
		}
	}()
```
   The deferred closure must be registered **after** the existing panic-recovery defer so it runs first (defers run LIFO) — place it right after the recover defer block, i.e. after `}()` of the `recover()` defer. Then move the `activity.BeginRun(...)` line to sit just before the recover defer (order of the two lines: `BeginRun`, then the recover defer, then the `runEnded`/`endRun`/deferred-end block).

2. After `writeBackupLog(fmt.Sprintf("[DEBUG] BackupID set to: %s", opts.BackupID))` add:
```go
	activity.Log("info", "Backup ID: "+opts.BackupID)
```
   (`BeginRun` was called with a possibly-empty id; the snapshot's `BackupID` is corrected by the next line in Step 4 below.)

3. Before `writeBackupLog("[DEBUG] Creating PBS client struct")` add:
```go
	activity.SetPhase("connect")
```

4. In the directory loop, right after `writeBackupLog(fmt.Sprintf("Starting backup of directory %d/%d: %s", ...))` add:
```go
		activity.BeginDir(idx+1, dir)
```

5. Every terminal path must call `endRun`. There are exactly these: 
   - the validation failure early return near `writeBackupLog("[ERROR] " + errMsg)` (line ~501): the deferred closure covers it via `returnErr` — ensure that path returns a non-nil error (it does).
   - the "all directories failed" block: after `opts.OnResult(status)` / before `return fmt.Errorf("%s", errMsg)` add `endRun(false, string(status.Outcome), errMsg)`.
   - the success/partial end of the function: find where the final `BackupStatus` (`status`) is built and `opts.OnComplete` / `opts.OnResult` fire (after the "Determine the authoritative 4-level outcome" comment). Immediately after the `opts.OnResult(status)` call there add:
```go
	endRun(status.Outcome != OutcomeFailed, string(status.Outcome), completionMsg)
```
   Check the actual variable names at that site (`status`, `completionMsg`) and use them.

- [ ] **Step 4: Fix `BackupID` in the snapshot once generated**

Add to `gui/backup_activity.go`:

```go
// SetBackupID corrects the id announced by BeginRun once the engine has derived
// it (the id is generated after BeginRun when the caller left it empty).
func (t *activityTracker) SetBackupID(id string) {
	t.mu.Lock()
	t.snap.BackupID = id
	t.mu.Unlock()
}
```

and in `RunBackupInline`, after the `activity.Log("info", "Backup ID: "+opts.BackupID)` line from Step 3.2, add `activity.SetBackupID(opts.BackupID)`.

- [ ] **Step 5: Mirror `writeBackupLog` into the tracker**

In **both** `gui/logging_gui.go` and `gui/logging_service.go`, change `writeBackupLog` to:

```go
// writeBackupLog writes to backup log (backup operations).
// Prefers the per-run logger if one is active, else falls back to the global.
// Every line except chunk-level noise is mirrored into the in-memory run log
// that feeds the GUI Activity tab; the file keeps the full detail.
func writeBackupLog(message string) {
	if !strings.HasPrefix(message, "New chunk[") && !strings.HasPrefix(message, "Reuse chunk[") {
		activity.Log(classifyLogLevel(message), message)
	}

	currentBackupLoggerMu.RLock()
	perRun := currentBackupLogger
	currentBackupLoggerMu.RUnlock()

	if perRun != nil {
		writeLogToLogger(perRun, "BACKUP", message)
		return
	}
	writeLogToLogger(backupLogger, "BACKUP", message)
}
```

Add `"strings"` to both files' imports if missing.

- [ ] **Step 6: `main.go` registers sinks instead of `opts.OnStats`**

In `gui/main.go`, delete the `opts.OnStats = func(stats *BackupProgressStats) { ... }` block in `startBackupDirect` (the one emitting `backup:stats`). Then in `startup()` (`gui/main.go:205`), right after `a.ctx = ctx`, add:

```go
	// Live activity feed for the Activity tab (standalone mode: the engine runs
	// in this process). In service mode the same events are re-emitted by
	// activityPoller from the service's /activity endpoints, so the frontend has
	// one code path. Guarded on a.ctx so a headless App never touches Wails.
	activity.SetSinks(
		func(s api.ActivitySnapshot) {
			if a.ctx != nil {
				runtime.EventsEmit(a.ctx, "activity:run", s)
			}
		},
		func(s api.BackupProgressStats) {
			if a.ctx != nil {
				runtime.EventsEmit(a.ctx, "backup:stats", s)
			}
		},
		func(entries []api.RunLogEntry) {
			if a.ctx != nil {
				runtime.EventsEmit(a.ctx, "backup:log", map[string]interface{}{"entries": entries})
			}
		},
	)
```

Remove the now-unused `OnStats` field from `BackupOptions` (`gui/backup_inline.go:50-52`) and its comment. Grep to confirm no other user: `Select-String -Path gui\*.go -Pattern 'OnStats'` must return nothing.

- [ ] **Step 7: Build both binaries, run the suites**

```powershell
Set-Location gui; go build ./...; go build -tags service ./...; go vet ./...
go test -skip 'TestConfigSaveLoad|TestGetConfigPath' ./...
Select-String -Path gui\*.go -Pattern 'lastProgressPercent|OnStats|onStats'
```
Expected: both builds OK, vet clean, tests PASS, the grep returns nothing.

- [ ] **Step 8: Commit**

```powershell
git add gui/backup_inline.go gui/backup_activity.go gui/logging_gui.go gui/logging_service.go gui/main.go
git commit -m "feat(gui): feed the activity tracker from the backup engine; bytes-based percent" -m "Replaces the 10-90% progress mapping with run-level bytes/total, mirrors backup log lines into the in-memory run log, and reports phases, per-file entries and directory totals." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: `/activity` endpoints, client methods and `App` accessors

**Files:**
- Modify: `gui/api/server.go` (routes + two handlers), `gui/api/client.go` (two methods)
- Create: `gui/app_activity.go` (untagged)
- Test: `gui/api/server_activity_test.go` (new)

**Interfaces:**
- Produces (package `api`):
  - `type ActivityProvider interface { GetActivity() ActivitySnapshot; GetActivityLog(since uint64) ActivityLogResponse }`
  - `GET /activity`, `GET /activity/log?since=<n>`
  - `func (c *Client) GetActivity() (*ActivitySnapshot, error)`
  - `func (c *Client) GetActivityLog(since uint64) (*ActivityLogResponse, error)`
- Produces (package `main`): `func (a *App) GetActivity() api.ActivitySnapshot`, `func (a *App) GetActivityLog(since uint64) api.ActivityLogResponse` — Wails-bound in the GUI, API-visible in the service.

- [ ] **Step 1: Write the failing server test**

```go
package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// fakeHandler satisfies BackupHandler with no-ops plus ActivityProvider.
type fakeHandler struct {
	snap ActivitySnapshot
	log  []RunLogEntry
}

func (f *fakeHandler) StartBackup(string, []string, []string, []string, string, bool, string) error {
	return nil
}
func (f *fakeHandler) GetConfigWithHostname() map[string]interface{}       { return map[string]interface{}{} }
func (f *fakeHandler) GetScheduledJobsForAPI() []map[string]interface{}    { return nil }
func (f *fakeHandler) SaveScheduledJobFromMap(map[string]interface{}) error { return nil }
func (f *fakeHandler) UpdateScheduledJobFromMap(map[string]interface{}) error {
	return nil
}
func (f *fakeHandler) DeleteScheduledJobFromMap(string) error   { return nil }
func (f *fakeHandler) PinServerFingerprint(string, string) error { return nil }
func (f *fakeHandler) GetActivity() ActivitySnapshot            { return f.snap }
func (f *fakeHandler) GetActivityLog(since uint64) ActivityLogResponse {
	var out []RunLogEntry
	for _, e := range f.log {
		if e.Seq >= since {
			out = append(out, e)
		}
	}
	next := uint64(1)
	if n := len(f.log); n > 0 {
		next = f.log[n-1].Seq + 1
	}
	return ActivityLogResponse{Entries: out, Next: next}
}

// noActivityHandler is a BackupHandler WITHOUT ActivityProvider.
type noActivityHandler struct{ fakeHandler }

func (noActivityHandler) GetActivity() {} // wrong signature on purpose: does not satisfy ActivityProvider

func newTestServer(t *testing.T, h BackupHandler) (*httptest.Server, string) {
	t.Helper()
	const token = "t0k3n"
	s := NewServer("127.0.0.1:0", h, token, "test")
	ts := httptest.NewServer(s.authMiddleware(s.mux))
	t.Cleanup(ts.Close)
	return ts, token
}

func get(t *testing.T, url, token, origin string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	if token != "" {
		req.Header.Set(tokenHeader, token)
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

func TestActivityEndpointAuth(t *testing.T) {
	ts, token := newTestServer(t, &fakeHandler{})
	if r := get(t, ts.URL+"/activity", "", ""); r.StatusCode != http.StatusUnauthorized {
		t.Errorf("no token: %d want 401", r.StatusCode)
	}
	if r := get(t, ts.URL+"/activity", token, "http://evil"); r.StatusCode != http.StatusForbidden {
		t.Errorf("origin set: %d want 403", r.StatusCode)
	}
	if r := get(t, ts.URL+"/activity", token, ""); r.StatusCode != http.StatusOK {
		t.Errorf("ok: %d want 200", r.StatusCode)
	}
}

func TestActivitySnapshotEndpoint(t *testing.T) {
	h := &fakeHandler{snap: ActivitySnapshot{Running: true, RunID: "r1", Stats: BackupProgressStats{Percent: 0.42}}}
	ts, token := newTestServer(t, h)
	r := get(t, ts.URL+"/activity", token, "")
	var got ActivitySnapshot
	if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if !got.Running || got.RunID != "r1" || got.Stats.Percent != 0.42 {
		t.Errorf("got %+v", got)
	}
}

func TestActivityLogEndpointPaging(t *testing.T) {
	h := &fakeHandler{log: []RunLogEntry{{Seq: 1, Msg: "a"}, {Seq: 2, Msg: "b"}, {Seq: 3, Msg: "c"}}}
	ts, token := newTestServer(t, h)

	r := get(t, ts.URL+"/activity/log", token, "")
	var all ActivityLogResponse
	if err := json.NewDecoder(r.Body).Decode(&all); err != nil {
		t.Fatal(err)
	}
	if len(all.Entries) != 3 || all.Next != 4 {
		t.Errorf("default since: %+v", all)
	}

	r = get(t, ts.URL+"/activity/log?since=3", token, "")
	var tail ActivityLogResponse
	_ = json.NewDecoder(r.Body).Decode(&tail)
	if len(tail.Entries) != 1 || tail.Entries[0].Msg != "c" || tail.Next != 4 {
		t.Errorf("since=3: %+v", tail)
	}

	if r := get(t, ts.URL+"/activity/log?since=abc", token, ""); r.StatusCode != http.StatusBadRequest {
		t.Errorf("bad since: %d want 400", r.StatusCode)
	}
	if r := get(t, ts.URL+"/activity/log?since=-1", token, ""); r.StatusCode != http.StatusBadRequest {
		t.Errorf("negative since: %d want 400", r.StatusCode)
	}
}

func TestActivityWithoutProviderIs503(t *testing.T) {
	ts, token := newTestServer(t, noActivityHandler{})
	if r := get(t, ts.URL+"/activity", token, ""); r.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("no provider: %d want 503", r.StatusCode)
	}
	if r := get(t, ts.URL+"/activity/log", token, ""); r.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("no provider (log): %d want 503", r.StatusCode)
	}
}

func TestActivityMethodNotAllowed(t *testing.T) {
	ts, token := newTestServer(t, &fakeHandler{})
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/activity", nil)
	req.Header.Set(tokenHeader, token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("POST: %d want 405", resp.StatusCode)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `Set-Location gui/api; go test ./...`
Expected: compile error `undefined: ActivityProvider` … or, once types compile, 404s on `/activity` (route missing). Either is the expected red.

- [ ] **Step 3: Implement routes and handlers in `gui/api/server.go`**

Add to imports: `"strconv"`.

Add after the `BackupHandler` interface:

```go
// ActivityProvider is the optional interface through which the API serves the
// live backup state (GUI Activity tab). It is optional so older handlers still
// satisfy BackupHandler; the routes answer 503 when it is missing.
type ActivityProvider interface {
	GetActivity() ActivitySnapshot
	GetActivityLog(since uint64) ActivityLogResponse
}
```

In `setupRoutes()` add:

```go
	s.mux.HandleFunc("/activity", s.handleActivity)
	s.mux.HandleFunc("/activity/log", s.handleActivityLog)
```

Add the handlers:

```go
func (s *Server) handleActivity(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		s.writeError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	provider, ok := s.app.(ActivityProvider)
	if !ok {
		s.writeError(w, "activity not available", http.StatusServiceUnavailable)
		return
	}
	s.writeJSON(w, provider.GetActivity(), http.StatusOK)
}

// handleActivityLog pages the in-memory run log: ?since=<seq> returns entries
// with Seq >= since (default 0 = everything retained). The ring is bounded
// (2000 lines), so the response is too.
func (s *Server) handleActivityLog(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		s.writeError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	provider, ok := s.app.(ActivityProvider)
	if !ok {
		s.writeError(w, "activity not available", http.StatusServiceUnavailable)
		return
	}
	var since uint64
	if raw := r.URL.Query().Get("since"); raw != "" {
		n, err := strconv.ParseUint(raw, 10, 64)
		if err != nil {
			s.writeError(w, "since must be a non-negative integer", http.StatusBadRequest)
			return
		}
		since = n
	}
	s.writeJSON(w, provider.GetActivityLog(since), http.StatusOK)
}
```

- [ ] **Step 4: Client methods in `gui/api/client.go`**

Append:

```go
// GetActivity returns the service's current backup activity snapshot.
func (c *Client) GetActivity() (*ActivitySnapshot, error) {
	resp, err := c.httpClient.Get(c.baseURL + "/activity")
	if err != nil {
		return nil, fmt.Errorf("failed to get activity: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("service returned error: %d", resp.StatusCode)
	}
	var snap ActivitySnapshot
	if err := json.NewDecoder(resp.Body).Decode(&snap); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}
	return &snap, nil
}

// GetActivityLog returns run-log entries with Seq >= since.
func (c *Client) GetActivityLog(since uint64) (*ActivityLogResponse, error) {
	resp, err := c.httpClient.Get(fmt.Sprintf("%s/activity/log?since=%d", c.baseURL, since))
	if err != nil {
		return nil, fmt.Errorf("failed to get activity log: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("service returned error: %d", resp.StatusCode)
	}
	var out ActivityLogResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}
	return &out, nil
}
```

- [ ] **Step 5: Run api tests**

Run: `Set-Location gui/api; go test ./...`
Expected: PASS.

- [ ] **Step 6: `App` accessors — `gui/app_activity.go` (no build tag)**

```go
package main

import (
	"github.com/tizbac/proxmoxbackupclient_go/gui/api"
)

// GetActivity returns the live backup state for the Activity tab. In the GUI
// process running in service mode the engine lives in the service, so the
// snapshot is proxied over the local API; everywhere else (standalone GUI, the
// service process itself answering /activity) it is read from the in-process
// tracker. Wails-bound; also satisfies api.ActivityProvider for the API server.
func (a *App) GetActivity() api.ActivitySnapshot {
	if !a.isServiceProcess && a.mode == api.ModeService && a.apiClient != nil {
		if snap, err := a.apiClient.GetActivity(); err == nil {
			return *snap
		}
		writeDebugLog("[Activity] service snapshot unavailable, falling back to local tracker")
	}
	return activity.Snapshot()
}

// GetActivityLog pages the run log (entries with seq >= since). Same routing as
// GetActivity.
func (a *App) GetActivityLog(since uint64) api.ActivityLogResponse {
	if !a.isServiceProcess && a.mode == api.ModeService && a.apiClient != nil {
		if out, err := a.apiClient.GetActivityLog(since); err == nil {
			return *out
		}
	}
	entries, next := activity.LogSince(since)
	if entries == nil {
		entries = []api.RunLogEntry{}
	}
	return api.ActivityLogResponse{Entries: entries, Next: next}
}
```

- [ ] **Step 7: Build both binaries**

```powershell
Set-Location gui; go build ./...; go build -tags service ./...; go vet ./...
```
Expected: both succeed. (The service build's `App` now satisfies `api.ActivityProvider` automatically — verify with a compile-time assertion added at the bottom of `gui/app_activity.go`: `var _ api.ActivityProvider = (*App)(nil)`.)

- [ ] **Step 8: Commit**

```powershell
git add gui/api/server.go gui/api/client.go gui/api/server_activity_test.go gui/app_activity.go
git commit -m "feat(api): /activity and /activity/log endpoints with client and App accessors" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: GUI service-mode poller

**Files:**
- Modify: `gui/main.go` — `startup()` (line ~205), `StartBackup()` mode re-detect (line ~630), `pollBackupProgress()` interval (line ~685)
- Modify: `gui/app_types.go` — one new field

**Interfaces:**
- Consumes: `api.Client.GetActivity/GetActivityLog` (Task 7).
- Produces: Wails events `activity:run`, `backup:stats`, `backup:log` in service mode with the same payload shapes as the standalone sinks (Task 6 Step 6).

- [ ] **Step 1: Add the once-guard field**

In `gui/app_types.go` `App` struct add:

```go
	activityPollOnce sync.Once // activityPoller is started at most once per GUI process
```

- [ ] **Step 2: Implement the poller in `gui/main.go`**

Add (anywhere after `pollBackupProgress`):

```go
// startActivityPoller starts the service-mode activity poller exactly once.
// Called from startup() when the GUI detects the service and from StartBackup()
// when the mode flips to service later.
func (a *App) startActivityPoller() {
	a.activityPollOnce.Do(func() { go a.activityPoller() })
}

// activityPoller mirrors the service's /activity state into the same Wails
// events the standalone sinks emit, so the frontend has one code path. It also
// covers late join: a scheduled backup already running in the service shows up
// as soon as the GUI opens. It never gives up — the service can come and go.
func (a *App) activityPoller() {
	var lastRunID string
	var lastRunning, lastComplete bool
	var since uint64
	for {
		interval := 3 * time.Second
		snap, err := a.apiClient.GetActivity()
		if err != nil {
			writeDebugLog(fmt.Sprintf("[Activity] poll failed: %v", err))
			time.Sleep(interval)
			continue
		}
		if snap.RunID != lastRunID {
			since = 0
		}
		changed := snap.RunID != lastRunID || snap.Running != lastRunning || snap.Complete != lastComplete
		if a.ctx != nil && (snap.Running || changed) {
			runtime.EventsEmit(a.ctx, "activity:run", *snap)
			runtime.EventsEmit(a.ctx, "backup:stats", snap.Stats)
		}
		if snap.Running || changed {
			if lg, err := a.apiClient.GetActivityLog(since); err == nil {
				if len(lg.Entries) > 0 && a.ctx != nil {
					runtime.EventsEmit(a.ctx, "backup:log", map[string]interface{}{"entries": lg.Entries})
				}
				since = lg.Next
			}
		}
		lastRunID, lastRunning, lastComplete = snap.RunID, snap.Running, snap.Complete
		if snap.Running {
			interval = time.Second
		}
		time.Sleep(interval)
	}
}
```

- [ ] **Step 3: Start it**

In `startup()`, in the `else` branch (`writeDebugLog("Service mode detected - scheduler runs in service")`), add `a.startActivityPoller()`.

In `StartBackup()`, inside `if a.apiClient.IsServiceAvailable() { ... a.mode = api.ModeService }` add `a.startActivityPoller()` after the mode assignment.

In `pollBackupProgress()` change `time.NewTicker(3 * time.Second)` to `time.NewTicker(1 * time.Second)` and `const maxConsecutiveErrors = 20 // ~60s at 3s interval` to `const maxConsecutiveErrors = 60 // ~60s at 1s interval`. Update the comment on `scheduleEviction` in `gui/api/server.go` ("polling every 3s" → "polling every 1s").

- [ ] **Step 4: Build and vet**

```powershell
Set-Location gui; go build ./...; go build -tags service ./...; go vet ./...
```
Expected: OK.

- [ ] **Step 5: Commit**

```powershell
git add gui/main.go gui/app_types.go gui/api/server.go
git commit -m "feat(gui): poll service activity into Wails events; 1s progress polling" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Translations

**Files:**
- Modify: `gui/frontend/src/i18n/translations.js` — add the same keys to `fr`, `en`, `de` (insert each block right after that language's `tabAbout:` line).

**Interfaces:**
- Produces keys used by Tasks 10–11: `tabActivity`, `activityTitle`, `activityLede`, `activityEmpty`, `activityGoToBackup`, `activityPhaseConnect`, `activityPhaseVss`, `activityPhaseUpload`, `activityPhaseFinalize`, `activityPhaseDone`, `activityScanning`, `activityEta`, `activityElapsed`, `activitySpeed`, `activityFiles`, `activityData`, `activityChunks`, `activityChunksNew`, `activityChunksReused`, `activityChunksFailed`, `activityDedup`, `activityCurrent`, `activityDirOf`, `activityLog`, `activityFilterAll`, `activityFilterInfo`, `activityFilterWarn`, `activityFilterError`, `activityAutoscroll`, `activityCopy`, `activityCopied`, `activityNewLines`, `activityOlderDropped`, `activitySummary`, `activityOutcomeSuccess`, `activityOutcomeFailed`, `activityOutcomePartial`, `activityOutcomePolicy`, `activityUnknown`, `activityOpenActivity`, `activityLostContact`.

- [ ] **Step 1: Add the `en` block**

```js
    tabActivity: "Activity",
    activityTitle: "Backup activity",
    activityLede: "Live progress, statistics and log of the running backup.",
    activityEmpty: "No backup has run since the app was opened.",
    activityGoToBackup: "Go to Backup",
    activityOpenActivity: "Open Activity",
    activityPhaseConnect: "Connecting",
    activityPhaseVss: "Creating shadow copy",
    activityPhaseUpload: "Uploading",
    activityPhaseFinalize: "Finalizing",
    activityPhaseDone: "Finished",
    activityScanning: "Measuring folder size…",
    activityEta: "Remaining",
    activityElapsed: "Elapsed",
    activitySpeed: "Speed",
    activityFiles: "Files",
    activityData: "Data",
    activityChunks: "Chunks",
    activityChunksNew: "new",
    activityChunksReused: "reused",
    activityChunksFailed: "failed",
    activityDedup: "Deduplicated",
    activityCurrent: "Current",
    activityDirOf: "Folder {i} of {n}",
    activityLog: "Log",
    activityFilterAll: "All",
    activityFilterInfo: "Info and above",
    activityFilterWarn: "Warnings and errors",
    activityFilterError: "Errors only",
    activityAutoscroll: "Auto-scroll",
    activityCopy: "Copy",
    activityCopied: "Copied",
    activityNewLines: "New lines ↓",
    activityOlderDropped: "… older lines dropped (see the log file for the full run) …",
    activitySummary: "{outcome} in {duration} — {data}, {files} files, {newChunks} new / {reusedChunks} reused chunks",
    activityOutcomeSuccess: "Backup completed",
    activityOutcomeFailed: "Backup failed",
    activityOutcomePartial: "Backup completed partially",
    activityOutcomePolicy: "Backup completed (with policy exclusions)",
    activityUnknown: "—",
    activityLostContact: "Lost contact with the backup service",
```

- [ ] **Step 2: Add the `fr` block**

```js
    tabActivity: "Activité",
    activityTitle: "Activité de sauvegarde",
    activityLede: "Progression, statistiques et journal en direct de la sauvegarde en cours.",
    activityEmpty: "Aucune sauvegarde n'a été lancée depuis l'ouverture de l'application.",
    activityGoToBackup: "Aller à Sauvegarde",
    activityOpenActivity: "Ouvrir l'activité",
    activityPhaseConnect: "Connexion",
    activityPhaseVss: "Création du cliché instantané",
    activityPhaseUpload: "Envoi",
    activityPhaseFinalize: "Finalisation",
    activityPhaseDone: "Terminé",
    activityScanning: "Mesure de la taille du dossier…",
    activityEta: "Restant",
    activityElapsed: "Écoulé",
    activitySpeed: "Débit",
    activityFiles: "Fichiers",
    activityData: "Données",
    activityChunks: "Chunks",
    activityChunksNew: "nouveaux",
    activityChunksReused: "réutilisés",
    activityChunksFailed: "échoués",
    activityDedup: "Dédupliqué",
    activityCurrent: "En cours",
    activityDirOf: "Dossier {i} sur {n}",
    activityLog: "Journal",
    activityFilterAll: "Tout",
    activityFilterInfo: "Info et plus",
    activityFilterWarn: "Avertissements et erreurs",
    activityFilterError: "Erreurs uniquement",
    activityAutoscroll: "Défilement auto",
    activityCopy: "Copier",
    activityCopied: "Copié",
    activityNewLines: "Nouvelles lignes ↓",
    activityOlderDropped: "… lignes plus anciennes supprimées (voir le fichier journal pour l'intégralité) …",
    activitySummary: "{outcome} en {duration} — {data}, {files} fichiers, {newChunks} nouveaux / {reusedChunks} chunks réutilisés",
    activityOutcomeSuccess: "Sauvegarde terminée",
    activityOutcomeFailed: "Sauvegarde échouée",
    activityOutcomePartial: "Sauvegarde partiellement terminée",
    activityOutcomePolicy: "Sauvegarde terminée (avec exclusions de politique)",
    activityUnknown: "—",
    activityLostContact: "Connexion au service de sauvegarde perdue",
```

- [ ] **Step 3: Add the `de` block**

```js
    tabActivity: "Aktivität",
    activityTitle: "Sicherungsaktivität",
    activityLede: "Fortschritt, Statistiken und Protokoll der laufenden Sicherung in Echtzeit.",
    activityEmpty: "Seit dem Öffnen der App wurde keine Sicherung gestartet.",
    activityGoToBackup: "Zur Sicherung",
    activityOpenActivity: "Aktivität öffnen",
    activityPhaseConnect: "Verbinden",
    activityPhaseVss: "Schattenkopie wird erstellt",
    activityPhaseUpload: "Übertragung",
    activityPhaseFinalize: "Abschluss",
    activityPhaseDone: "Fertig",
    activityScanning: "Ordnergröße wird ermittelt…",
    activityEta: "Verbleibend",
    activityElapsed: "Verstrichen",
    activitySpeed: "Geschwindigkeit",
    activityFiles: "Dateien",
    activityData: "Daten",
    activityChunks: "Blöcke",
    activityChunksNew: "neu",
    activityChunksReused: "wiederverwendet",
    activityChunksFailed: "fehlgeschlagen",
    activityDedup: "Dedupliziert",
    activityCurrent: "Aktuell",
    activityDirOf: "Ordner {i} von {n}",
    activityLog: "Protokoll",
    activityFilterAll: "Alle",
    activityFilterInfo: "Info und höher",
    activityFilterWarn: "Warnungen und Fehler",
    activityFilterError: "Nur Fehler",
    activityAutoscroll: "Automatisch scrollen",
    activityCopy: "Kopieren",
    activityCopied: "Kopiert",
    activityNewLines: "Neue Zeilen ↓",
    activityOlderDropped: "… ältere Zeilen verworfen (vollständiger Lauf in der Protokolldatei) …",
    activitySummary: "{outcome} in {duration} — {data}, {files} Dateien, {newChunks} neue / {reusedChunks} wiederverwendete Blöcke",
    activityOutcomeSuccess: "Sicherung abgeschlossen",
    activityOutcomeFailed: "Sicherung fehlgeschlagen",
    activityOutcomePartial: "Sicherung teilweise abgeschlossen",
    activityOutcomePolicy: "Sicherung abgeschlossen (mit Richtlinien-Ausschlüssen)",
    activityUnknown: "—",
    activityLostContact: "Verbindung zum Sicherungsdienst verloren",
```

- [ ] **Step 4: Verify key parity across languages**

Run (PowerShell, from `gui/frontend`):
```powershell
node -e "import('./src/i18n/translations.js').then(m=>{const t=m.default;const k=Object.keys(t.en).filter(x=>x.startsWith('activity')||x==='tabActivity');for(const l of ['fr','de']){const miss=k.filter(x=>!(x in t[l]));if(miss.length){console.error(l,'missing',miss);process.exit(1)}}console.log('ok',k.length)})"
```
Expected: `ok 42`.

- [ ] **Step 5: Commit**

```powershell
git add gui/frontend/src/i18n/translations.js
git commit -m "feat(i18n): strings for the backup activity tab (fr/en/de)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: `ActivityPanel` component and styles

**Files:**
- Create: `gui/frontend/src/components/ActivityPanel.jsx`
- Modify: `gui/frontend/src/index.css` (append)

**Interfaces:**
- Consumes: translation keys (Task 9); the `activity` state shape from Task 11's reducer: `{ run: ActivitySnapshot|null, stats: BackupProgressStats|null, log: RunLogEntry[], nextSeq: number, dropped: boolean }` (snake_case keys exactly as the Go JSON tags).
- Produces: `export default function ActivityPanel({ activity, onGoToBackup })` — reads `useTranslation()` itself.

- [ ] **Step 1: Write the component**

```jsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { PulseIcon, CopyIcon, CloudArrowUpIcon } from '@phosphor-icons/react'
import { useTranslation } from '../i18n/i18nContext'

const LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 }
const FILTER_MIN = { all: 0, info: 1, warn: 2, error: 3 }

export function formatBytesShort(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let n = bytes / 1024
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(1)} ${units[i]}`
}

export function formatDuration(seconds) {
  if (seconds == null || seconds < 0 || !isFinite(seconds)) return null
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function phaseKey(phase) {
  switch (phase) {
    case 'connect': return 'activityPhaseConnect'
    case 'vss': return 'activityPhaseVss'
    case 'upload': return 'activityPhaseUpload'
    case 'finalize': return 'activityPhaseFinalize'
    case 'done': return 'activityPhaseDone'
    default: return null
  }
}

function outcomeKey(outcome, success) {
  switch (outcome) {
    case 'verified_success': return 'activityOutcomeSuccess'
    case 'success_with_policy_exclusions': return 'activityOutcomePolicy'
    case 'partial': return 'activityOutcomePartial'
    case 'failed': return 'activityOutcomeFailed'
    default: return success ? 'activityOutcomeSuccess' : 'activityOutcomeFailed'
  }
}

export default function ActivityPanel({ activity, onGoToBackup }) {
  const { t, tf } = useTranslation()
  const { run, stats, log, dropped } = activity
  const [filter, setFilter] = useState('info')
  const [autoscroll, setAutoscroll] = useState(true)
  const [copied, setCopied] = useState(false)
  const paneRef = useRef(null)
  const pinnedRef = useRef(true)

  const visibleLog = useMemo(() => {
    const min = FILTER_MIN[filter] ?? 0
    return log.filter((e) => (LEVEL_RANK[e.level] ?? 1) >= min)
  }, [log, filter])

  // Keep the pane pinned to the bottom unless the user scrolled up.
  useEffect(() => {
    const el = paneRef.current
    if (!el || !autoscroll || !pinnedRef.current) return
    el.scrollTop = el.scrollHeight
  }, [visibleLog, autoscroll])

  const onScroll = () => {
    const el = paneRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8
  }

  const jumpToEnd = () => {
    pinnedRef.current = true
    const el = paneRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  const copyLog = async () => {
    const text = visibleLog.map((e) => `${e.ts}  ${e.level.toUpperCase().padEnd(5)}  ${e.msg}`).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (_) { /* clipboard unavailable in this webview: nothing to do */ }
  }

  if (!run) {
    return (
      <div className="activity-empty">
        <PulseIcon size={28} />
        <p>{t('activityEmpty')}</p>
        <button type="button" className="btn" onClick={onGoToBackup}>
          <CloudArrowUpIcon size={15} />{t('activityGoToBackup')}
        </button>
      </div>
    )
  }

  const s = stats || run.stats || {}
  const running = run.running
  const percent = Math.round((s.percent || 0) * 100)
  const indeterminate = running && s.indeterminate
  const pk = phaseKey(s.phase)
  const eta = running ? formatDuration(s.eta_seconds >= 0 ? s.eta_seconds : null) : null
  const elapsed = formatDuration(s.elapsed_seconds)
  const totalChunks = (s.new_chunks || 0) + (s.reused_chunks || 0)
  const dedup = totalChunks > 0 ? Math.round((s.reused_chunks / totalChunks) * 100) : null
  const barClass = `progress-bar${indeterminate ? ' indeterminate' : ''}${run.complete && !run.success ? ' failed' : ''}`

  return (
    <div className="activity">
      <div className="activity-head">
        <div>
          <span className="activity-id">{run.backup_id || t('activityUnknown')}</span>
          <span className="muted"> → {run.target}</span>
        </div>
        <span className={`state ${run.complete ? (run.success ? 'state-ok' : 'state-bad') : 'state-busy'}`}>
          {run.complete
            ? t(outcomeKey(run.outcome, run.success))
            : (indeterminate ? t('activityScanning') : (pk ? t(pk) : t('activityUnknown')))}
        </span>
      </div>

      <div className="progress progress-lg">
        <div className={barClass} style={{ width: indeterminate ? '100%' : `${percent}%` }} />
      </div>
      <div className="progress-meta">
        <span className="progress-pct">{indeterminate ? t('activityUnknown') : `${percent}%`}</span>
        {s.dir_count > 1 && (
          <span>{tf('activityDirOf', { i: s.dir_index || 0, n: s.dir_count })}</span>
        )}
      </div>

      <div className="activity-tiles">
        <div className="tile"><span className="tile-label">{t('activityEta')}</span><span className="tile-value">{eta || t('activityUnknown')}</span></div>
        <div className="tile"><span className="tile-label">{t('activityElapsed')}</span><span className="tile-value">{elapsed || t('activityUnknown')}</span></div>
        <div className="tile"><span className="tile-label">{t('activitySpeed')}</span><span className="tile-value">{running && s.bytes_per_sec > 0 ? `${formatBytesShort(s.bytes_per_sec)}/s` : t('activityUnknown')}</span></div>
        <div className="tile"><span className="tile-label">{t('activityFiles')}</span><span className="tile-value">{(s.files_done || 0).toLocaleString()}</span></div>
        <div className="tile"><span className="tile-label">{t('activityData')}</span><span className="tile-value">{formatBytesShort(s.bytes_done)}{s.bytes_total > 0 ? ` / ${formatBytesShort(s.bytes_total)}` : ''}</span></div>
        <div className="tile"><span className="tile-label">{t('activityChunks')}</span><span className="tile-value">
          {s.new_chunks || 0} {t('activityChunksNew')} · {s.reused_chunks || 0} {t('activityChunksReused')}
          {s.failed_chunks > 0 && <span className="state state-bad"> {s.failed_chunks} {t('activityChunksFailed')}</span>}
        </span></div>
        <div className="tile"><span className="tile-label">{t('activityDedup')}</span><span className="tile-value">{dedup != null ? `${dedup}%` : t('activityUnknown')}</span></div>
      </div>

      {running && s.current_file && (
        <p className="form-hint mono activity-current" title={s.current_file}>
          {t('activityCurrent')}: {s.current_file}
        </p>
      )}

      <div className="activity-log">
        <div className="activity-log-bar">
          <strong>{t('activityLog')}</strong>
          <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label={t('activityLog')}>
            <option value="all">{t('activityFilterAll')}</option>
            <option value="info">{t('activityFilterInfo')}</option>
            <option value="warn">{t('activityFilterWarn')}</option>
            <option value="error">{t('activityFilterError')}</option>
          </select>
          <label className="check">
            <input type="checkbox" checked={autoscroll} onChange={(e) => { setAutoscroll(e.target.checked); if (e.target.checked) jumpToEnd() }} />
            <span className="check-label">{t('activityAutoscroll')}</span>
          </label>
          <button type="button" className="btn btn-sm" onClick={copyLog}>
            <CopyIcon size={13} />{copied ? t('activityCopied') : t('activityCopy')}
          </button>
        </div>
        <div className="log-pane" ref={paneRef} onScroll={onScroll}>
          {dropped && <div className="log-line muted">{t('activityOlderDropped')}</div>}
          {visibleLog.map((e) => (
            <div key={e.seq} className={`log-line ${e.level}`}>
              <span className="log-ts">{e.ts.slice(11, 19)}</span>
              <span className="log-level">{e.level.toUpperCase()}</span>
              <span className="log-msg">{e.msg}</span>
            </div>
          ))}
        </div>
        {autoscroll && !pinnedRef.current && (
          <button type="button" className="btn btn-sm log-jump" onClick={jumpToEnd}>{t('activityNewLines')}</button>
        )}
      </div>
    </div>
  )
}
```

`PulseIcon` and `CopyIcon` exist in the installed `@phosphor-icons/react` (verified: `dist/csr/Pulse.es.js`, `Copy.es.js`); there is no Activity icon.

- [ ] **Step 2: Append styles to `gui/frontend/src/index.css`**

```css
/* ===== Activity tab ===== */
.activity-empty {
    display: flex; flex-direction: column; align-items: flex-start; gap: var(--s3);
    color: var(--text-muted); padding: var(--s4) 0;
}
.activity-head {
    display: flex; justify-content: space-between; align-items: baseline; gap: var(--s3);
    flex-wrap: wrap; max-width: 900px;
}
.activity-id { font-weight: 600; }
.progress-lg { height: 10px; }
.progress-bar.failed { background: var(--danger); }
.progress-bar.indeterminate {
    background: repeating-linear-gradient(
        -45deg, var(--accent) 0 12px, var(--accent-quiet-line) 12px 24px);
    background-size: 200% 100%;
    animation: progress-stripes 1.2s linear infinite;
}
@keyframes progress-stripes { from { background-position: 0 0; } to { background-position: 48px 0; } }
@media (prefers-reduced-motion: reduce) { .progress-bar.indeterminate { animation: none; } }

.activity-tiles {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: var(--s2); max-width: 900px; margin: var(--s3) 0;
}
.tile {
    display: flex; flex-direction: column; gap: 2px;
    padding: var(--s2) var(--s3); background: var(--surface-sunk);
    border: 1px solid var(--line); border-radius: var(--radius);
}
.tile-label { font-size: var(--t-sm); color: var(--text-muted); }
.tile-value { font-variant-numeric: tabular-nums; }
.activity-current { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 900px; }

.activity-log { position: relative; max-width: 900px; margin-top: var(--s3); }
.activity-log-bar {
    display: flex; align-items: center; gap: var(--s3); flex-wrap: wrap;
    margin-bottom: var(--s2);
}
.activity-log-bar select { width: auto; }
.btn-sm { padding: 2px var(--s2); font-size: var(--t-sm); }
.log-pane {
    height: 40vh; min-height: 180px; overflow: auto;
    background: var(--surface-sunk); border: 1px solid var(--line); border-radius: var(--radius);
    padding: var(--s2); font-family: var(--font-mono); font-size: var(--t-sm);
    line-height: 1.45;
}
.log-line { display: grid; grid-template-columns: 62px 48px 1fr; gap: var(--s2); white-space: pre-wrap; word-break: break-all; }
.log-ts { color: var(--text-muted); }
.log-level { color: var(--text-muted); }
.log-line.debug { opacity: 0.65; }
.log-line.warn .log-level, .log-line.warn .log-msg { color: var(--warn); }
.log-line.error .log-level, .log-line.error .log-msg { color: var(--danger); }
.log-jump { position: absolute; right: var(--s3); bottom: var(--s3); }

.nav-item .live-dot {
    width: 7px; height: 7px; border-radius: 50%; background: var(--accent);
    margin-left: auto; animation: live-pulse 1.4s ease-in-out infinite;
}
@keyframes live-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .nav-item .live-dot { animation: none; } }

.progress-mini { display: flex; align-items: center; gap: var(--s3); max-width: 900px; }
.progress-mini .progress { flex: 1; margin: 0; }
```

If `--t-sm` is not defined in `:root` (check with `Select-String -Path gui\frontend\src\index.css -Pattern '--t-sm:'`), replace it with `12px` in the rules above.

- [ ] **Step 3: Build the frontend to catch syntax errors**

```powershell
Set-Location gui/frontend; npm install; npm run build
```
Expected: Vite build succeeds (the component is not imported yet; the build proves the file parses only once Task 11 imports it — so re-run this in Task 11 too).

- [ ] **Step 4: Commit**

```powershell
git add gui/frontend/src/components/ActivityPanel.jsx gui/frontend/src/index.css
git commit -m "feat(frontend): ActivityPanel component and styles" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Wire the panel into `App.jsx`

**Files:**
- Modify: `gui/frontend/src/App.jsx` — imports (lines 1-35), Go-method capture (lines 36-80), state (lines 123, 136-149), backup event effect (lines 229-305), `handleStartBackup`/`executeSplitBackup` (lines 752-975), `NAV` (line 1350), backup-tab progress section (lines 1796-1842), new panel after the backup tab (line ~1996)

**Interfaces:**
- Consumes: `ActivityPanel` (Task 10); Wails events `activity:run`, `backup:stats`, `backup:log`; Go methods `GetActivity()`, `GetActivityLog(since)` (Task 7).

- [ ] **Step 1: Imports and Go-method capture**

Add `import ActivityPanel from './components/ActivityPanel'` next to the other component imports, `useReducer` to the React import, and `PulseIcon` (or `PulseIcon`, see Task 10) to the phosphor import list.

In the `let …` declaration block add `GetActivity, GetActivityLog` and in the `if (window.go)` block add:
```js
  GetActivity = window.go.main.App.GetActivity
  GetActivityLog = window.go.main.App.GetActivityLog
```

- [ ] **Step 2: Reducer replaces `backupStats`**

Delete the `const [backupStats, setBackupStats] = useState({...})` block. Above the `App` function add:

```jsx
// Activity tab state. One reducer so a new run atomically resets log + stats,
// whether the run was started here (standalone events) or observed via the
// service poller (late join).
const initialActivity = { run: null, stats: null, log: [], nextSeq: 0, dropped: false }

function activityReducer(state, action) {
  switch (action.type) {
    case 'run': {
      const run = action.run
      if (!run || !run.run_id) return state
      if (!state.run || state.run.run_id !== run.run_id) {
        return { run, stats: run.stats || null, log: [], nextSeq: 0, dropped: false }
      }
      return { ...state, run, stats: run.stats || state.stats }
    }
    case 'stats':
      return state.run ? { ...state, stats: action.stats } : state
    case 'log': {
      const entries = action.entries || []
      if (!entries.length) return state
      const fresh = entries.filter((e) => e.seq >= state.nextSeq)
      if (!fresh.length) return state
      const dropped = state.dropped || (state.nextSeq > 0 && fresh[0].seq > state.nextSeq)
      const log = state.log.concat(fresh).slice(-2000)
      return { ...state, log, nextSeq: fresh[fresh.length - 1].seq + 1, dropped }
    }
    default:
      return state
  }
}
```

Inside `App`, where `backupStats` used to be declared: `const [activity, dispatchActivity] = useReducer(activityReducer, initialActivity)`.

- [ ] **Step 3: Rewrite the backup event effect**

Replace the body of the `// Listen to backup events` effect (`unsubProgress`, `unsubStats`, `unsubComplete` and the cleanup) with:

```jsx
    const unsubProgress = EventsOn('backup:progress', (data) => {
      setProgress(Math.round(data.percent))
      showStatus(data.message, 'info', false)
    })

    const unsubRun = EventsOn('activity:run', (snap) => dispatchActivity({ type: 'run', run: snap }))
    const unsubStats = EventsOn('backup:stats', (stats) => dispatchActivity({ type: 'stats', stats }))
    const unsubLog = EventsOn('backup:log', (data) => dispatchActivity({ type: 'log', entries: data.entries }))

    const unsubComplete = EventsOn('backup:complete', (data) => {
      setProgress(data.success ? 100 : 0)
      showStatus(data.message, data.success ? 'success' : 'error')

      // Add to job history
      const historyEntry = {
        id: Date.now().toString(),
        name: `Backup ${config['backup-id'] || hostname}`,
        timestamp: new Date().toISOString(),
        status: data.success ? 'success' : 'failed',
        message: data.message,
        backupDirs: backupDirs.split('\n').map(d => d.trim()).filter(d => d),
        backupId: config['backup-id'] || hostname,
        useVSS: config.usevss
      }
      setJobHistory(prev => [historyEntry, ...prev].slice(0, 20)) // Keep last 20 entries
    })

    // Late join / reopen: prime from the backend so a run started by the
    // scheduler (service mode) or before this component mounted is visible.
    ;(async () => {
      try {
        if (!GetActivity) return
        const snap = await GetActivity()
        if (snap && snap.run_id) {
          dispatchActivity({ type: 'run', run: snap })
          if (GetActivityLog) {
            const lg = await GetActivityLog(0)
            dispatchActivity({ type: 'log', entries: lg && lg.entries })
          }
        }
      } catch (_) { /* no backend (vite dev) */ }
    })()

    return () => {
      if (unsubProgress) unsubProgress()
      if (unsubRun) unsubRun()
      if (unsubStats) unsubStats()
      if (unsubLog) unsubLog()
      if (unsubComplete) unsubComplete()
    }
```

Keep the effect's dependency array as it is.

- [ ] **Step 4: Switch to the Activity tab on start**

In `handleStartBackup` one-shot branch, right after `setProgress(5)` add `setActiveTab('activity')`. In `executeSplitBackup`, add the same `setActiveTab('activity')` immediately after the first `showStatus(t('splitAnalyzing'), 'info')`.

- [ ] **Step 5: Navigation entry with live dot**

Change `NAV` to:

```jsx
  const NAV = [
    { id: 'servers', label: t('tabServers'), Icon: DatabaseIcon },
    { id: 'backup', label: t('tabBackup'), Icon: CloudArrowUpIcon },
    { id: 'activity', label: t('tabActivity'), Icon: PulseIcon, live: !!(activity.run && activity.run.running) },
    { id: 'restore', label: t('tabRestore'), Icon: ArrowCounterClockwiseIcon },
    { id: 'about', label: t('tabAbout'), Icon: InfoIcon },
  ]
```

and in the nav render, destructure `live` and add `{live && <span className="live-dot" aria-hidden="true" />}` after the `<span>{label}</span>`.

- [ ] **Step 6: Shrink the backup-tab progress section**

Replace the whole `{progress > 0 && progress < 100 && ( <div className="section"> … </div> )}` block (the one with `<h3>{t('backupProgress')}</h3>`) with:

```jsx
          {progress > 0 && progress < 100 && (
            <div className="section">
              <div className="progress-mini">
                <div className="progress"><div className="progress-bar" style={{ width: `${progress}%` }} /></div>
                <span className="progress-pct">{progress}%</span>
                <button type="button" className="btn btn-sm" onClick={() => setActiveTab('activity')}>
                  <PulseIcon size={13} />{t('activityOpenActivity')}
                </button>
              </div>
              {status.message && status.type === 'info' && (
                <p className="form-hint">{status.message}</p>
              )}
            </div>
          )}
```

- [ ] **Step 7: Render the panel**

After the closing `</div>` of the backup tab panel (just before `{/* Restore Tab */}`), add:

```jsx
        {/* Activity Tab */}
        <div className={`panel ${activeTab === 'activity' ? 'active' : ''}`}>
          <h2>{t('activityTitle')}</h2>
          <p className="panel-lede">{t('activityLede')}</p>
          <ActivityPanel activity={activity} onGoToBackup={() => setActiveTab('backup')} />
        </div>
```

- [ ] **Step 8: Remove dead references and build**

```powershell
Set-Location gui/frontend
Select-String -Path src\App.jsx -Pattern 'backupStats'
npm run build
```
Expected: the grep returns nothing; the build succeeds with no warnings about unused imports of `timeRemaining`-era keys (unused translation keys are harmless; leave them).

- [ ] **Step 9: Smoke-run the app**

```powershell
Set-Location gui; $env:GOWORK = "off"; wails dev
```
(Or `wails build -clean -platform windows/amd64` and run `build/bin/NimbusBackup.exe`.) Verify:
1. Activity tab shows the empty state with a working "Go to Backup" button.
2. Start a small folder backup → the app switches to Activity, the bar is striped while "Measuring folder size…", then shows a real percent; ETA/speed/files fill in; log lines scroll; the nav dot pulses.
3. Completion: bar 100 %, outcome chip, tiles frozen, log shows the completion line; the Backup tab's mini bar disappears.
4. With the Windows service installed and running: repeat 2 — the events must come from the poller (`backup-gui.log`/`service-gui.log` contains no `[Activity] poll failed`). Close and reopen the GUI mid-backup → the panel is populated (late join).
Record what you observed in the commit body.

- [ ] **Step 10: Commit**

```powershell
git add gui/frontend/src/App.jsx gui/frontend/dist
git commit -m "feat(gui): Activity tab with live progress, ETA, stats and log" -m "<observed smoke results>" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(`gui/frontend/dist` is tracked in this repo — check `git status`; commit the rebuilt bundle if it is, since `//go:embed` ships whatever is in `dist`.)

---

### Task 12: Changelog, lint, final verification

**Files:**
- Modify: `CHANGELOG.md` (Unreleased section)

- [ ] **Step 1: Changelog entry**

Under `## [Unreleased]` (create it under the title if absent) add:

```markdown
### Added
- **Activity tab**: live view of the running backup with a bytes-accurate progress bar,
  engine-computed time remaining and throughput, file/data/chunk/dedup statistics, the
  current file, and a filterable, copyable log of milestones and per-file entries.
  Works identically in standalone and service mode, and shows a backup the scheduler
  started before the GUI was opened.
- Local service API: `GET /activity` and `GET /activity/log?since=<seq>`.

### Changed
- Backup progress percent is now `bytes done / bytes total` over the whole run instead of a
  10 %→90 % mapping; while a folder's size is still being measured the bar is
  indeterminate instead of showing a made-up number.
- Service-mode progress polling runs every second (was 3 s).

### Fixed
- Service mode showed "Starting backup..." with no progress until completion: the
  progress-callback hook was only compiled into the GUI binary.
```

- [ ] **Step 2: Lint and full per-module verification**

```powershell
$env:PATH = "C:\Program Files\Go\bin;" + $env:PATH; $env:GOWORK = "off"
Set-Location pbscommon; go test ./...
Set-Location ../gui/api; go test ./...
Set-Location ..; go build ./...; go build -tags service ./...; go vet ./...
go test -skip 'TestConfigSaveLoad|TestGetConfigPath' ./...
golangci-lint run --timeout=5m   # if installed; otherwise note it in the commit body
gosec -severity high -confidence high ./...   # if installed
```
Expected: all PASS / clean. Fix anything lint reports before committing.

- [ ] **Step 3: Commit**

```powershell
git add CHANGELOG.md
git commit -m "docs(changelog): activity tab, bytes-based progress, service-mode progress fix" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-review notes

- Spec §1.1 → Task 1; §1.2/§1.3 → Tasks 4–6; §1.4 → Tasks 3, 6 (Step 5); §1.5 → Task 6 (Step 6); §1.6 → satisfied because `app_activity.go` and `backup_activity.go` are untagged (no stubs needed) — verified by the `-tags service` build in every task; §2.x → Tasks 5, 7, 8; §3.1–3.4 → Tasks 10–11; §3.5 → Task 9; §5 tests → Tasks 1–5, 7; smoke → Task 11 Step 9.
- Phase names used consistently: `connect`, `vss`, `upload`, `finalize`, `done` (Go tracker ↔ `phaseKey` in JSX). The spec's `scan` phase is expressed as `Indeterminate` during `upload`, per §1.2.
- Signature consistency: `activity.Progress(dirBytesDone, new, reused, failed, msg)` (Task 5) is what `ChunkState.HandleData` calls (Task 6); `EndDir(dirBytes, dirTotal)` is called with `(pxarChunk.pos, totalSize.Load())`; `api.ActivityProvider` methods match `App.GetActivity`/`GetActivityLog`.
