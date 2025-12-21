# LearnJS AI Reviewer

LLM-based reviewer for the `tasks-js` coursework. It pulls PR changes, adds module/task context plus reference solutions from `SinimaWath/tasks-js-3`, asks an AI model to produce structured feedback, and submits a GitHub review.

## Prerequisites
- Node.js 18+ (ES modules, fetch in Node, top-level await compat).
- Install deps: `npm install`.

## Environment
**Core**
- `GITHUB_TOKEN` (required): token with PR read/write permissions.
- `PR_URL` (required for single-run): full pull request URL, e.g. `https://github.com/org/repo/pull/123`.
- `GROUPS` or `GROUP` (optional, batch mode): comma-separated repo list (`org/repo,org/repo2`) or filename under `groups/` (e.g. `20251205`). Fetches latest open PRs from those repos and reviews each.
- `BYPASS` (optional): skip "pending review / no new commits" guard.
- `DRY_RUN` (optional): log generated review instead of posting to GitHub.
- `NO_SEND` (optional): stop after model response; no submission.
- `GITHUB_ACTOR` (optional): reviewer login; otherwise resolved from token.

**Provider selection**
- `AI_PROVIDER` (optional): `gemini` (default), `openai`, or `nebius`.
- `AI_MODEL_NAME` (optional): force model name for any provider.
- `AI_API_KEY` (optional): overrides provider-specific keys.

**Gemini (default)**
- `GEMINI_API_KEY` or `GOOGLE_API_KEY` (required when using Gemini).

**OpenAI-compatible**
- `OPENAI_API_KEY` (required when `AI_PROVIDER=openai`).
- `OPENAI_MODEL` (optional): defaults to `gpt-4o-mini`.
- `OPENAI_BASE_URL` (optional): defaults to `https://api.openai.com/v1`.

**Nebius (OpenAI-compatible)**
- `NEBIUS_API_KEY` (required when `AI_PROVIDER=nebius`).
- `NEBIUS_MODEL` (optional): defaults to `Qwen/Qwen3-Coder-480B-A35B-Instruct` in the helper script or falls back to `OPENAI_MODEL`/`gpt-4o-mini`.
- `NEBIUS_BASE_URL` (optional): defaults to `https://api.studio.nebius.ai/v1`.

## Scripts
- `npm run review` — run with defaults (Gemini `gemini-2.5-flash`).
- `npm run r:g-flash` / `npm run r:g-pro` / `npm run r:g3-pro` — Gemini with preset model names.
- `npm run r:qwen` / `npm run r:kimi` — Nebius provider with preset models.

## Usage
- Single PR (Gemini default):
  ```bash
  GITHUB_TOKEN=ghp_xxx GEMINI_API_KEY=ai_xxx \
  PR_URL=https://github.com/org/repo/pull/123 \
  npm run review
  ```
- OpenAI-compatible:
  ```bash
  GITHUB_TOKEN=ghp_xxx OPENAI_API_KEY=sk-xxx \
  AI_PROVIDER=openai PR_URL=https://github.com/org/repo/pull/123 \
  npm run review
  ```
- Nebius helper script:
  ```bash
  GITHUB_TOKEN=ghp_xxx NEBIUS_API_KEY=nb-xxx \
  PR_URL=https://github.com/org/repo/pull/123 \
  npm run r:qwen
  ```
- Batch by group file:
  ```bash
  GITHUB_TOKEN=ghp_xxx GEMINI_API_KEY=ai_xxx \
  GROUPS=20251205 npm run review
  ```
  (uses `groups/20251205` list, grabs latest open PRs per repo).
- Preview only:
  ```bash
  DRY_RUN=1 GITHUB_TOKEN=ghp_xxx GEMINI_API_KEY=ai_xxx \
  PR_URL=https://github.com/org/repo/pull/123 \
  npm run review
  ```

## How it builds the prompt
- Coursework scope from `instructions/modules.md` (modules up to the highest touched one).
- Task descriptions from each touched `*/README.md` in the student repo.
- Reference solutions from `SinimaWath/tasks-js-3` under the matching `*/solution` folder.
- Diff snippets of changed lines with padding (`CONFIG.CONTEXT_PADDING`) limited to `CONFIG.MAX_LINES_PER_FILE`.
- System + student templates from `instructions/rules/system.md` and `instructions/rules/student.md`.

## Notes
- Reviews are posted as GitHub PR reviews unless `DRY_RUN` or `NO_SEND` is set.
- Pending reviews on the same PR or unchanged commits are skipped unless `BYPASS` is set.
- Adjust model defaults or context behavior in `config.ts`, `prompt.ts`, and `github.ts` if needed.
