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

// Compile-time assertion: the service build's App must satisfy ActivityProvider
// so the API server (constructed with App as its BackupHandler) can serve
// /activity without a runtime type-assertion failure.
var _ api.ActivityProvider = (*App)(nil)
