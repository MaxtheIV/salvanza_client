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
