package main

import (
	"bytes"
	"crypto/sha256"

	"pbscommon"
)

// zeroBlock / zeroBlockDigest: a full 4 MB fixed chunk of zeros and its SHA-256,
// computed once. Raw disk images are full of such blocks (unallocated space,
// zeroed partitions), and comparing 4 MB against zeros is ~30x cheaper than
// hashing it — upstream tizbac 519b624. A disk would have to be >95 % full of
// non-zero data for the extra compare to cost more than it saves.
var (
	zeroBlock       = make([]byte, pbscommon.PBS_FIXED_CHUNK_SIZE)
	zeroBlockDigest = sha256.Sum256(zeroBlock)
)

// fixedChunkDigest returns the SHA-256 of a fixed-index chunk, short-circuiting
// full all-zero blocks. A short trailing chunk (disk size not a multiple of
// 4 MB) is always hashed for real: its digest is over its actual length.
// The result is a fresh slice the caller may keep.
func fixedChunkDigest(data []byte) []byte {
	if len(data) == pbscommon.PBS_FIXED_CHUNK_SIZE && bytes.Equal(data, zeroBlock) {
		d := zeroBlockDigest
		return d[:]
	}
	d := sha256.Sum256(data)
	return d[:]
}
