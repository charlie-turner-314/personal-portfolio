# Mobile responsiveness verification

Candidate branch: `codex/mobile-responsive` (based on develop `8c53da8`).

## Scope

Keep desktop features and presentation, while making every destination and action
reachable on narrow screens. Check navigation, dashboard filters/charts, transactions
and bulk actions, subscriptions, budget, cashflow, investments, assets, reports,
settings, onboarding and CSV import. Wide financial tables retain their columns
through local horizontal scrolling. Do not hide information to make pages fit.

## Local environment

Isolated lab at http://localhost:8102, Compose project
`syllogic-release-lab-71894437db`. Source database and uploads are untouched.
Generated demo and fresh credentials remain encrypted in ignored `.release-lab/`.

Use `python3 scripts/release-lab.py up` for source builds, two migration runs and
existing-value preservation checks. Use `accounts` once to prepare test accounts;
`smoke` repeats authenticated server-rendering checks.

## Browser checks

`frontend/e2e/mobile-responsive.spec.ts` checks 12 authenticated routes at widths
320, 390, 768 and 1440, captures screenshots, and exercises labelled mobile
navigation. Supply the isolated lab demo credentials through `MOBILE_UAT_EMAIL`
and `MOBILE_UAT_PASSWORD`, without logging them. Set `E2E_BASE_URL` to the lab URL.

Run the existing `compose-happy-path.spec.ts` with `E2E_MOBILE=1` to exercise
registration, onboarding, account creation, import and logout/login at 390px.
Run again without that variable for desktop. Use separate Playwright output
directories to retain both runs.

## Findings and status

- Added a persistent mobile menu opener, labelled drawer, explicit close control,
  current-page semantics and close-on-navigation; desktop collapse remains available.
- Dialogs, sheets, alert dialogs and walkthroughs fit the viewport and can scroll.
- Dashboard controls wrap; chart columns stack on phones; walkthrough positioning
  no longer lets its animation override centering.
- Transaction filters/actions and pagination wrap; bulk actions remain available.
- Report forms, subscription headings, cashflow form columns and settings tabs adapt
  to available space. Date presets stack above calendars on phones.
- Local webpack production build passed. Focused component tests and TypeScript
  passed. Browser review is ongoing; this document is not acceptance sign-off.
- The first full route sweep passed at 1440px and identified the remaining transaction,
  subscription, cashflow and tablet settings overflows addressed in the next candidate.

Before promotion, record the final tested SHA, passing browser/flow results and
visual review here and in the release PR. Obtain acceptance of that recorded
revision before merging the develop-to-main promotion.
