# Security Policy

This is a small, offline, single-device pass-and-play app with no network, accounts, or
servers — its attack surface is minimal. Still, we take reports seriously.

## Reporting a vulnerability

Please report security issues **privately** rather than opening a public issue:

- Use GitHub's **"Report a vulnerability"** (Security advisories) on the repository, or
- Email the maintainer at **anujjadon98@gmail.com**.

Include steps to reproduce and the affected version/commit. We aim to acknowledge reports
within a few days.

## In scope

- Anything that could leak hidden game information on a shared screen (the core
  correctness/fairness property of the game — see CONTRIBUTING.md).
- Issues in the build/release pipeline (e.g. accidental secret exposure).

## Handling secrets

Never commit secrets. The Expo access token used for EAS builds must be provided via the
`EXPO_TOKEN` environment variable / repository secret — see `.env.example`. The `.gitignore`
excludes `.env*`, keystores, and provisioning profiles.
