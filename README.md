# Signal

A feature request tool that helps product teams spot related feedback and understand the customer problem behind it.

## Current status

Request submission, search, support, AI analysis and human review are implemented. Submit a title and description, find existing requests, and add or remove support. With an API key configured, Signal can describe the underlying customer need and suggest related or duplicate requests with quotes from both records. A person decides which suggestions to accept or dismiss.

Requests, support, analysis runs and review decisions are stored in SQLite and remain after refreshing the browser or restarting the server. The application works without an AI key: requests still save, while analysis controls explain that AI is not connected. It does not substitute sample results for live analysis.

Source repository: [walterg1010/signal](https://github.com/walterg1010/signal). The application runs locally; publishing the source does not deploy a hosted service.

## Run locally

Use Node.js 24.x (developed with 24.15.0) and npm:

```sh
git clone https://github.com/walterg1010/signal.git
cd signal
npm ci
npm run dev
```

Open http://localhost:3000 or http://127.0.0.1:3000. The server binds to loopback only. Stop it with Ctrl+C.

For an optimized build:

```sh
npm run build
npm start
```

No account, API key, or separate database service is needed for submission, search or support. The first database access creates `data/signal.db`. Database files are ignored by Git. The board starts empty; there is no automatic seed data.

`SIGNAL_DB_PATH` can point to a separate SQLite file for testing. Otherwise the path is relative to the project root. Browser QA used a separate database outside this project, so its sample requests do not appear in your normal board.

### Optional AI setup

Create a project API key in the [OpenAI API keys dashboard](https://platform.openai.com/api-keys), following the [official quickstart](https://developers.openai.com/api/docs/quickstart). Give it a recognizable name such as `Signal local`. Paste the secret directly into the local configuration file below; do not send it in chat.

Check the organization's [API billing page](https://platform.openai.com/settings/organization/billing/) for an available balance. Eligible ChatGPT Pro and Business subscriptions can claim API credits after linking an eligible API organization; see the [current eligibility and claim instructions](https://developers.openai.com/api/docs/guides/chatgpt-api-credits) before purchasing credits. Creating a key alone does not establish that the account has available API credits.

Create `.env.local` in this directory using `.env.example` as a starting point. If `.env.local` already exists, edit it rather than replacing it. The example deliberately leaves the key blank:

```dotenv
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.4-mini-2026-03-17
```

Add your own OpenAI API key after `OPENAI_API_KEY=` in the local file, then restart the server. `.env.local` is ignored by Git; keep real keys out of `.env.example`, source code and screenshots. The key is used only on the server and is never returned to the browser. The pinned model is the default; `OPENAI_MODEL` can override it with a compatible model that supports the Responses API and structured outputs.

Live analysis and review were verified with a locally configured key. Intermittent connection resets occurred during testing; manual retries succeeded and saved requests were retained. The verification section records the scope of these checks. A fresh checkout requires its own key; no credentials are included in the repository.

## What works

- Title and description form with field errors and character limits.
- Server validation: whitespace-only values, wrong types, oversized fields and invalid JSON are rejected.
- Persisted requests shown newest first, with creation dates and expandable descriptions.
- Instant title and description search with result counts, clear search and a distinct no-match state. Search ignores case, trims surrounding whitespace and normalizes Unicode forms; punctuation is matched literally.
- Support counts and add/remove controls. The database enforces one support per request and browser identity, including concurrent attempts.
- Confirmed support updates, pending controls and safe retries after a connection failure.
- Loading, empty, retry, save failure and success states.
- Draft preservation when a save fails; the interface asks you to refresh the board if the outcome is uncertain.
- A pending-save lock to prevent repeated clicks in the same form.
- Responsive desktop and mobile layouts, labeled inputs, keyboard focus and live success feedback.
- Analysis after a successful submission when AI is connected, plus manual analysis and reanalysis for existing requests. A failed analysis does not undo the saved request.
- An underlying problem, theme, missing details and up to five duplicate or related suggestions, each with supporting quotes.
- Explicit link and dismiss decisions. Accepted links are visible from both requests, survive reanalysis, and can be removed later. Linking preserves the original requests and their support counts.
- Persistent running, completed and failed analysis states, safe error messages and manual retry controls.

## How analysis works

The server makes one OpenAI Responses API call for an analysis. It sends the selected request's title and description, plus the 20 most recent other requests, with each candidate description limited to 1,500 characters. Titles and internal request IDs are included so suggestions can be checked against the supplied records. Older requests outside that window cannot be suggested; relevant details beyond a candidate's description limit may be missed. This is a bounded first pass for a small board, not a search across the complete history.

Request text leaves the local application only when analysis runs. When a key is configured, saving a new request starts analysis after the save succeeds; existing requests can be analyzed from their controls. Browsing, searching and supporting requests do not trigger AI calls. The provider request sets `store: false`, which does not promise zero provider retention; the provider's data handling policies still apply.

The current prompt, `feature-triage-v2`, treats submitted feedback as untrusted data, distinguishes a shared topic from the same underlying need, and asks for unanswered information rather than invented priority, revenue or confidence scores. It asks for the customer's current problem instead of restating the requested feature. The model has no tools. A strict JSON schema constrains the response, and server validation rejects unknown request IDs, self-links, repeated suggestions, oversized fields and evidence that is not an exact quote from the relevant input.

Evidence is checked unchanged first. If the model adds quotation marks around an excerpt, validation may remove exactly one matching pair of straight or curly single or double quotes, but only when the remaining text occurs exactly in the relevant request. Text already quoted in the original input is preserved. No fuzzy matching or punctuation correction is applied. These checks establish the response's structure and quote provenance; they do not prove that its interpretation is correct. A person reviews the reason and both quotes before linking requests.

Each run records its model, prompt version, candidate count, timing, status and validated result or safe failure message. Completed results are reused unless the user requests reanalysis. Human decisions are stored separately, so a new analysis cannot silently undo an accepted link. Reviews must refer to the latest completed analysis; removing an existing link checks the decision that created it.

Cost and concurrency limits apply across the local database: at most two analyses run at once and at most 20 new runs start in a rolling hour, including failed attempts. Calls have a 45-second timeout and are not automatically retried. A 75-second database lease releases abandoned runs after a server interruption; an expired run cannot overwrite a later result. SQLite transactions cover claiming work and recording outcomes, without holding a transaction open during the network call.

## Architecture and tradeoffs

- **Next.js App Router and React:** one application for the interface and HTTP endpoints.
- **TypeScript:** shared field and persistence types with strict checking.
- **SQLite through Node's built-in `node:sqlite`:** durable local storage without a separate service or a native npm database driver. SQL uses bound parameters. WAL mode and a busy timeout handle brief write contention.
- **A small storage module:** validation and persistence can be tested separately from React. The database connection is reused during development reloads and opened only when needed.
- **Uncached API reads:** refreshed pages see the current database contents. Submission is disabled until the initial list loads, avoiding a race between loading the board and adding a request.
- **Browser identity:** a persistent HttpOnly, SameSite=Lax cookie identifies the anonymous browser. The initial board load establishes it before support is enabled. Reads are private and uncached because support state differs by viewer.
- **Support integrity:** a separate table uses a composite primary key of request and supporter. Counts come from the table rather than a separately incremented counter. Explicit PUT and DELETE operations run in transactions and can be retried without adding a second support or accidentally reversing the intended action.
- **Search:** the current small list is filtered in the browser, so typing does not create additional network requests. A successful submission clears an active search so the new request is visible. Larger datasets will need pagination and server-side search.
- **AI provider:** native `fetch` calls the Responses API with a pinned model and a strict output contract. One bounded call is enough for the current task; provider errors stay separate from request storage and never produce fabricated results.
- **Human review:** suggestions and decisions are separate records. Canonical request pairs make links symmetric, while review events retain decision history.

Anonymous support is a demo tradeoff, not proof of a unique person. Clearing or changing cookies, using another browser profile, or switching between `localhost` and `127.0.0.1` creates a different identity. The cookie lasts one year and is scoped to the hostname. Keep using the same address for a consistent demo. Accounts and server-verified identity are needed for stronger duplicate and abuse protection. Cookies must be allowed for support to work.

This is a local assessment application, not a public multi-user service. SQLite queries are synchronous and the list is currently unpaginated, which is appropriate for this small local dataset. Before public deployment, add authentication, authorization, per-user abuse controls and an explicit backup/storage plan; revisit query concurrency and pagination as volume grows. The AI run limits are a local spending guard, not a substitute for access control. Mutation endpoints intentionally permit only same-origin loopback requests.

The form guards against repeated clicks, but an interrupted response can still make a save uncertain. It retains the draft and asks the user to check the board before retrying. Server-side idempotency would be the next safeguard for unreliable networks.

## API

| Endpoint | Result |
| --- | --- |
| `GET /api/requests` | `200` with `{ requests: [...] }`, newest first, and an anonymous identity cookie when needed |
| `POST /api/requests` | Accepts `{ title, description }`; returns `201` with `{ request: {...} }` |
| `PUT /api/requests/:id/support` | Adds support for the browser cookie identity; returns `200` with the updated request; repeated calls do not add another support |
| `DELETE /api/requests/:id/support` | Removes that browser's support; returns `200` with the updated request; repeated calls leave the count unchanged |
| `GET /api/analysis` | Returns AI availability, model, prompt version and the latest analysis and reviews for each request; never returns the key |
| `POST /api/requests/:id/analysis` | Accepts `{ force?: boolean }`; returns `200` with `{ intelligence: {...} }` for a completed or cached run, or `202` for an existing running analysis |
| `PUT /api/requests/:id/review` | Accepts `{ analysisId, relatedRequestId, decision: "accepted" \| "rejected" }`; records the human decision and returns updated intelligence |
| `DELETE /api/requests/:id/links/:relatedId` | Accepts `{ analysisId }` from the accepted link; removes that link even if a later analysis no longer suggests it |

Each request contains `id`, `title`, `description`, an ISO 8601 UTC `createdAt`, `supportCount` and `supportedByViewer`. Titles allow 1–120 characters and descriptions 1–4,000 after trimming (JavaScript string length). Creation bodies are limited to 32 KiB. Validation errors return `400` with field errors; unsupported content types return `415`, cross-origin writes `403`, oversized bodies `413`, and storage failures `503` with a user-facing message. Support endpoints return `400` for a missing or malformed identity cookie and `404` when the request does not exist. They never mint a new identity during a mutation.

Analysis, review and unlink mutations require the existing browser identity cookie and accept JSON bodies up to 2 KiB. Analysis returns `429` when a run limit is reached and `503` when AI is unavailable or fails. Expired runs and stale review or unlink decisions return `409`; missing source requests return `404`. Reads and mutation responses are private and uncached.

## Verification

```sh
npm test
npm run typecheck
npm run build
```

All 42 automated tests and the production build passed. Coverage includes request validation and persistence, search, cookie behavior, idempotent support, provider request configuration, malformed or fabricated AI output, verified quote-wrapper removal and preservation of original quoted text, safe failures, distinguishing quota exhaustion from temporary rate limits, cached and concurrent analyses, expired runs, review decisions and links retained through reanalysis. A support concurrency test launches four separate Node processes against the same request and identity and confirms a single support. Tests use isolated files in the ignored `.test-data` directory and mock the AI provider; they make no live API calls.

Manual browser checks covered empty submission, creating requests, refresh persistence, long-text expansion, narrow-screen layout, draft preservation during a stopped server, and recovery after restarting it. The saved records were compared before and after that restart and matched exactly. The production build also passed TypeScript checking.

Search/support browser checks covered description-only case-insensitive matching, no results and clearing, creating a request while filtered, adding and removing support, refresh and shared-cookie behavior across tabs, and retrying a failed support update after restarting the QA server. Counts changed only after a successful response. Desktop and narrow-screen layouts were inspected. The QA server used port 3100 and a separate database; the normal development command still uses port 3000.

Earlier controlled browser QA passed for automatic analysis after saving, pending and completed states, evidence expansion, linking from both requests, refresh persistence, navigation to a linked request, removal from the reverse side, reanalysis preserving accepted links, and persistent dismissal. A simulated provider rate-limit failure left the request saved, and a manual retry succeeded. The layout had no horizontal overflow at 390 pixels wide. These checks used explicit test fixtures in an isolated QA database; they tested application behavior, not live model quality. Fixtures are never used as a fallback in the application.

A separate live browser session used the production server on port 3112, an isolated database and the synthetic requests prepared for the Loom demonstration. Submitting the third request saved it successfully, but its first analysis attempt failed with a connection error. The Retry control produced a genuine model response identifying the weekly dashboard report as a duplicate; the keyboard-navigation request was absent from the suggestions. The evidence quotes were reviewed, the accepted link appeared on both requests, and the link and support count survived a reload. Removing the link from the reverse request and accepting it again also worked. This session used real provider responses throughout, with no mocked analysis output.

The normal application was checked separately without a key: the setup banner appeared, analysis controls stayed disabled, and saving, support and refresh persistence worked. Saving a request did not create an analysis run. TypeScript checking also passed after adding the live evaluation script.

### Live AI smoke check

Once a key is configured, run:

```sh
npm run eval:ai
```

This makes up to three billable live requests: two differently worded requests for the same need, an unrelated pair, and feedback containing an instruction to produce a false match. It checks the expected suggested IDs and relationship types and reports per-case timing. Account configuration failures stop the run early. The summary distinguishes completed evaluations, provider failures and skipped cases. These three cases are a smoke check, not a broad quality benchmark.

After the prompt and evidence-validation fix, the evaluator passed the unrelated-pair and embedded-instruction cases. The duplicate case encountered a connection reset, so that command reported two of two completed scenarios matching expectations and one failed call. A targeted rerun of the duplicate case returned the expected `schedule` request as a duplicate with verified evidence. All three expected outcomes were observed across separate runs; there has not been a single uninterrupted three-case pass. Intermittent network resets remain an observed limitation, with manual recovery also confirmed in the live browser session. Failed network calls do not assess the model's suggestions.

## Evaluating the product

The next validation step is to review a larger labeled set of real feedback with a product owner, including ambiguous requests and duplicates outside the current candidate window. Proposed success measures are:

- **Time to triage:** median time from opening an unreviewed request to recording a decision, compared with the same task without analysis.
- **Suggestion precision:** the share of reviewed suggestions judged correct by a product owner, checking duplicate and related suggestions separately and tracking later reversals.
- **Duplicate discovery:** the share of known duplicate pairs surfaced in a labeled dataset, including older requests to make the candidate-window limitation visible.

These product metrics have not been measured. The small smoke set is insufficient to estimate general model quality.

## Development record

CLAUDE.md contains the assessment's required prompt logging instruction. AGENTS.md applies that instruction to other coding assistants. prompts.txt records user instructions and brief summaries of the work performed.

Prompt logging was configured before application code. Earlier planning prompts are included as imported history with their recording time; their original timestamps are unavailable.
