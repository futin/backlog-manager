---
id: bug-2
title: Settings hue swatch preview lags one theme change behind
created: 2026-08-10
---

## Symptom

Switching themes in Settings updates the board immediately, but the hue swatch preview
next to it still shows the previous theme's color until a second theme change happens.

## Repro

1. Open Settings.
2. Switch the active theme.
3. Watch the hue swatch preview — it still shows the old theme's hue.

## Affects

client/src/routes/Settings.tsx

## Cause

unknown

## Fix

unknown
