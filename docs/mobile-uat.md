# Mobile responsiveness UAT

Application source tested: `bc8d6b9d8d74c690933e2d30907e78a9ba95f31b`.
Base develop: `8c53da8fcc6c666551aa20514bb15d92bd5bad8d`.
Local source-built rehearsal: http://localhost:8102, Compose project
`syllogic-release-lab-71894437db`.

## Resulting behavior

- Persistent phone navigation exposes every destination, keeps labels independent
  of the desktop collapse preference, closes after navigation and has an explicit
  close control. Desktop sidebar behavior remains available.
- Mobile transaction cards retain every visible transaction field, sorting,
  selection, bulk actions, pagination and detail editing. The full table remains
  selectable; the choice survives route remounts. Selection follows transaction IDs.
- Dashboard controls wrap and charts stack. The full cashflow diagram scrolls
  locally on narrow screens. Asset allocation and subscription metadata remain visible.
- Settings and holding-detail tabs form bounded rows. Account headers, report forms,
  onboarding progress and actions adapt to narrow widths. Wide holdings and report
  histories retain all columns through local horizontal scrolling.
- Dialogs, sheets, popovers and walkthroughs stay within the viewport and scroll.
  Bulk actions leave pagination reachable while rows are selected.

## Verification on 2026-10-25

| Check | Result |
| --- | --- |
| Source frontend/backend Docker build; app/backend health | PASS |
| Chromium: 17 authenticated routes at 320, 390, 768, 1440 pixels | PASS |
| WebKit with iPhone emulation: same 68 route/width checks | PASS |
| Both engines: date presets, dialogs, detail sheets, selection, bulk actions, pagination clearance and persisted table choice | PASS |
| Both engines: populated report-run history fixture, including its final column | PASS |
| Phone signup/onboarding/account/import/logout/login, skip-import, multi-account transfers and duplicate detection (3 cases) | PASS |
| Desktop versions of those three journeys | PASS |
| 45 focused component/regression tests across 9 files | PASS |
| TypeScript and ESLint across 47 modified TypeScript files | PASS: zero errors; 10 lint warnings |
| Migration runner twice; existing-value comparisons across six tables | PASS |

Before the final application restart, existing values and counts matched for users
(14), authentication accounts (14), financial accounts (18), transactions (3,275),
holdings (8) and broker trades (8). Generated UAT data is isolated from the original
source database. The original database, uploads and authentication/encryption keys
were retained.

Screenshots and traces are in the ignored `frontend/test-results/` directories.
Credentials and lab configuration remain encrypted in ignored `.release-lab/`.
The ordinary worker and scheduler are omitted. For browser imports, a temporary
processor executes only CSV and post-import tasks belonging to generated
`compose-e2e-*` test users; other broker messages remain untouched.

The report-history case uses a failed-run response fixture. Provider auth/sync and
production deployment are outside this local UI validation.

## Repeating the checks

Use `python3 scripts/release-lab.py up` for a source build, two migration runs and
preservation checks; `smoke` repeats authenticated page checks. Supply the isolated
lab demo credentials in `MOBILE_UAT_EMAIL` and `MOBILE_UAT_PASSWORD` without logging
them, and run `e2e/mobile-responsive.spec.ts` against `E2E_BASE_URL`. Optional
`MOBILE_UAT_ACCOUNT_ID` and `MOBILE_UAT_HOLDING_ID` enable populated detail routes.
Use `E2E_MOBILE=1` with `compose-happy-path.spec.ts` for phone journeys; omit it for
desktop. Keep each browser/suite's Playwright output directory separate.

## Promotion gate

Land the feature through a develop PR, then record the tested develop revision in
the promotion PR. Acceptance of that tested result is required before promotion
to main. GitHub Actions are bypassed at the user's explicit request; local test
results above are the validation evidence. Acceptance is pending.
