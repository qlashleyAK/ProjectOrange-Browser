# Security policy

Project Orange is a browser game with a game server. We take reports
seriously, especially anything affecting player safety or server
integrity.

## What we care about most

- **Server-side**: anything that lets one player execute code, crash
  rooms for others, write to the database without playing, or spend
  someone else's resources.
- **Client-side**: XSS vectors in the HUD/menu rendering, anything that
  compromises a visitor's browser.
- **API**: the ranked queue, identity tokens, and leaderboard endpoints
  (cheating that corrupts the ladder is a real bug, not a feature).

## Reporting

**Email:** qlashley@gmail.com

Include: what it does, how you found it, reproduction steps or a PoC, and
whether it's live on projectorange.nexus or only local. We'll acknowledge
within a few days and keep you posted on the fix. Please don't open a
public issue for anything above — public issues are great for gameplay
bugs, wrong for security bugs.

## Scope notes

- The game server intentionally trusts **validated client claims** in a
  few places (e.g. mine-run checkpoint claims are proximity-checked
  server-side) — finding a bypass around those checks is in scope and
  interesting to us.
- DoS-by-volume on the public endpoints is out of scope; DoS from a
  single tiny payload (a packet that crashes a room) is in scope.
- No bug bounty program (yet) — credits in the release notes and our
  sincere gratitude is the current rate.
