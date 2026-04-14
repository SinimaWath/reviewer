import fs from "fs/promises";
import { Octokit } from "@octokit/rest";

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

async function resolveGroupRepositories(groupValue?: string) {
  if (!groupValue) return [];
  let rawList = groupValue.trim();

  if (!rawList) return [];

  try {
    const fileUrl = new URL(`./groups/${rawList}`, import.meta.url);
    rawList = await fs.readFile(fileUrl, "utf8");
  } catch {
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

function formatRuTimestamp(iso: string) {
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function getLatestSubmittedReviewByActor(
  reviews: Array<any>,
  actor: string
): any | null {
  const normalizedActor = actor.toLowerCase();
  const submittedReviews = reviews.filter((review: any) => {
    const reviewer = review.user?.login?.toLowerCase();
    const state = review.state?.toUpperCase();
    return (
      reviewer === normalizedActor &&
      state &&
      state !== "PENDING" &&
      state !== "DISMISSED"
    );
  });

  if (!submittedReviews.length) return null;

  return submittedReviews.reduce((latest: any, current: any) => {
    const latestTime = new Date(
      latest.submitted_at || latest.created_at || 0
    ).getTime();
    const currentTime = new Date(
      current.submitted_at || current.created_at || 0
    ).getTime();
    return currentTime > latestTime ? current : latest;
  });
}

type PrDisplayStatus = {
  label: string;
  emoji: string;
  atIso: string;
  showRunHint: boolean;
};

async function getPrStatusLine(
  octokit: Octokit,
  prUrl: string,
  actor: string | undefined
): Promise<PrDisplayStatus> {
  const { owner, repo, prNumber } = parsePrUrl(prUrl);
  const [{ data: pr }, reviews] = await Promise.all([
    octokit.pulls.get({ owner, repo, pull_number: prNumber }),
    octokit.paginate(octokit.pulls.listReviews, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    }),
  ]);

  const headSha = pr.head.sha;
  const updatedAt = pr.updated_at || pr.created_at || new Date().toISOString();

  const pending = (reviews as any[]).find(
    (review) => review.state?.toUpperCase() === "PENDING"
  );
  if (pending) {
    return {
      label: "Pending review",
      emoji: "⏳",
      atIso: pending.submitted_at || pending.created_at || updatedAt,
      showRunHint: false,
    };
  }

  if (!actor) {
    return {
      label: "Unknown reviewer (set GITHUB_ACTOR or fix token)",
      emoji: "⚠️",
      atIso: updatedAt,
      showRunHint: false,
    };
  }

  const latestReview = getLatestSubmittedReviewByActor(reviews as any[], actor);

  if (!latestReview) {
    return {
      label: "Not Reviewed",
      emoji: "👀",
      atIso: updatedAt,
      showRunHint: true,
    };
  }

  if (latestReview.commit_id && latestReview.commit_id !== headSha) {
    return {
      label: "Have updates",
      emoji: "🔄",
      atIso: updatedAt,
      showRunHint: true,
    };
  }

  const state = String(latestReview.state || "").toUpperCase();
  const reviewTime =
    latestReview.submitted_at || latestReview.created_at || updatedAt;

  if (state === "CHANGES_REQUESTED") {
    return {
      label: "Changes Requested",
      emoji: "🛠️",
      atIso: reviewTime,
      showRunHint: false,
    };
  }

  if (state === "APPROVED") {
    return {
      label: "Approved",
      emoji: "✅",
      atIso: reviewTime,
      showRunHint: false,
    };
  }

  return {
    label: "Reviewed",
    emoji: "📝",
    atIso: reviewTime,
    showRunHint: false,
  };
}

function reviewCommandSuffix(prUrl: string) {
  return `PR_URL=${prUrl} npm run r:kimi`;
}

async function runStatus() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("Missing GITHUB_TOKEN");

  const groupValue = process.env.GROUPS || process.env.GROUP;
  const singlePr = process.env.PR_URL?.trim();

  let prUrls: string[];
  if (singlePr && !groupValue) {
    prUrls = [singlePr];
  } else {
    const repositories = await resolveGroupRepositories(groupValue);
    if (!repositories.length) {
      console.log(
        "Provide GROUPS/GROUP (same as review batch) or PR_URL for a single PR."
      );
      return;
    }
    prUrls = await fetchGroupPullRequests(token, repositories);
    if (!prUrls.length) {
      console.log("No pull requests found for provided groups.");
      return;
    }
  }

  const octokit = new Octokit({ auth: token });
  const actor = await resolveActor(token);

  const sep = "-----";
  for (let i = 0; i < prUrls.length; i++) {
    const prUrl = prUrls[i];
    if (i > 0) console.log(sep);
    console.log(prUrl);
    try {
      const row = await getPrStatusLine(octokit, prUrl, actor);
      const ts = formatRuTimestamp(row.atIso);
      const base = `${row.emoji} ${row.label} ${ts}`;
      const hint =
        row.showRunHint &&
        (row.label === "Not Reviewed" || row.label === "Have updates")
          ? ` ${reviewCommandSuffix(prUrl)}`
          : "";
      console.log(`${base}${hint}`);
    } catch (err: any) {
      console.log(`⚠️ Failed to load status: ${err.message}`);
    }
  }
}

runStatus().catch((err) => {
  console.error("status failed:", err);
  process.exit(1);
});
