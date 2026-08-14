# Release governance

`develop` is the staging integration branch. `main` contains production releases only.

## Required promotion path

1. Land feature work in `develop` through a pull request.
2. Wait for the required checks: `CI / build-and-test`, `CI / Compose Smoke Test`, `Compose End-to-End / compose-e2e`, `Build & Publish Docker Images / build (frontend)`, `Build & Publish Docker Images / build (backend)`, and CodeQL.
3. Deploy the tested `develop` revision to the separately managed staging environment and perform the user acceptance checklist below.
4. Create a `develop` to `main` pull request. Merge only after the required checks and acceptance sign-off are complete.
5. Tag the resulting `main` commit as `vX.Y.Z` to publish images and release artifacts.

## User acceptance gate

Use a freshly registered account and record the tested commit SHA in the release pull request. Verify registration, onboarding, account creation, CSV import, transactions dashboard rendering, logout, and login. Confirm the production deployment health checks and migration logs after release.

The GitHub `staging` environment should require a maintainer approval before a configured staging deployment runs. This repository intentionally does not include deployment credentials or a deployment command: set `RAILWAY_TOKEN` and project-specific identifiers as environment secrets only after a staging Railway project has been created.

## GitHub administrator settings

Apply protection to `main` and `develop`:

- require pull requests and resolved conversations;
- require the checks listed above and an up-to-date branch;
- block force pushes and branch deletion;
- require a linear history;
- restrict direct pushes to maintainers only;
- require one approving review where a second maintainer is available;
- enable GitHub secret scanning, push protection, and private vulnerability reporting.

`CODEOWNERS` review must only be required after its listed team has write access to this repository; otherwise it can make solo-maintainer releases impossible.
