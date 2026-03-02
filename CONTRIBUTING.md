# Contributing to Transcriber

Thank you for your interest in contributing.

## Getting started

```bash
git clone https://github.com/andrewjamesturner0/transcriber.git
cd transcriber
npm install
bash scripts/setup.sh   # builds whisper.cpp, downloads model + FFmpeg
npm start                # launches the Electron app
```

The setup script builds whisper.cpp from source (Linux), downloads the default Tiny English model, and fetches a static FFmpeg binary. See [DEVELOPMENT.md](DEVELOPMENT.md) for Windows-native setup and more detail.

### Prerequisites

- Node.js >= 18
- Git
- `curl` and `unzip`
- **Linux:** C/C++ compiler (`gcc`/`g++`), `cmake` >= 3.10, `make`

## Code style

There is no automated linter or formatter configured. Follow the conventions in the existing code:

- 2-space indentation
- Single quotes for strings
- `const` by default, `let` when reassignment is needed
- Descriptive variable names

## Pull requests

1. Fork the repository
2. Create a feature branch from `master`
3. Make your changes
4. Test manually — run `npm start` and verify the app works as expected
5. Submit a PR with a clear description of the change and why it's needed

Keep PRs focused on a single change. If you're fixing a bug and want to refactor nearby code, submit them as separate PRs.

## Issues

- **Bug reports** — use the [bug report template](https://github.com/andrewjamesturner0/transcriber/issues/new?template=bug_report.md)
- **Feature requests** — use the [feature request template](https://github.com/andrewjamesturner0/transcriber/issues/new?template=feature_request.md)
- **Questions** — use [GitHub Discussions](https://github.com/andrewjamesturner0/transcriber/discussions), not Issues

## Good first issues

Look for issues labelled [`good first issue`](https://github.com/andrewjamesturner0/transcriber/labels/good%20first%20issue) — these are specifically chosen for new contributors.

## Licence

By contributing, you agree that your contributions will be licensed under the [GNU General Public License v3.0](LICENSE).
