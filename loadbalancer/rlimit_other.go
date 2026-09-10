//go:build !linux

package main

// Descriptor limits are a Unix concern; on other platforms this is a no-op so
// the balancer still builds for local development.
func raiseFileLimit() {}
