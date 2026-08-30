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
