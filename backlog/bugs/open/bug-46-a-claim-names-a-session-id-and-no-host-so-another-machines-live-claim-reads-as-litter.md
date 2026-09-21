---
id: bug-46
title: a claim names a session id and no host, so a session on another machine reads a live foreign claim as litter
created: 2026-09-21
tags: tracker, claim, multi-machine
runner-fix: true
updated: 2026-09-21T20:30:25Z
groom-elapsed: 267
groom-tokens: 53957
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

## Cause

Three facts compose, and only the third is the defect.

**A claim's only identifier is machine-scoped.** `ClaimRecord.session` is `CLAUDE_CODE_SESSION_ID` (`shared/types.ts`), which names a transcript under
`~/.claude/projects/` on exactly one host. The record carries nothing else that identifies anybody.

**That id is the whole of what gets published about a holder.** `renderClaim`'s human sentence (`server/src/tracker/claim.ts`), the 409 `holder` payload
(`server/src/items/sources/github.source.ts:443`), `start`'s refusal (`skills/backlog/tools/backlog.mjs:2526`), `show`'s `claim-session:` line (`:2325`) and
`show --json`'s `claim` all name the session and nothing else.

**So the one check a remote reader can actually run answers "no" for every foreign claim, live or dead.** `ls ~/.claude/projects/*/<id>*` and a `ps` scan do not
test whether the holder is alive; they test whether the claim was made on *this* machine. Both questions have the same answer shape, the second is the one that
gets asked, and its "no" is read as the first one's. That is the false negative — and it is worst in exactly the case the protocol exists for, because a claim
whose holder is on the other machine is the only kind of claim a lock is needed for at all.

The irony in `sessionIdentity` (`skills/backlog/tools/backlog.mjs:827`) is worth stating: it already falls back to `<user>@<host>`, which names a host — but
only for a session with no `CLAUDE_CODE_SESSION_ID`, which is not the case a contesting session is ever in. The identifier that names a machine is the one that
never gets published.

Note what is *not* the cause: liveness evidence was not missing. The refusal said `heartbeat 12s ago`, which is the answer, and the mac had it and went looking
for a better one. Nothing here makes a holder more provably alive. What it removes is the reading that made "I cannot find this session" mean "this session is
dead".

## Fix

`ClaimRecord` gains an optional `host`, written by whichever CLI took the claim and echoed everywhere a holder is named. `session` stays the identity and is not
widened: it is an equality key (`stop`'s holder check, `heartbeat`'s and `release`'s author tests, `claim`'s same-run takeover all compare it raw), and a
composite value would stop matching across a version gap — a new build could not release a claim an old build wrote.

1. **`shared/types.ts`** — `ClaimRecord.host?: string`. Optional because every stored claim predates it, and **absent means "the machine was not recorded",
   never "local"** — a reader must not infer that a hostless claim is its own. No `v: 2`: `parseClaim` accepts `v: 1` and passes unknown fields through, so an
   old build ignores `host` and a new build reading an old claim says less rather than throwing. Same precedent `run` and `state` set.

2. **`ItemClaimRequest.host?: string`** — validated as a non-empty string or a 400, the shape rule `session` already follows. **CLI-sent, never derived
   server-side**: the server may be running in the compose stack, where `os.hostname()` is a container id rather than the machine anybody is sitting at.

3. **`skills/backlog/tools/backlog.mjs`** — a `hostIdentity()` helper beside `sessionIdentity()`, returning `` `${os.userInfo().username}@${os.hostname()}` ``,
   sent on `start`'s claim POST. Deliberately *not* folded into `sessionIdentity`, whose return value is compared for equality in three places.

4. **`skills/backlog-orchestrate/tools/orchestrate.mjs`** — `trackerClaim` sends the same, from its own two-line helper. A skill's `tools/` may never import
   another's, so the duplication is the rule rather than a shortcut.

5. **`GithubSource.claim`** — writes `host` into the record when the request carried one and omits the key when it did not. The `holder` payload gains `host`
   at all three sites that build one: the claim refusal (`:443`), and the heartbeat and release refusals (`:555`, `:630`), which name a holder too.

6. **`renderClaim`** — the human sentence becomes `session <s> on <host> holds this issue (<phase>) since <at>` when a host is present, and stays today's
   sentence byte-for-byte when it is not. That line is what a person reading the issue timeline sees without knowing the protocol exists, which is the reading
   this bug is ultimately about.

7. **The refusals and `show`** — `start`'s tracker refusal becomes
   `#5 is already in progress (session <s> on <host>, heartbeat 12s ago) — this session is <mine> on <myhost>`; `stop`'s two `is held by session …` lines take
   the same treatment. `show` gains `claim-host:` beside `claim-session:` and `this-host:` beside `this-session:`, **empty rather than absent** when unknown,
   the rule `claim-session:` already follows. `show --json` carries `host` on the claim object it already returns.

8. **An absent host prints as nothing, never as `unknown`.** An empty value reads as "not recorded" the way an empty `claim-session:` reads as "unheld";
   `unknown` is a word a session can argue with.

Test cases:

- `test/tracker-claim.test.ts` — `renderClaim` produces both sentences (host present, host absent); `parseClaim` round-trips `host`; a `v: 1` claim with no
  `host` key parses with `host === undefined` rather than failing.
- `test/tracker-write.test.ts` — a claim POST carrying `host` writes it into the comment body, one without writes no `host` key at all; the 409 `holder` payload
  carries `host` at all three refusal sites; a non-string or empty `host` is a 400 naming the field.
- `skills/backlog/tools/backlog.test.mjs` — `start`'s refusal line names both hosts when the holder has one and degrades to today's line when it does not;
  `show` prints `claim-host:`/`this-host:`, empty when unknown.

No browser check: nothing here is rendered.

## Notes

Adding a host is not the whole answer on its own — a hostname is still just a string to a reader on a different machine, and a session that wants to take an
item can rationalise around any label. What it buys is the removal of a false NEGATIVE: today "I cannot find this session" is evidence of death, and it must
stop being that. Related: [bug-47](bug-47-a-refusal-that-prints-heartbeat-age-reads-as-a-countdown-and-execute-has-no-stop-clause.md).
