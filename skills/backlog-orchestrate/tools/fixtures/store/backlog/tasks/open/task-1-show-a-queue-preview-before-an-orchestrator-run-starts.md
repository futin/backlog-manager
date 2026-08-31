---
id: task-1
title: Show a queue preview before an orchestrator run starts
created: 2026-08-15
---

## Goal

Before committing to a run, a human should be able to see which backlog items are
executable, in what order, and which ones the gate would refuse.

## Plan

Add a "Preview" action to the run launcher that calls the orchestrator's plan command
against the target project and renders each item's gate result as a small badge next
to its title, in the same order the run would use.

## Test cases

An all-ready backlog previews with every item badged ready, bugs then tasks, oldest
first. An ungroomed item previews with its reason shown on hover.

## Done when

The preview badge order matches the plan command's own output for the same project.
