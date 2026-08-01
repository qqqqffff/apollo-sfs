## Summary

<!-- What this changes and why, in a few sentences or bullets. Lead with the
     user-visible behavior; leave the mechanics for the section below. -->

## Changes

<!-- Optional. For anything larger than a single fix, group by area
     (`### Frontend`, `### API`, `### Admin`, …) and note anything a reviewer
     would otherwise have to reverse-engineer: new endpoints and their query
     params, new env vars, why an approach was picked over the obvious one. -->

## Schema & deployment

<!-- Delete this section if the change needs neither.

     - New/changed tables → list the files in `db/` and `db/migrations/`, and
       flag it: ⚠️ **Run `./db/apply-migrations.sh` (or `deploy.sh --migrate`)
       before deploying.**
     - New env vars → name them and say where they belong (root `.env`,
       `docker-stack.yml`, a `--build-arg` for the frontend image).
     - New/changed Swarm services, node constraints, or images that must be
       rebuilt for both amd64 and arm64. -->

## Test plan

<!-- Tick what you actually ran; leave unticked what still needs a human on a
     running stack. Drop the rows that don't apply to this change. -->

- [ ] `cd api && go build ./... && go vet ./... && go test ./...`
- [ ] `cd frontend && npm run build` (tsc + vite)
- [ ] `cd frontend && npx jest`
- [ ] `cd frontend && npm run test:e2e` (needs API + DB up)
- [ ] `cd mobile && npm test`
- [ ] `cd recognition && pytest`
- [ ] Manual verification on a running stack: <!-- what to click, and what should happen -->

## Notes for the reviewer

<!-- Optional: known gaps, follow-ups deliberately left out of scope,
     decisions you'd like a second opinion on, screenshots for UI work. -->
