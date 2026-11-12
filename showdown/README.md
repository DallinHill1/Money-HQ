# Saturday Showdown

Public URL: https://money-hq-production.up.railway.app/showdown/

Runs inside the existing Node service to fit the account's Railway Free resource limits. The existing Money HQ UI, authentication, Plaid endpoints, database tables and environment variables are unchanged. `server.js` adds one import and one router mount before Money HQ authentication. Saturday Showdown only queries the `showdown` PostgreSQL schema; its accounts, hashed passwords, revocable sessions and picks are separate. It shares the infrastructure and database pool, not Money HQ's account permissions.

## Football data and rules

- ESPN public college football scoreboard provides schedules, rankings, scores and DraftKings spreads. No API key or new paid subscription. This is an undocumented public feed, so availability is not guaranteed; existing schedules/picks survive an outage and the UI shows a delayed-data notice.
- Eight upcoming games per week, prioritizing ranked matchups and always including ESPN team IDs 252 (BYU), 254 (Utah), and 2483 (Oregon). If mandatory games ever exceed eight, the slate expands rather than dropping one. If fewer games exist, all available games are used. Calendar weeks start Monday in America/Denver.
- A slate auto-publishes once and is retained, even as ranks change. Spreads freeze on first import, shared by all players; missing spreads stay unavailable until posted. Live spreads do not replace the original line.
- Winner picks score one point. ATS favorites and pick'em lines score one; underdogs below +5.5 score two, and +5.5 or above score three. Pushes, canceled and postponed games score zero. Only provider-confirmed finals are graded.
- Database time enforces kickoff locks on every write. Public pick reveals are blocked until kickoff. Weekly and season standings are computed from persisted picks and final results.
- The public preview needs no login. Saving picks needs a separate Showdown account (10–128 character password). Display names and records are public; email and password hashes are never returned by public APIs. Password reset is not currently implemented.

## Refresh and costs

Each active browser refreshes every minute, and API refreshes are coalesced to at most once per minute. No always-on football poller is added to the sleeping Railway process. The `showdown-sync.yml` GitHub workflow calls the public status endpoint daily during August–January and every fifteen minutes on Saturdays into Sunday morning UTC to finish games even with no viewer. Previous unfinished slates are checked after ESPN rolls to the next week. GitHub schedule timings are best-effort, and GitHub can disable scheduled workflows after prolonged repository inactivity. Manual workflow dispatch is supported.

Railway Free currently provides a small shared monthly usage credit. Additional visitors and refreshes consume it; sharing an existing service does not provide unlimited free hosting. Services can pause if the account runs out of credit. No plan or billing changes are made by this integration.

## Validation and rollback

`npm test` runs the existing Money HQ regression suites and the PostgreSQL-compatible Showdown integration suite. The latter covers scoring boundaries, BYU/Utah inclusion, auto-publication, immutable lines/slates, sessions, CSRF, source protection, rate limiting, kickoff locks, live/final scores, weekly/season records and outage fallback.

Rollback the integration commit in GitHub/Railway to remove the router. No existing tables were modified and no budget migration is required. Leave the `showdown` schema intact to retain saved picks. Disable the scheduled refresh workflow if rolling back.
