# Backup Activity View — live progress, ETA and verbose log

Date: 2026-08-30
Status: approved (design), implementation pending

## Goal

When a backup starts, the GUI switches to a dedicated **Activity** tab that shows an
accurate progress bar (real bytes-based percent), a time-remaining estimate computed from
measured throughput, live statistics, and a scrolling verbose log of what the engine is
doing (milestones + per-file entries, no chunk-level spam). The view must behave
identically in standalone mode (Wails events) and in service mode (GUI polls the local
API), because the default installation runs in service mode.

## Non-goals

- A real second OS window. Wails v2.8 is single-window; a v3 migration is out of scope.
- A working "Stop backup" button. Today it only resets frontend state (`setProgress(0)`);
  the engine has no cancellation. Unchanged by this work.
- Restore progress. Unchanged.
- Chunk-level log lines in the GUI. They stay file-only (`New chunk[…]`, `Reuse chunk[…]`).

## Architecture

```
pbscommon.PXARArchive ──OnEntry(path,size,isDir)──► gui engine (backup_inline.go)
                                                        │
                       ┌────────────────────────────────┼──────────────────────────┐
                       │ OnStats(*BackupProgressStats)  │ writeBackupLog → runLog  │
                       ▼                                ▼                          ▼
              standalone: Wails events         service: api.Server callbacks     per-run log file
              backup:stats / backup:log        (onStats, onLog) → per-job state  (unchanged)
                       │                                │
                       │                    GUI pollBackupProgress (1 s):
                       │                    GET /backup/status/{id}  → backup:stats
                       │                    GET /backup/log/{id}?since → backup:log
                       ▼                                ▼
                    frontend Activity tab (single code path, event-driven)
```

## 1. Engine (`gui/`, `pbscommon/`)

### 1.1 Per-entry callback in the PXAR writer

`pbscommon.PXARArchive` gains an optional field:

```go
// OnEntry, when set, is called once per archived entry (directory or regular
// file) after it has been fully written. It exists so the GUI can show a live
// "current file" and file counter without pbscommon depending on a logger.
OnEntry func(path string, size uint64, isDir bool)
```

Called at the end of `WriteFile` (size = file size) and `WriteDir` (size = 0). Skipped
entries (read errors, junctions, excludes) are not reported through `OnEntry` — they
already land in `SkippedFiles` / `ReadErrors` / `ExcludedFiles`.

### 1.2 Progress model

`BackupProgressStats` (`gui/backup_status.go`) is extended:

| Field | JSON | Meaning |
|---|---|---|
| `Phase` | `phase` | `"scan"`, `"vss"`, `"connect"`, `"upload"`, `"finalize"` |
| `Indeterminate` | `indeterminate` | true while `BytesTotal == 0` (size scan running) |
| `FilesDone` | `files_done` | count of `OnEntry` files |
| `CurrentFile` | `current_file` | last `OnEntry` path (dirs and files) |
| `BytesPerSec` | `bytes_per_sec` | throughput, moving window |
| `EtaSeconds` | `eta_seconds` | `-1` when unknown |
| `ElapsedSeconds` | `elapsed_seconds` | since `RunBackupInline` entered the upload phase |

Percent semantics change:

- **upload phase**: `Percent = BytesDone / BytesTotal` clamped to `[0, 0.99]`. Never
  goes backwards (`BytesTotal` can grow while the scan runs; keep the monotonic guard).
- **before the scan finishes**: `Indeterminate = true`, `Percent` = last known value.
- **finalize phase**: `Percent = 0.99`; `1.0` is only sent by `OnComplete`.
- The 10 %→90 % mapping in `ChunkState` is removed.

### 1.3 ETA calculator

New file `gui/backup_eta.go`:

```go
type throughputMeter struct { window time.Duration; samples []sample }
func (m *throughputMeter) Add(now time.Time, bytesDone uint64)
func (m *throughputMeter) BytesPerSec(now time.Time) float64   // over the window
func (m *throughputMeter) ETA(now time.Time, done, total uint64) int64 // -1 if unknown
```

Window: 30 s. ETA is `-1` when `total == 0`, `total <= done`, or throughput is `0`.
Pure functions, table-tested.

### 1.4 Run log ring buffer

New file `gui/backup_runlog.go`:

```go
type RunLogEntry struct {
    Seq   uint64 `json:"seq"`
    TS    string `json:"ts"`    // RFC3339Nano
    Level string `json:"level"` // "info" | "warn" | "error" | "debug"
    Msg   string `json:"msg"`
}
type RunLog struct { /* mutex, ring of 2000, next seq */ }
func (l *RunLog) Append(level, msg string) RunLogEntry
func (l *RunLog) Since(seq uint64) (entries []RunLogEntry, next uint64)
func (l *RunLog) Reset()
```

`Since(seq)` returns entries with `Seq >= seq`. If `seq` is older than the oldest retained
entry the caller silently gets what is left (log pane shows a "… older lines dropped …"
marker when `entries[0].Seq > requestedSeq`).

Wiring: `writeBackupLog` (both `logging_gui.go` and `logging_service.go`) additionally
calls `currentRunLog.Append(level, msg)` **unless** the message starts with `New chunk[` or
`Reuse chunk[`. Level is derived from the existing prefixes: `[ERROR]` → error, `Warning`
/ `[WARN]` → warn, `[DEBUG]` → debug, else info. `RunBackupInline` calls `Reset()` where it
calls `StartBackupRunLog`.

Per-file lines come from the engine's `OnEntry` wrapper:
`writeBackupLog(fmt.Sprintf("[File] %s (%s)", path, humanBytes(size)))` for files;
directories log `[Dir] path`. These are level `debug` so the pane's filter can hide them.

### 1.5 Delivery to the GUI (standalone)

`BackupOptions` gains `OnLog func([]RunLogEntry)`. The engine flushes accumulated entries
every 250 ms (ticker goroutine started/stopped inside `RunBackupInline`) and on completion,
so a busy backup produces at most 4 Wails events per second for the log. `main.go` emits
`backup:log` with `{entries: [...]}`.

`backup:stats` is emitted as today, with the new fields added. Stats emission is throttled
to at most 4/s as well (currently tied to the 10 MB progress tick — keep that, it is already
coarse enough).

### 1.6 Service build

`app_service_stubs.go` gets matching no-op/forwarding stubs so `-tags service` compiles.
Any new `App` method the frontend calls (`GetActiveBackupLog` for late-joining, see 3.4)
gets a stub.

## 2. Local service API (`gui/api/`)

### 2.1 Types

```go
type BackupProgress struct {
    // existing fields unchanged …
    Stats *BackupProgressStats `json:"stats,omitempty"`
}
type BackupLogResponse struct {
    Entries []RunLogEntry `json:"entries"`
    Next    uint64        `json:"next"`
}
```

`BackupProgressStats` and `RunLogEntry` move to `gui/api/types.go` (package `api`) and the
`gui` package aliases them (`type BackupProgressStats = api.BackupProgressStats`) — `gui`
already imports `gui/api`; the reverse import is impossible.

### 2.2 Endpoint

`GET /backup/log/{jobID}?since=<seq>` → `200 BackupLogResponse`; `404` unknown job;
`400` non-numeric `since`. Same auth/Origin rules as every other route (token header,
`Origin` → 403). Response size bounded by the ring (2000 entries).

### 2.3 Server-side state

`api.Server` keeps, per job: `*BackupProgress` (existing) and `*RunLog` (new). The
`SetProgressCallbacks` optional interface grows two callbacks:

```go
SetProgressCallbacks(jobID string,
    onProgress func(string, float64, string),
    onStats    func(string, *BackupProgressStats),
    onLog      func(string, []RunLogEntry),
    onComplete func(string, bool, string))
```

`App.progressCallbacks` stores all four; the engine's `OnStats`/`OnLog` hooks in `main.go`
fan out to registered callbacks exactly like `OnProgress` does today (callbacks present →
service path, else Wails events). Job state is dropped from the server map on the same
schedule as today's progress entries.

### 2.4 Client + GUI polling

`api.Client.GetBackupLog(jobID string, since uint64) (*BackupLogResponse, error)`.

`App.pollBackupProgress`: interval 3 s → **1 s**. Each tick:
1. `GetBackupStatus` → emit `backup:progress` (unchanged) and, when `Stats != nil`,
   `backup:stats`.
2. `GetBackupLog(since)` → emit `backup:log` when non-empty; advance `since = Next`.
3. On `Complete`: one final log fetch, then `backup:complete`.

Failure handling stays as is (20 consecutive errors → give up).

## 3. Frontend (`gui/frontend/src/`)

### 3.1 Navigation

New `NAV` entry `{ id: 'activity', label: t('tabActivity'), Icon: ActivityIcon }` between
Backup and Restore. While a backup is running the nav item shows a pulsing dot
(`.nav-item .live-dot`). `handleStartBackup` calls `setActiveTab('activity')` after the
backup was accepted (both single and split-plan paths).

### 3.2 Activity panel layout

```
┌ Aktivität ────────────────────────────────────────────────┐
│ host-01 → pbs.example.com / datastore1        Phase: Upload│
│ ████████████████████░░░░░░░░░░░░░░░  63 %                  │
│ [Rest ~ 12 min] [Verstrichen 21 min] [48,2 MB/s]           │
│ [Dateien 18 432] [Daten 41,3 / 65,6 GB] [Chunks 9 812 neu ·│
│  31 044 wiederverwendet · 0 fehlgeschlagen] [Dedup 76 %]   │
│ Aktuell: C:\Users\Alice\Documents\…\report.docx            │
│ ┌ Log ──────────────── [Filter ▾] [Autoscroll ✓] [Kopieren]│
│ │ 14:02:01  INFO  Starting backup of directory 1/2: C:\… │
│ │ 14:02:03  DEBUG [File] C:\Users\…\a.txt (12,4 KB)       │
│ │ …                                                       │
└─┴─────────────────────────────────────────────────────────┘
```

- Indeterminate: bar uses the striped/animated variant, percent hidden, ETA shows "—".
- After `backup:complete`/`backup:result`: bar 100 % (or error colour), stat tiles
  freeze, a summary line (outcome, duration, bytes, chunks) is prepended to the log.
  Everything stays until the next backup start resets it.
- Empty state (never ran this session): short hint + button "Zum Backup".
- Log pane: virtual list not needed — max 2000 rows; keep it a plain `<pre>`-like list with
  `overflow:auto`, autoscroll pinned to bottom unless the user scrolled up (then a
  "↓ neue Zeilen" chip appears). Filter: All / Info+ / Warn+ / Error. Copy = clipboard of
  the visible lines.

### 3.3 State

One `useReducer` slice `activity` replaces `progress` + `backupStats` for the Activity
panel: `{ phase, indeterminate, percent, stats, currentFile, log: [], nextSeq, outcome,
startedAt, finishedAt }`. The Backup tab keeps its existing `progress` state for the
Start-button disabled logic but its inline progress section shrinks to a one-line mini bar
plus a link "→ Aktivität".

ETA/speed/elapsed are **read from `backup:stats`** (engine-computed); the frontend's
percent-delta speed estimator is deleted.

### 3.4 Late join

If the GUI is opened while the service is already running a backup (scheduled job), the
Activity tab is empty today. `GetStatus` already returns running jobs from
`/status`; the GUI, when it sees `running_backups > 0` at startup and it is in service
mode, starts `pollBackupProgress` for those job ids so the view fills. Standalone mode has
no such case (backup dies with the GUI).

### 3.5 i18n

New keys in `translations.js` for `fr`, `en`, `de`: `tabActivity`, `activityEmpty`,
`activityPhaseScan/Vss/Connect/Upload/Finalize`, `activityEta`, `activityElapsed`,
`activitySpeed`, `activityFiles`, `activityData`, `activityDedup`, `activityCurrent`,
`activityLog`, `activityFilter*`, `activityAutoscroll`, `activityCopy`,
`activityNewLines`, `activityOlderDropped`, `activityGoToBackup`, `activitySummary`.

## 4. Error handling

- Engine callbacks are always nil-checked; a panic in a callback must not abort the
  backup (wrap `OnLog`/`OnStats` invocations in `recover` like `OnProgress` is today).
- Service unreachable mid-run: existing 20-strike rule; the log pane gets an `error` line
  "Lost contact with backup service".
- Ring overflow: handled by `Since` semantics + UI marker; nothing is lost in the file log.

## 5. Testing

Go (`GOWORK=off`, per module):

- `gui/backup_runlog_test.go`: append/wrap at capacity, `Since` on empty, on wrapped,
  on future seq; `Reset`.
- `gui/backup_eta_test.go`: table test — no samples, constant rate, window eviction,
  `total==0`, `done>=total`.
- `gui/backup_status_test.go`: JSON round-trip of the new fields.
- `gui/api/server_test.go`: `/backup/log` — 401 without token, 403 with Origin, 404
  unknown job, `since` paging, 400 bad `since`.
- `pbscommon/pxar_test.go`: `OnEntry` fires once per file/dir, not for excluded entries.
- Service build: `go build -tags service ./...` in `gui/` must pass (CI already does).
- Frontend: no test harness exists; verify manually with `wails dev` in standalone and
  with the installed service (both paths), including the late-join case.

## 6. Files touched

`pbscommon/pxar.go`, `gui/backup_status.go`, `gui/backup_inline.go`, `gui/backup_eta.go`
(new), `gui/backup_runlog.go` (new), `gui/logging_gui.go`, `gui/logging_service.go`,
`gui/main.go`, `gui/app_types.go`, `gui/app_service_stubs.go`, `gui/api/types.go`,
`gui/api/server.go`, `gui/api/client.go`, `gui/frontend/src/App.jsx`,
`gui/frontend/src/components/ActivityPanel.jsx` (new — first extraction out of the
2700-line `App.jsx`), `gui/frontend/src/i18n/translations.js`, `gui/frontend/src/index.css`,
`CHANGELOG.md`.
