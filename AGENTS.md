# Syllogic delivery workflow

Read `docs/release-governance.md` and `deploy/compose/AGENT-WORKFLOW.md` before release or deployment work.

- Feature branches target `develop`. Local UAT tests an explicitly recorded revision of develop.
- Ask for acceptance of the tested result before promotion to main unless the user has already explicitly approved that promotion.
- Main releases use immutable `vX.Y.Z` image tags. `edge` follows the default branch, not develop.
- On macOS, if Docker is needed and stopped, start Docker Desktop (`open -a Docker`) and wait for `docker info` to succeed. The user has authorized this.
- Inspect running Compose labels, database endpoints and volume names before touching an existing deployment. Never infer runtime revision from the current Git branch.
- Use `python3 scripts/release-lab.py` for an isolated local upgrade rehearsal. Secrets, backups and test credentials are in ignored `.release-lab/`; never print or commit them.
- Pi access is configured by the user's SSH alias `pi`. A timeout requires checking connectivity/address, not guessing another deployment target.
- Preserve databases, uploads, and encryption keys. Never use `down -v` for an upgrade. Never run demo reset against a real user's account.
- Existing deployments may use old `syllogic-*` container names. Do not replace them blindly with the current `personal-portfolio-*` Compose bundle: first map project/volume identity and validate the migration plan.
