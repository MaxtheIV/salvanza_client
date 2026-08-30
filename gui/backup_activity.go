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

// SetBackupID corrects the id announced by BeginRun once the engine has derived
// it (the id is generated after BeginRun when the caller left it empty).
func (t *activityTracker) SetBackupID(id string) {
	t.mu.Lock()
	t.snap.BackupID = id
	t.mu.Unlock()
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
