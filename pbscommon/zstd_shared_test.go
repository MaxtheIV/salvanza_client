package pbscommon

import (
	"bytes"
	"fmt"
	"sync"
	"testing"

	"github.com/klauspost/compress/zstd"
)

// The decoder must be built once and reused: a restore decodes one chunk per
// call, and a fresh zstd.Decoder per chunk allocates its block-decoder pool
// every time (tizbac 5142604).
func TestSharedZstdDecoderIsReused(t *testing.T) {
	d1, err := sharedZstdDecoder()
	if err != nil {
		t.Fatal(err)
	}
	d2, err := sharedZstdDecoder()
	if err != nil {
		t.Fatal(err)
	}
	if d1 == nil || d1 != d2 {
		t.Fatalf("decoder not shared: %p vs %p", d1, d2)
	}
}

func TestZstdDecodeAllRoundTrip(t *testing.T) {
	plain := bytes.Repeat([]byte("nimbus-chunk-data "), 4096)
	enc, err := zstd.NewWriter(nil)
	if err != nil {
		t.Fatal(err)
	}
	compressed := enc.EncodeAll(plain, nil)
	_ = enc.Close()

	got, err := zstdDecodeAll(compressed)
	if err != nil || !bytes.Equal(got, plain) {
		t.Fatalf("got err=%v, %d bytes, want %d", err, len(got), len(plain))
	}

	// A failed decode must not poison the shared decoder for the next call.
	if _, err := zstdDecodeAll([]byte("not zstd")); err == nil {
		t.Fatal("want error for corrupt payload")
	}
	got, err = zstdDecodeAll(compressed)
	if err != nil || !bytes.Equal(got, plain) {
		t.Fatalf("after a failed decode: got err=%v, %d bytes, want %d", err, len(got), len(plain))
	}
}

// Restore readers decode chunks from worker pools, so concurrent calls on the
// one shared decoder must each get their own, correct output.
func TestZstdDecodeAllConcurrent(t *testing.T) {
	enc, err := zstd.NewWriter(nil)
	if err != nil {
		t.Fatal(err)
	}
	const n = 32
	plains := make([][]byte, n)
	frames := make([][]byte, n)
	for i := range n {
		plains[i] = bytes.Repeat([]byte{byte(i)}, 1<<16+i)
		frames[i] = enc.EncodeAll(plains[i], nil)
	}
	_ = enc.Close()

	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got, err := zstdDecodeAll(frames[i])
			if err == nil && !bytes.Equal(got, plains[i]) {
				err = fmt.Errorf("frame %d: content mismatch (%d bytes, want %d)", i, len(got), len(plains[i]))
			}
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
}
