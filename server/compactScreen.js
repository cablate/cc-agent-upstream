// Claude Code draws a compaction's progress in its own terminal, and reports it
// nowhere else (the hooks say only that one started and that it ended):
//
//   * Compacting conversation… (4m 41s · ↓ 19.3k tokens)
//     ▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱ 53%
//
// So the page reads the percentage off the screen. Only the last compaction on screen counts, and only a bar within
// a few lines under it.
function compactPercent(screen) {
  const text = String(screen || '');
  const at = text.lastIndexOf('Compacting conversation');
  if (at < 0) return null;
  for (const line of text.slice(at).split('\n').slice(0, 4)) {
    const match = /[▰▱]{4,}\s*(\d{1,3})\s*%/.exec(line);
    if (match) return Math.min(100, Number(match[1]));
  }
  return null;
}

module.exports = {compactPercent};
