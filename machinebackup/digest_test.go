package main

import (
	"bytes"
	"crypto/sha256"
	"testing"

	"pbscommon"
)

func TestFixedChunkDigest(t *testing.T) {
	zero := make([]byte, pbscommon.PBS_FIXED_CHUNK_SIZE)
	want := sha256.Sum256(zero)

	t.Run("all-zero full block uses precomputed digest", func(t *testing.T) {
		got := fixedChunkDigest(zero)
		if !bytes.Equal(got, want[:]) {
			t.Fatalf("zero block digest mismatch")
		}
	})

	t.Run("non-zero block is hashed", func(t *testing.T) {
		data := make([]byte, pbscommon.PBS_FIXED_CHUNK_SIZE)
		data[len(data)-1] = 1
		exp := sha256.Sum256(data)
		if got := fixedChunkDigest(data); !bytes.Equal(got, exp[:]) {
			t.Fatalf("non-zero block digest mismatch")
		}
	})

	t.Run("short trailing block is hashed even when all zero", func(t *testing.T) {
		// The last chunk of a disk whose size is not a multiple of 4 MB is
		// shorter; its digest must be of the actual bytes, not the 4 MB zero
		// digest, or the index would reference a chunk of the wrong length.
		short := make([]byte, 1234)
		exp := sha256.Sum256(short)
		if got := fixedChunkDigest(short); !bytes.Equal(got, exp[:]) {
			t.Fatalf("short block digest mismatch")
		}
	})

	t.Run("returns a private copy", func(t *testing.T) {
		a := fixedChunkDigest(zero)
		b := fixedChunkDigest(zero)
		a[0] ^= 0xff
		if bytes.Equal(a, b) {
			t.Fatalf("digest slices alias shared storage")
		}
	})
}
