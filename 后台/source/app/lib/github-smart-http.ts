const COMMIT_SHA = /^[a-f0-9]{40}$/i;

interface GitAdvertisedRef {
  sha: string;
  name: string;
}

function advertisedRefs(advertisement: string): GitAdvertisedRef[] {
  return [...advertisement.matchAll(/([a-f0-9]{40}) ([^\0\n]+)/gi)].map(
    (match) => ({
      sha: match[1].toLowerCase(),
      name: match[2].trim(),
    }),
  );
}

/**
 * Resolve an immutable commit from Git's upload-pack advertisement.
 * This keeps public GitHub imports working when api.github.com is unavailable.
 */
export function resolveAdvertisedGithubCommit(
  advertisement: string,
  requestedRef?: string,
) {
  const ref = requestedRef?.trim() || "";
  if (ref && COMMIT_SHA.test(ref)) return ref.toLowerCase();

  const refs = advertisedRefs(advertisement);
  const candidateNames = ref
    ? [
        `refs/heads/${ref}`,
        `refs/tags/${ref}^{}`,
        `refs/tags/${ref}`,
        ref,
      ]
    : ["HEAD"];
  for (const name of candidateNames) {
    const match = refs.find((entry) => entry.name === name);
    if (match) return match.sha;
  }

  throw new Error(
    ref
      ? `GitHub 没有找到分支、标签或 Commit：${ref}`
      : "GitHub 没有返回有效的默认分支 Commit",
  );
}
