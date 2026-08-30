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

Per-file lines come from the engine's `OnEntry` wrapper and go **only** to the tracker
(`activity.Log("debug", "[File] path (size)")`, `[Dir] path` for directories) — not to the
per-run log file, which would otherwise grow by one line per file. Level `debug` so the
pane's filter can hide them.

### 1.5 Delivery to the GUI (standalone)

`BackupOptions` is unchanged. The tracker flushes accumulated log entries to its `onLog`
sink every 250 ms (ticker goroutine started in `BeginRun`, stopped in `EndRun`) and on
completion, so a busy backup produces at most 4 Wails events per second for the log.
`main.go` registers sinks at startup that emit `activity:run` (snapshot), `backup:stats`
(stats, with the new fields) and `backup:log` (`{entries: [...]}`). Stats emission stays
tied to the 10 MB progress tick plus phase changes.

### 1.6 Service build

`app_service_stubs.go` gets matching no-op/forwarding stubs so `-tags service` compiles.
Any new `App` method the frontend calls (`GetActiveBackupLog` for late-joining, see 3.4)
gets a stub.

## 2. Process-wide activity tracker and local service API

### 2.0 Why a tracker instead of per-job callbacks (deviation from the chat design)

`SetProgressCallbacks` is defined in `main.go`, which carries the `!service` build tag,
so the service binary does not implement it and the API's optional-interface probe
fails: service-mode progress today is "Starting backup..." until completion. Backups
started by the scheduler never appear in the API's per-job map at all. Per-job callbacks
therefore cannot deliver parity or late-join.

Instead, `gui/backup_activity.go` owns a single process-wide `activityTracker`
(`var activity`), fed directly by `RunBackupInline`/`backupReal`/`ChunkState` — whoever
started the run. It holds the current `api.ActivitySnapshot`, the `RunLog`, the
throughput meter and the run-level byte accounting (finished directories + current
directory) that produces the percent and ETA. Only one run is tracked at a time (the
per-destination mutex serialises runs to the same PBS; two runs to different servers
overlap and the last writer wins — documented, not solved).

Sinks are process-level, registered once at GUI startup (standalone) — not per run:
`activity.SetSinks(onRun, onStats, onLog)`. The service process registers none; the API
server pulls snapshots.

### 2.1 Types (`gui/api/types.go`, aliased in `gui`)

```go
type BackupProgressStats struct { /* see 1.2 */ }
type RunLogEntry struct { Seq uint64; TS string; Level string; Msg string }
type ActivitySnapshot struct {
    Running   bool                `json:"running"`
    RunID     string              `json:"run_id"`
    BackupID  string              `json:"backup_id"`
    Target    string              `json:"target"`     // "https://pbs:8007/datastore"
    StartTime string              `json:"start_time,omitempty"`
    EndTime   string              `json:"end_time,omitempty"`
    Complete  bool                `json:"complete"`
    Success   bool                `json:"success"`
    Outcome   string              `json:"outcome,omitempty"`
    Message   string              `json:"message"`
    Stats     BackupProgressStats `json:"stats"`
    LogNext   uint64              `json:"log_next"`
}
type ActivityLogResponse struct { Entries []RunLogEntry `json:"entries"`; Next uint64 `json:"next"` }
```

### 2.2 Endpoints

- `GET /activity` → `200 ActivitySnapshot` (zero-value snapshot with `running:false`
  when nothing has run since the service started).
- `GET /activity/log?since=<seq>` → `200 ActivityLogResponse`; `400` non-numeric `since`.

Same auth/Origin rules as every other route. The server probes the handler for the
optional interface `ActivityProvider { GetActivity() ActivitySnapshot;
GetActivityLog(since uint64) ActivityLogResponse }` and answers `503` if absent.

### 2.3 App methods (untagged `gui/app_activity.go`, Wails-bound and API-visible)

`GetActivity()` / `GetActivityLog(since)`: in the GUI process running in service mode they
proxy to the service over `api.Client.GetActivity()` / `GetActivityLog(since)`; otherwise
they read the local tracker. The frontend calls them once on mount (late join / tab
reopen); the service process's API server calls them for `/activity*`.

### 2.4 GUI polling in service mode

`App.activityPoller()` is a goroutine started once (`sync.Once`) when the GUI is, or
becomes, `ModeService`. Loop: `GET /activity`; when `running` (or the run id / complete
flag changed since the last tick) emit `activity:run` and `backup:stats`; then
`GET /activity/log?since` and emit `backup:log` when non-empty; `since` resets to 0 when
the run id changes. Tick 1 s while running, 3 s otherwise. Errors are logged and the loop
continues (no give-up — the GUI's `pollBackupProgress` keeps its own 20-strike rule for
`backup:complete`).

`pollBackupProgress` is unchanged: it still drives `backup:progress` / `backup:complete`
for GUI-started jobs (the split-backup flow awaits `backup:complete`).

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
`gui/main.go`, `gui/app_activity.go` (new), `gui/backup_activity.go` (new), `gui/api/types.go`,
`gui/api/server.go`, `gui/api/client.go`, `gui/frontend/src/App.jsx`,
`gui/frontend/src/components/ActivityPanel.jsx` (new — first extraction out of the
2700-line `App.jsx`), `gui/frontend/src/i18n/translations.js`, `gui/frontend/src/index.css`,
`CHANGELOG.md`.

## 7. Implementation notes (deviations from the design above)

Recorded after the final fix wave; the code is the authority where the two disagree.

- **The per-destination backup lock moved into `RunBackupInline`.** §2.0 assumed the
  existing lock inside `runBackupInlineInternal` was enough to serialise runs against the
  process-wide tracker. It is not: the wrapper calls `BeginRun` before the inner function
  ever blocks, so a queued run would reset the in-flight run's snapshot, percent and log.
  The lock is now taken by `acquireBackupLock` in the wrapper, before `BeginRun`, and held
  for the whole run (all folders); `BackupOptions.lockHeld` tells the inner function to
  skip it.
- **Two log rings, one sequence counter.** §1.4 specified a single 2000-line ring. Per-file
  `debug` lines would evict every milestone from it within seconds on a large folder, and
  the pane's default `info+` filter would then show nothing. The tracker keeps a
  2000-entry milestone ring (`info`/`warn`/`error`) and a 300-entry per-file ring
  (`debug`), both drawing from one shared counter; `LogSince` merges them by seq, so the
  wire format and the `since` cursor are unchanged.
- **The tracker only logs while a run is in flight.** The sinks are process-level and
  permanent but the flush loop only exists between `BeginRun` and `EndRun`, and
  `writeBackupLog` is shared with restore/search/cache code. Lines appended outside a run
  are dropped rather than buffered; the pending batch is capped at the ring capacity.
- **`activity:lost` is its own Wails event.** §4 asked for an `error` line in the log pane
  when the service goes away mid-run. `activityPoller` emits `activity:lost` (empty
  payload — the text is a translation key) after 10 consecutive `/activity` failures while
  the last snapshot said running; the frontend reducer closes the run and appends the line
  locally. Reset on the next successful poll.
- **Per-file lines stay GUI-only**, as §1.4 intended: they never reach the per-run log file.
- **"A backup is running" is read from the tracker snapshot, not from the percent.** The
  percent is legitimately 0 during the indeterminate window and for the whole run in
  service mode (`SetProgressCallbacks` is `!service`-only, deliberately left that way), so
  the frontend derives `backupRunning` from `activity.run.running` for the Start/Stop
  buttons and the Backup tab's mini bar. The percent itself is monotonic per run and only
  resets when `activity:run` announces a new `run_id`.
- **`SetDirTotal` carries the directory index.** The background size scan outlives the
  directory it was started for, so the tracker drops a result that does not match the
  directory currently being archived.
