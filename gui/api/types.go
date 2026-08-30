package api

// BackupRequest represents a backup job request
type BackupRequest struct {
	BackupType   string   `json:"backup_type"`   // "directory" or "machine"
	BackupID     string   `json:"backup_id"`
	BackupDirs   []string `json:"backup_dirs"`
	DriveLetters []string `json:"drive_letters,omitempty"`
	ExcludeList  []string `json:"exclude_list,omitempty"`
	UseVSS       bool     `json:"use_vss"`
	Compression  string   `json:"compression,omitempty"` // "fastest", "default", "better", "best"
}

// BackupResponse represents the result of a backup operation
type BackupResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
	JobID   string `json:"job_id,omitempty"`
	Error   string `json:"error,omitempty"`
}

// StatusResponse represents the service status
type StatusResponse struct {
	Running       bool                 `json:"running"`
	Version       string               `json:"version"`
	ActiveJobs    int                  `json:"active_jobs"`
	LastBackup    string               `json:"last_backup,omitempty"`
	Configuration map[string]any `json:"configuration"`
}

// JobInfo represents information about a scheduled job
type JobInfo struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	BackupType   string `json:"backup_type"`
	Schedule     string `json:"schedule"`
	LastRun      string `json:"last_run,omitempty"`
	Status       string `json:"status"` // "idle", "running", "error"
	NextRun      string `json:"next_run,omitempty"`
}

// JobsResponse lists all configured jobs
type JobsResponse struct {
	Jobs []JobInfo `json:"jobs"`
}

// ErrorResponse represents an API error
type ErrorResponse struct {
	Error   string `json:"error"`
	Code    int    `json:"code"`
	Details string `json:"details,omitempty"`
}

// BackupProgress represents the current state of a running backup
type BackupProgress struct {
	JobID     string  `json:"job_id"`
	Running   bool    `json:"running"`
	Progress  float64 `json:"progress"`  // 0-100
	Message   string  `json:"message"`
	Success   bool    `json:"success"`
	Complete  bool    `json:"complete"`
	Error     string  `json:"error,omitempty"`
	StartTime string  `json:"start_time,omitempty"`
}

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
