# Reproducible demo (≈ 5 minutes, one laptop, two identities)

Uses two `CODEMEET_HOME` directories to play Sam and Ava, plus a throwaway local Postgres.

```bash
# Terminal A: the server (Sam's machine)
docker compose up -d postgres
export DATABASE_URL='postgresql://codemeet:codemeet-local-dev@127.0.0.1:5432/codemeet?sslmode=disable'
export SAM=/tmp/demo-sam AVA=/tmp/demo-ava ; mkdir -p $SAM $AVA/project ~/demo-app/src
echo 'export const greet = () => "hello";' > ~/demo-app/src/index.ts
CODEMEET_HOME=$SAM codemeet init --database-url-env DATABASE_URL --migrate
CODEMEET_HOME=$SAM codemeet server start &
```

```bash
# Sam
export CODEMEET_ROOM_PASSWORD=demo-password
CODEMEET_HOME=$SAM codemeet room create --name Sam --project ~/demo-app
# Ava (copy the Room ID printed above)
CODEMEET_HOME=$AVA codemeet room join <ROOM_ID> --name Ava --project $AVA/project &
CODEMEET_HOME=$SAM codemeet members approve <REQUEST_ID>      # id from `codemeet members`

# live sync both ways
echo '// hi from Ava' >> $AVA/project/src/index.ts ; sleep 2 ; cat ~/demo-app/src/index.ts

# Sam's Claude proposes, Ava reviews, Sam approves
CODEMEET_HOME=$SAM codemeet agent run claude "add a farewell(name) function to src/index.ts"
CODEMEET_HOME=$AVA codemeet proposals ; CODEMEET_HOME=$AVA codemeet diff <PROPOSAL_ID>
CODEMEET_HOME=$SAM codemeet approve <PROPOSAL_ID>

# consent: denied by default, then mutual
CODEMEET_HOME=$AVA codemeet agent run codex "create src/math.ts exporting add(a,b)"     # registers Ava's Codex
CODEMEET_HOME=$SAM codemeet messages send --from claude --to "Ava's Codex" "hi"          # -> refused
CODEMEET_HOME=$SAM codemeet permissions grant message claude --peer "Ava's Codex" --max-turns 4
CODEMEET_HOME=$AVA codemeet permissions grant message codex  --peer "Sam's Claude" --max-turns 4
CODEMEET_HOME=$AVA codemeet permissions grant invoke  codex  --peer "Sam's Claude" --auto
CODEMEET_HOME=$AVA codemeet responder codex auto
CODEMEET_HOME=$SAM codemeet messages send --from claude --to "Ava's Codex" "Name for a function that adds two numbers?"
sleep 30 ; CODEMEET_HOME=$SAM codemeet messages                                          # Codex's reply appears
CODEMEET_HOME=$AVA codemeet permissions                                                  # copy a grant id
CODEMEET_HOME=$AVA codemeet permissions revoke <GRANT_ID>                                # further messages are blocked

# cleanup
CODEMEET_HOME=$AVA codemeet leave ; CODEMEET_HOME=$SAM codemeet leave ; kill %1 ; docker compose down -v
```

Without `claude`/`codex` installed, skip the agent steps; human sync and the approval flow can be demonstrated with the
fixture in `tests/fixtures/fake-provider.mjs` by exporting `CODEMEET_CLAUDE_BIN` / `CODEMEET_CODEX_BIN` to point at it.
