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
func (f *fakeHandler) GetConfigWithHostname() map[string]interface{}        { return map[string]interface{}{} }
func (f *fakeHandler) GetScheduledJobsForAPI() []map[string]interface{}     { return nil }
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
	ts, token := newTestServer(t, &noActivityHandler{})
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
