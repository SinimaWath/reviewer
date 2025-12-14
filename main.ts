import fs from "fs/promises";
import { Octokit } from "@octokit/rest";
import { GitHubService, buildSnippets } from "./github.ts";
import { generatePrompt, loadContext } from "./prompt.ts";
import { ModelFactory } from "./provider.ts";
import { safeParseJson } from "./utils.ts";
import { CONFIG } from "./config.ts";
import { reviewSchema } from "./scheme.ts";

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

function parseRepoUrl(repoUrl: string) {
  const cleaned = repoUrl.trim().replace(/\.git$/, "");
  if (!cleaned) throw new Error("Empty repository url");

  if (!cleaned.startsWith("http")) {
    const [owner, repo] = cleaned.split("/").filter(Boolean);
    if (!owner || !repo) throw new Error(`Invalid repo format: ${repoUrl}`);
    return { owner, repo };
  }

  const url = new URL(cleaned);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error(`Invalid repository url: ${repoUrl}`);

  return { owner: parts[0], repo: parts[1] };
}

async function resolveActor(token: string) {
  if (process.env.GITHUB_ACTOR) return process.env.GITHUB_ACTOR;
  try {
    const octokit = new Octokit({ auth: token });
    const { data } = await octokit.users.getAuthenticated();
    return data.login;
  } catch (err: any) {
    console.warn("Could not resolve actor from token:", err.message);
    return undefined;
  }
}

async function loadPullRequest(token: string, prUrl: string) {
  const octokit = new Octokit({ auth: token });

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

async function resolveGroupRepositories(groupValue?: string) {
  if (!groupValue) return [];
  let rawList = groupValue.trim();

  if (!rawList) return [];

  try {
    const fileUrl = new URL(`./groups/${rawList}`, import.meta.url);
    rawList = await fs.readFile(fileUrl, "utf8");
  } catch (e) {
    // Treat provided value as list if file doesn't exist.
  }

  return rawList
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function fetchGroupPullRequests(token: string, repositories: string[]) {
  if (repositories.length === 0) return [];

  const octokit = new Octokit({ auth: token });
  const prUrls: string[] = [];

  for (const repoUrl of repositories) {
    try {
      const { owner, repo } = parseRepoUrl(repoUrl);
      const { data } = await octokit.pulls.list({
        owner,
        repo,
        state: "open",
        sort: "updated",
        direction: "desc",
        per_page: 10,
      });

      if (!data.length) {
        console.log(`No open PRs found for ${owner}/${repo}, skipping.`);
        continue;
      }

      prUrls.push(...data.map((v) => v.html_url));
    } catch (err: any) {
      console.warn(`Failed to fetch PRs for ${repoUrl}: ${err.message}`);
    }
  }

  return prUrls;
}

export async function runReview(prUrl?: string) {
  if (!prUrl) {
    throw new Error(prUrl);
  }
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("Missing GITHUB_TOKEN");

  const provider = (process.env.AI_PROVIDER || "gemini").toLowerCase();
  const modelName = ModelFactory.defaultModel(provider);
  const apiKey = ModelFactory.resolveApiKey(provider);
  if (!apiKey) throw new Error(`Missing API key for provider ${provider}`);

  const { pr, owner, repo } = await loadPullRequest(token, prUrl);
  const actor = await resolveActor(token);
  const context = {
    owner,
    repo,
    prNumber: pr.number,
    ref: pr.head.sha,
    actor,
    prAuthor: pr.user.login,
  };

  const gh = new GitHubService(token, context, Boolean(process.env.DRY_RUN));

  console.log(`Starting review for PR #${pr.number}, url: ${prUrl}`);

  const skipReason = await gh.getReviewSkipReason(context.actor);
  if (skipReason) {
    console.log(skipReason);
    return;
  }

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

  console.log(
    `Sending prompt (${prompt.length}) to ${provider} (${modelName})....`
  );
  const model = ModelFactory.create(provider, apiKey, modelName);

  const responseText = await model.generate(prompt, reviewSchema);

  const reviewData = safeParseJson(responseText);

  console.log(reviewData);

  await gh.submitReview(reviewData, fileContents, moduleChangedFiles);
}

async function main() {
  const groupValue = process.env.GROUPS || process.env.GROUP;
  if (!groupValue) {
    await runReview(process.env.PR_URL);
    return;
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("Missing GITHUB_TOKEN");

  const repositories = await resolveGroupRepositories(groupValue);
  if (!repositories.length) {
    console.log("Group list is empty. Skipping.");
    return;
  }

  const prUrls = await fetchGroupPullRequests(token, repositories);
  if (!prUrls.length) {
    console.log("No pull requests found for provided groups.");
    return;
  }

  console.log(prUrls);

  for (const prUrl of prUrls) {
    try {
      await runReview(prUrl);
    } catch (_) {}
  }
}

main().catch((err) => {
  console.error("Workflow Failed:", err);
  process.exit(1);
});
