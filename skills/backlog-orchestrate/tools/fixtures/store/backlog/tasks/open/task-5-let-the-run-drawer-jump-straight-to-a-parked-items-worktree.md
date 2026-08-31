---
id: task-5
title: Let the run drawer jump straight to a parked item's worktree
created: 2026-08-18
---

## Goal

A parked item's worktree still exists on disk; the drawer should make it easy to open a
terminal there instead of making a human dig the path out of run.json by hand.

## Plan

Add an "Open in terminal" action next to a parked item's worktree path. TBD whether this
shells out to the user's configured terminal app or just copies the path to the
clipboard and lets them paste it themselves.

## Test cases

## Done when
