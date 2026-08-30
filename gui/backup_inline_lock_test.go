package main

import (
	"sync"
	"testing"
	"time"
)

// C-1: RunBackupInline takes the per-destination lock BEFORE it announces the run
// to the process-wide activity tracker and holds it for every folder, so a second
// run to the same destination (scheduler firing during a manual run, or a double
// click) waits here instead of resetting the in-flight run's tracker state.
//
// The wrapper itself needs a live PBS to exercise end to end; what is testable —
// and what actually changed — is the lock helper it now calls, so that is what is
// asserted here.
func TestAcquireBackupLockSerializesSameDestination(t *testing.T) {
	const url, ds = "https://pbs.test:8007", "store-serialize"

	var waited bool
	release := acquireBackupLock(url, ds, func(percent float64, msg string) {})

	acquired := make(chan struct{})
	go func() {
		// The second run must observe the "waiting" progress message and block.
		release2 := acquireBackupLock(url, ds, func(percent float64, msg string) {
			if percent == 0 && msg != "" {
				waited = true
			}
		})
		close(acquired)
		release2()
	}()

	select {
	case <-acquired:
		t.Fatal("second acquire of the same destination did not block")
	case <-time.After(100 * time.Millisecond):
	}

	release()
	select {
	case <-acquired:
	case <-time.After(5 * time.Second):
		t.Fatal("second acquire never completed after release")
	}
	if !waited {
		t.Error("the waiting run got no OnProgress notification")
	}
}

// Different destinations must still run concurrently: the key is BaseURL+Datastore.
func TestAcquireBackupLockAllowsDifferentDestinations(t *testing.T) {
	r1 := acquireBackupLock("https://pbs-a.test:8007", "store", nil)
	done := make(chan func())
	go func() { done <- acquireBackupLock("https://pbs-b.test:8007", "store", nil) }()
	select {
	case r2 := <-done:
		r2()
	case <-time.After(5 * time.Second):
		t.Fatal("a different destination blocked on an unrelated lock")
	}
	r1()

	// Same URL, different datastore is also a different destination.
	r3 := acquireBackupLock("https://pbs-a.test:8007", "store-1", nil)
	done2 := make(chan func())
	go func() { done2 <- acquireBackupLock("https://pbs-a.test:8007", "store-2", nil) }()
	select {
	case r4 := <-done2:
		r4()
	case <-time.After(5 * time.Second):
		t.Fatal("a different datastore blocked on an unrelated lock")
	}
	r3()
}

// The helper must hand back a working release even under contention, or a failed
// run would wedge its destination for the lifetime of the process.
func TestAcquireBackupLockReleaseIsReusable(t *testing.T) {
	const url, ds = "https://pbs.test:8007", "store-reuse"
	var wg sync.WaitGroup
	counter := 0
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			release := acquireBackupLock(url, ds, nil)
			defer release()
			counter++ // race-free only because the lock actually serializes
		}()
	}
	wg.Wait()
	if counter != 20 {
		t.Errorf("counter = %d, want 20", counter)
	}
}
