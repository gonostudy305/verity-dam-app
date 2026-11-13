# VerityDAM responsive device smoke checklist

This checklist is intentionally separate from the isolated Playwright suite. It
covers browser/OS behavior that a desktop browser cannot fully reproduce.

## Before sign-off

- [ ] Use a staging/demo account only; never record production cookies or media URLs in screenshots.
- [ ] Confirm the browser address is the staging or local environment.
- [ ] Test both light and dark theme where the device/browser supports it.
- [ ] Test portrait and landscape orientation.
- [ ] Confirm browser zoom remains enabled and no page-level horizontal scroll appears.

## iPhone / iOS Safari

- [ ] Current iOS Safari: 320–430px layouts, bottom navigation, safe-area inset and keyboard focus.
- [ ] Previous supported iOS Safari: open/close More sheet, Escape-equivalent dismissal, back-swipe and route state.
- [ ] Review a long metadata form: focused field is not hidden behind the keyboard or sticky actions.
- [ ] Library multi-select works by touch without hover.

## iPad / iPadOS

- [ ] iPad portrait at 768px: compact rail is visible and content has no clipped primary actions.
- [ ] iPad landscape at 1024–1180px: compact rail remains usable; no accidental desktop sidebar takeover.
- [ ] Split View: resize continuously across the 768/1024 boundary without remounting workflow state.
- [ ] Sheet/dialog content scrolls independently only when needed and returns focus to its trigger.

## Android Chrome

- [ ] Current Android Chrome at 360–430px: bottom navigation and safe-area/gesture-bar clearance.
- [ ] Keyboard open: inputs and primary CTA remain reachable; no horizontal page overflow.
- [ ] Touch-only actions expose visible controls; no critical action depends on hover.

## Evidence

- [ ] Record device model, OS version, browser version, viewport/orientation and build SHA.
- [ ] Attach only redacted screenshots for failures; do not include personal account or private asset data.
