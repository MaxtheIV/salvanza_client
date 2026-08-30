package pbscommon

import (
	"os"
	"path/filepath"
	"testing"
)

// TestOnEntryFiresPerArchivedEntry: the GUI's live "current file" / file counter
// rides on OnEntry, so it must fire exactly once per archived file and directory,
// and not for entries the exclude policy pruned.
func TestOnEntryFiresPerArchivedEntry(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "sub", "b.txt"), []byte("world!"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "skip.tmp"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	type ev struct {
		path  string
		size  uint64
		isDir bool
	}
	var got []ev
	a := &PXARArchive{
		WriteCB:     func([]byte) error { return nil },
		ExcludeList: []string{"*.tmp"},
		ExcludeRoot: root,
		OnEntry: func(p string, size uint64, isDir bool) {
			got = append(got, ev{p, size, isDir})
		},
	}
	if _, err := a.WriteDir(root, "", true); err != nil {
		t.Fatalf("WriteDir: %v", err)
	}

	files := map[string]uint64{}
	dirs := map[string]bool{}
	for _, e := range got {
		if e.isDir {
			dirs[e.path] = true
		} else {
			files[e.path] = e.size
		}
	}
	if len(files) != 2 {
		t.Fatalf("want 2 file events, got %d: %+v", len(files), got)
	}
	if files[filepath.Join(root, "a.txt")] != 5 {
		t.Errorf("a.txt size = %d, want 5", files[filepath.Join(root, "a.txt")])
	}
	if files[filepath.Join(root, "sub", "b.txt")] != 6 {
		t.Errorf("sub/b.txt size = %d, want 6", files[filepath.Join(root, "sub", "b.txt")])
	}
	if _, excluded := files[filepath.Join(root, "skip.tmp")]; excluded {
		t.Errorf("excluded skip.tmp must not fire OnEntry")
	}
	if !dirs[root] || !dirs[filepath.Join(root, "sub")] {
		t.Errorf("want dir events for root and sub, got %v", dirs)
	}
	if len(dirs) != 2 {
		t.Errorf("want exactly 2 dir events, got %d", len(dirs))
	}
}

// A nil OnEntry must be a no-op (every existing caller leaves it unset).
func TestOnEntryNilIsNoop(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	a := &PXARArchive{WriteCB: func([]byte) error { return nil }}
	if _, err := a.WriteDir(root, "", true); err != nil {
		t.Fatalf("WriteDir with nil OnEntry: %v", err)
	}
}
