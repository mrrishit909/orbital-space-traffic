# ORBITAL: one command per job. Ports: web 8431, API 8430, Postgres 55430, mail sink 8432.
.PHONY: dev seed test e2e load-test reset build typecheck openapi record

dev:        ## full stack in Docker: web, API, Postgres, mail sink, OpenTelemetry collector, generator
	docker compose up --build -d --wait
	@echo "web http://localhost:8431  api http://localhost:8430/openapi.json  mail http://localhost:8432"

seed:       ## regenerate the synthetic catalog + conjunction screen, then load it (owner connection)
	node data/simulators/generate.ts
	node apps/api/src/migrate.ts && node apps/api/src/seed.ts --reset

test:       ## unit tests (coverage >= 85% on domain logic) + API contract tests against a throwaway Postgres
	docker compose --profile test run --rm --build test

e2e:        ## Playwright against the static export (needs Google Chrome installed)
	node scripts/copy-fixtures.ts && npm run build -w @orbital/web
	npx playwright test

load-test:  ## HTTP concurrency + 10,000 WebSocket subscriptions against a running API (start it with RATE_LIMIT=1000000)
	node tests/performance/load.ts http://127.0.0.1:8430 32 10 10000

reset:      ## drop all data and reseed
	docker compose down -v
	docker compose up --build -d --wait

build:      ## static export for GitHub Pages (base path = the projects site)
	NEXT_PUBLIC_BASE_PATH=/projects/orbital-space-traffic/demo npm run build -w @orbital/web

typecheck:
	npx tsc -p . && (cd apps/web && npx tsc --noEmit -p .)

openapi:    ## write docs/openapi.json from the running route schemas
	node -e "import('./apps/api/src/server.ts').then(async (m) => { const app = await m.build({ logger: false, mail: null }); await app.ready(); require('fs').writeFileSync('docs/openapi.json', JSON.stringify(app.swagger(), null, 1)); await app.close(); process.exit(0); })"

record:     ## 2-4 minute narrated-by-captions demo recording (Playwright video -> docs/demo.mp4)
	node scripts/record-demo.ts
