// Command replay parses a CS2 demo on the server with the 2D viewer's own parser
// (sparkoo/csgo-2d-demo-viewer, demoinfocs-golang) and writes the messages the player
// needs as a gzip file of frames: [uint32 little-endian length][protobuf Message].
// The web panel runs it once per demo and serves the result to "Watch 2D".
//
// The Dockerfile copies this file into the upstream parser module as cmd/replay.
//
//	replay <demo file> <output file>
//
// The output is written to <output>.tmp and renamed when complete. On failure the
// reason is printed to stderr and the exit code is 1.
package main

import (
	"bufio"
	"compress/gzip"
	"csgo-2d-demo-player/conf"
	"csgo-2d-demo-player/pkg/log"
	"csgo-2d-demo-player/pkg/parser"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: replay <demo file> <output file>")
		os.Exit(2)
	}
	if err := run(os.Args[1], os.Args[2]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(demoPath, outPath string) error {
	log.Init(conf.MODE_PROD)
	in, err := os.Open(demoPath)
	if err != nil {
		return err
	}
	defer in.Close()

	tmp := outPath + ".tmp"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	ok := false
	defer func() {
		if !ok {
			out.Close()
			os.Remove(tmp)
		}
	}()

	buf := bufio.NewWriterSize(out, 1<<20)
	gz, _ := gzip.NewWriterLevel(buf, 6)
	var writeErr error
	frames := 0
	var header [4]byte
	// The parser picks the decompressor from the file name (.dem, .gz, .bz2, .zst).
	parseErr := parser.WasmParseDemo(filepath.Base(demoPath), bufio.NewReaderSize(in, 1<<20), func(payload []byte) {
		if writeErr != nil {
			return
		}
		binary.LittleEndian.PutUint32(header[:], uint32(len(payload)))
		if _, writeErr = gz.Write(header[:]); writeErr == nil {
			_, writeErr = gz.Write(payload)
		}
		frames++
	})
	if parseErr != nil {
		return fmt.Errorf("could not read demo: %w", parseErr)
	}
	if writeErr != nil {
		return writeErr
	}
	if frames == 0 {
		return errors.New("could not read demo: no rounds found")
	}
	if err := gz.Close(); err != nil {
		return err
	}
	if err := buf.Flush(); err != nil {
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, outPath); err != nil {
		return err
	}
	ok = true
	return nil
}
