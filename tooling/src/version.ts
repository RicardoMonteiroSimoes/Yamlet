// The single source of truth for the CLI's version string.
//
// In the source tree this is the placeholder below; the release build
// (scripts/build-release.sh) regenerates this whole file with the real tag
// before `deno compile`, so a shipped binary reports its true version while a
// from-source run reports `0.0.0-dev`. Keep this file to just the constant —
// the build overwrites it wholesale.
export const VERSION = "0.0.0-dev";
