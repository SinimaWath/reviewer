import {
  fetchGroupPullRequests,
  generateReviewDraft,
  resolveGroupRepositories,
} from "./review-core.ts";

export async function runReview(prUrl?: string) {
  if (!prUrl) throw new Error("Missing PR_URL");

  const prepared = await generateReviewDraft(prUrl);
  if (prepared.status === "skipped") {
    if (prepared.skipReason) console.log(prepared.skipReason);
    return;
  }

  const reviewData = prepared.reviewData!;
  console.log(reviewData);

  if (process.env.NO_SEND) {
    return;
  }

  await prepared.gitHubService!.submitReview(
    reviewData,
    prepared.fileContents!,
    prepared.changedFiles!
  );
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
