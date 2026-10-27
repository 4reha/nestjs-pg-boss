# Contributing

```bash
npm ci
npm run typecheck
npm test            # Jest, with the integration tests on PGlite, so no database is needed
npm run test:postgres   # the real-Postgres tests through Testcontainers; needs Docker
npm run build
npm run check:package
```

CI runs the tests on Node 22 and 24 against Nest 10, 11 and 12. To reproduce one cell locally, install that Nest major with `npm install --no-save @nestjs/common@10 @nestjs/core@10 @nestjs/testing@10` and run `npm test`.

## Commit messages

Releases are generated from commit messages, so they follow [Conventional Commits](https://www.conventionalcommits.org/).

| Prefix | Effect on the version |
| --- | --- |
| `fix:` | patch |
| `feat:` | minor |
| `feat!:` or a `BREAKING CHANGE:` footer | minor while the version is below 1.0, major after |
| `docs:`, `test:`, `build:`, `ci:`, `chore:` | no release |

If you squash-merge pull requests, the PR title becomes the commit message, so write it in this format.

## How a release happens

1. Conventional commits land on `main`.
2. The Release workflow opens or updates a pull request titled `chore(main): release x.y.z`. It holds the version bump and the changelog.
3. Merging that pull request creates the tag and the GitHub Release. The same workflow run then publishes to npm.

Nobody runs `npm publish` by hand. The workflow authenticates to npm through OIDC (trusted publishing), so the repository stores no npm token, and each published version carries a provenance attestation.
