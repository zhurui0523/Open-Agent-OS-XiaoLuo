import { installPackage as installPackageManifest } from "../route";
import type { AuthUser } from "../../../../lib/auth";

export interface ImportedPackageSource {
  kind: "archive" | "github";
  artifactKey: string;
  archiveSha256: string;
  repository?: string;
  commit?: string;
  generatedManifest?: boolean;
  executionReady?: boolean;
}

export async function forwardImportedPackageInstall(
  request: Request,
  input: {
    workspaceId: string;
    manifest: unknown;
    signature?: string;
    publisherKeyId?: string;
    source: ImportedPackageSource;
    authenticatedUser?: AuthUser;
  },
) {
  const headers = new Headers({ "content-type": "application/json" });
  for (const name of [
    "cookie",
    "authorization",
    "x-request-id",
    "x-forwarded-for",
    "user-agent",
  ]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const response = await installPackageManifest(
    new Request(new URL("/api/v2/packages", request.url), {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    }),
    {
      allowUnsignedGithubImport: input.source.kind === "github",
      authenticatedUser: input.authenticatedUser,
      ...(input.authenticatedUser
        ? { authorizedWorkspaceId: input.workspaceId }
        : {}),
    },
  );
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  return { response, payload };
}
