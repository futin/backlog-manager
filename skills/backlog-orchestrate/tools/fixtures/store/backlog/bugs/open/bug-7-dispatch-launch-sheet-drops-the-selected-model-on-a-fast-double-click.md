---
id: bug-7
title: Dispatch launch sheet drops the selected model on a fast double-click
created: 2026-08-12
---

## Symptom

Clicking Dispatch twice quickly sometimes launches with the default model instead of
whatever was selected in the launch sheet.

## Repro

1. Open a card's launch sheet.
2. Change the model picker away from the default.
3. Click Dispatch twice in quick succession.
4. The agent starts on the default model, not the one selected.

## Affects

client/src/components/LaunchSheet.tsx

## Cause

The second click fires before the picker's onChange has committed to state, so the
dispatch body is built from the picker's initial value.

## Fix

Disable the Dispatch button on the first click so a second click before the state
settles cannot fire at all.
