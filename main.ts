import fs from "fs/promises";
import { Octokit } from "@octokit/rest";
import { GitHubService, buildSnippets } from "./github.ts";
import { generatePrompt, loadContext } from "./prompt.ts";
import { ModelFactory } from "./provider.ts";
import { safeParseJson } from "./utils.ts";
import { CONFIG } from "./config.ts";

function parsePrUrl(prUrl: string) {
  const url = new URL(prUrl);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 4 || parts[2] !== "pull")
    throw new Error(`Invalid PR_URL format: ${prUrl}`);

  const prNumber = Number(parts[3]);
  if (!Number.isFinite(prNumber))
    throw new Error(`Invalid PR number in PR_URL: ${prUrl}`);

  return { owner: parts[0], repo: parts[1], prNumber };
}

async function loadPullRequest(token: string) {
  const octokit = new Octokit({ auth: token });
  const prUrl = process.env.PR_URL;

  if (prUrl) {
    const { owner, repo, prNumber } = parsePrUrl(prUrl);
    const { data: pr } = await octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });
    return { pr, owner, repo };
  }

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error(
      "Missing PR_URL or GITHUB_EVENT_PATH for pull request data"
    );
  }
  const payload = JSON.parse(await fs.readFile(eventPath, "utf8"));
  const pr = payload.pull_request;
  if (!pr) throw new Error("Not a pull_request event");

  const repoEnv = process.env.GITHUB_REPOSITORY;
  let owner = pr?.base?.repo?.owner?.login;
  let repo = pr?.base?.repo?.name;

  if (repoEnv) {
    [owner, repo] = repoEnv.split("/");
  }

  if (!owner || !repo)
    throw new Error("Missing repo owner/name in payload or GITHUB_REPOSITORY");

  return { pr, owner, repo };
}

export async function runReview() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("Missing GITHUB_TOKEN");

  const provider = (process.env.AI_PROVIDER || "gemini").toLowerCase();
  const modelName = ModelFactory.defaultModel(provider);
  const apiKey = ModelFactory.resolveApiKey(provider);
  if (!apiKey) throw new Error(`Missing API key for provider ${provider}`);

  const { pr, owner, repo } = await loadPullRequest(token);
  const context = {
    owner,
    repo,
    prNumber: pr.number,
    ref: pr.head.sha,
    actor: process.env.GITHUB_ACTOR,
    prAuthor: pr.user.login,
  };

  const gh = new GitHubService(token, context, Boolean(process.env.DRY_RUN));

  console.log(`Starting review for PR #${pr.number}`);
  const changedFiles = await gh.getChangedFiles();
  const moduleChangedFiles = changedFiles.filter((file) =>
    CONFIG.MODULE_REGEX.test((file.filename || "").split("/")[0] || "")
  );

  const ctxData = await loadContext(gh.octokit, context, moduleChangedFiles);
  if (!ctxData) {
    console.log("No relevant coursework files detected. Skipping.");
    return;
  }

  const fileContents = await gh.fetchAllFileContents(moduleChangedFiles);
  const snippets = await buildSnippets(
    gh.octokit,
    owner,
    repo,
    context.ref,
    moduleChangedFiles,
    fileContents
  );

  const prompt = await generatePrompt(
    ctxData.moduleInstructions,
    ctxData.taskInstructions,
    snippets,
    ctxData.taskSolutions
  );

  console.log(`Sending prompt to ${provider} (${modelName})...`);
  const model = ModelFactory.create(provider, apiKey, modelName);
  const responseText = await model.generate(prompt);

  const reviewData = safeParseJson(responseText);
  await gh.submitReview(reviewData, fileContents, moduleChangedFiles);
}

runReview().catch((err) => {
  console.error("Workflow Failed:", err);
  process.exit(1);
});
