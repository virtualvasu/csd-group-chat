//go:build linux

package main

import (
	"log"
	"syscall"
)

// raiseFileLimit lifts this process's open-file limit to the hardest value the
// kernel will allow it.
//
// A balancer holds two descriptors for every request in flight — one to the
// client, one to the backend — so a thousand concurrent users needs well over
// two thousand, while the default soft limit here is 1024. Past that, accept()
// starts returning EMFILE and the service stops taking connections at all.
//
// Doing it in the process rather than relying on `ulimit -n` in the shell that
// happened to start it means the limit is right however the balancer was
// launched, which matters because getting this wrong does not degrade
// performance, it takes the whole service offline.
func raiseFileLimit() {
	var limit syscall.Rlimit

	if err := syscall.Getrlimit(syscall.RLIMIT_NOFILE, &limit); err != nil {
		log.Printf("could not read the file descriptor limit: %v", err)
		return
	}

	if limit.Cur >= limit.Max {
		log.Printf("file descriptor limit: %d (already at the maximum)", limit.Cur)
		return
	}

	previous := limit.Cur
	limit.Cur = limit.Max

	if err := syscall.Setrlimit(syscall.RLIMIT_NOFILE, &limit); err != nil {
		log.Printf("could not raise the file descriptor limit from %d: %v", previous, err)
		return
	}

	log.Printf("file descriptor limit raised from %d to %d", previous, limit.Cur)
}
