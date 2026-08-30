package pbscommon

import (
	"bytes"
	"encoding/binary"
	"hash/crc32"
	"testing"

	"github.com/klauspost/compress/zstd"
)

// buildBlob wraps payload in the PBS blob framing (8-byte magic, 4-byte CRC32,
// payload) the way the server serves chunks.
func buildBlob(magic []byte, payload []byte) []byte {
	out := make([]byte, 0, 12+len(payload))
	out = append(out, magic...)
	out = binary.LittleEndian.AppendUint32(out, crc32.ChecksumIEEE(payload))
	return append(out, payload...)
}

func TestDecodeChunkBlob(t *testing.T) {
	plain := bytes.Repeat([]byte("nimbus-chunk-data "), 4096)
	enc, err := zstd.NewWriter(nil)
	if err != nil {
		t.Fatal(err)
	}
	compressed := enc.EncodeAll(plain, nil)
	_ = enc.Close()

	pbs := &PBSClient{}

	t.Run("uncompressed", func(t *testing.T) {
		got, err := pbs.decodeChunkBlob(buildBlob(blobUncompressedMagic, plain))
		if err != nil || !bytes.Equal(got, plain) {
			t.Fatalf("got err=%v, %d bytes, want %d", err, len(got), len(plain))
		}
	})

	t.Run("compressed", func(t *testing.T) {
		got, err := pbs.decodeChunkBlob(buildBlob(blobCompressedMagic, compressed))
		if err != nil || !bytes.Equal(got, plain) {
			t.Fatalf("got err=%v, %d bytes, want %d", err, len(got), len(plain))
		}
	})

	t.Run("short body", func(t *testing.T) {
		if _, err := pbs.decodeChunkBlob([]byte{1, 2, 3}); err == nil {
			t.Fatal("want error for short body")
		}
	})

	t.Run("unknown magic", func(t *testing.T) {
		if _, err := pbs.decodeChunkBlob(buildBlob([]byte{1, 2, 3, 4, 5, 6, 7, 8}, plain)); err == nil {
			t.Fatal("want error for unknown/encrypted magic")
		}
	})

	t.Run("corrupt compressed payload", func(t *testing.T) {
		if _, err := pbs.decodeChunkBlob(buildBlob(blobCompressedMagic, []byte("not zstd"))); err == nil {
			t.Fatal("want error for corrupt payload")
		}
	})
}

// The decoder must be created once per client and reused: a restore calls
// decodeChunkBlob once per chunk, and a fresh zstd.Decoder per call allocates
// buffers and goroutines every time (upstream tizbac 5142604).
func TestChunkDecoderIsSharedAndConcurrencySafe(t *testing.T) {
	pbs := &PBSClient{}
	d1 := pbs.chunkDecoder()
	d2 := pbs.chunkDecoder()
	if d1 == nil || d1 != d2 {
		t.Fatalf("decoder not shared: %p vs %p", d1, d2)
	}

	plain := bytes.Repeat([]byte{7}, 1<<16)
	enc, _ := zstd.NewWriter(nil)
	blob := buildBlob(blobCompressedMagic, enc.EncodeAll(plain, nil))
	_ = enc.Close()

	errs := make(chan error, 32)
	for i := 0; i < 32; i++ {
		go func() {
			got, err := pbs.decodeChunkBlob(blob)
			if err == nil && !bytes.Equal(got, plain) {
				err = bytes.ErrTooLarge // any sentinel: content mismatch
			}
			errs <- err
		}()
	}
	for i := 0; i < 32; i++ {
		if err := <-errs; err != nil {
			t.Fatalf("concurrent decode failed: %v", err)
		}
	}
}
