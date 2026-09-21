---
id: bug-46
title: a claim names a session id and no host, so a session on another machine reads a live foreign claim as litter
created: 2026-09-21
tags: tracker, claim, multi-machine
---

## Symptom

A `backlog-execute` session on the mac lost the claim race on https://github.com/futin/guide-manager/issues/5 to a session on the Linux machine. It received the
correct refusal and wrote nothing. It then set out to decide whether the claim it had lost to was real, and concluded — from evidence available only on its own
machine — that it was not:

```
20:08:14  ls -d ~/.claude/projects/*/f51e844e-9f99-4894-91dd-6af8db46db01*
          NONE — no session by that id exists on disk
20:09:10  "Claim holder f51e844e has no transcript and no process — it's litter from a
           claim-race experiment another session is running"
```

`f51e844e` was the Linux machine, mid-execute, heartbeating twelve seconds earlier. The claim was as live as a claim gets. The mac had no way to see that, so it
scheduled itself to take the item the moment the fifteen-minute staleness window expired, and spent the wait running the project's full test suite twice and
drafting three files.

## Repro

1. From machine A, `backlog.mjs start #5 --as execute`. A wins.
2. From machine B, `backlog.mjs start #5 --as execute`. B loses and is told `#5 is already in progress (session <A's id>, heartbeat 12s ago)`.
3. On B, look for `<A's id>` anywhere: `ls ~/.claude/projects/*/<A's id>*`, `ps` for a process, `gh api` for the comment body. The comment body names the
   session and nothing else. Every local signal says the holder does not exist.

## Evidence

The claim record's shape, read off comment `5766769179`:

```json
{
  "v": 1,
  "session": "f51e844e-9f99-4894-91dd-6af8db46db01",
  "phase": "execute",
  "at": "2026-09-21T20:06:22.344Z",
  "heartbeat": "2026-09-21T20:06:22.344Z",
  "counters": { "groomElapsed": 178, "executeElapsed": 0, "groomTokens": 35090, "executeTokens": 0 }
}
```

A session id is machine-scoped by construction — it names a transcript under `~/.claude/projects/` on exactly one host. Publishing it to a tracker, which is the
one place two machines meet, and publishing nothing else, means the only identifier a remote reader gets is the one identifier that cannot be resolved remotely.
The absence of a local transcript is then read as proof of death, and it is the opposite: a claim whose holder is on the OTHER machine is precisely the claim
that must be respected, because it is the case the protocol exists for.

`show`'s `claim-session:` line has the same gap — it prints an id a reader on another machine can do nothing with.

## Affects

- `server/src/tracker/claim.ts` — the claim record's shape, `render`/`parse`.
- `skills/backlog/tools/backlog.mjs` — `start`'s refusal line, `show`'s `claim-session:` line, `show --json`'s `claim`.

## Notes

Adding a host is not the whole answer on its own — a hostname is still just a string to a reader on a different machine, and a session that wants to take an
item can rationalise around any label. What it buys is the removal of a false NEGATIVE: today "I cannot find this session" is evidence of death, and it must
stop being that. Related: [bug-47](bug-47-a-refusal-that-prints-heartbeat-age-reads-as-a-countdown-and-execute-has-no-stop-clause.md).
