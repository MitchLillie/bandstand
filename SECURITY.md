# Security Policy

## Reporting a vulnerability

Please report security issues by opening a GitHub issue:

https://github.com/MitchLillie/bandstand/issues

If the issue is sensitive and you'd rather not disclose details publicly, open a
minimal issue saying so and we'll arrange a private channel.

## Credential storage

`bandstand` authenticates with your BAND session cookies — `band_session` and the
`secretKey` HMAC key. These are stored **in plaintext** on your machine at
`~/.band_session.json` (created with `0600` permissions), or wherever `BAND_STATE`
points.

- This is your live session: anyone who can read that file can act as you on BAND.
- The cookies are sent only to BAND's own API hosts (`api-*.band.us`), nowhere else.
- The file is gitignored — never commit it. If you believe it has been exposed, log
  out of BAND (or clear your session cookies) to invalidate it, then `bandstand
  login` again.

## Scope

This is an unofficial client for your **own** BAND account. It performs no telemetry,
collects nothing, and ships **zero runtime dependencies**.
