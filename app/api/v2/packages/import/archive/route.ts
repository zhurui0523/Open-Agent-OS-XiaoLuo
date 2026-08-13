import { requireUser } from "../../../../../lib/auth";
import {
  PackageArchiveError,
  inspectPackageArchive,
  inspectSourceArchive,
} from "../../../../../lib/package-archive";
import {
  buildGithubStaticPackage,
  deletePackageArtifact,
  generateSourcePackageManifest,
  packageArtifactKey,
  prepareLocalIsolatedPackage,
  storePackageArtifact,
} from "../../../../../lib/package-import";
import {
  ManifestValidationError,
  parsePackagePayload,
} from "../../../../../lib/package-contract";
import {
  canonicalPackageManifest,
  packageManifestSha256,
} from "../../../../../lib/package-trust";
import {
  needsDefaultSandboxPanel,
  needsHostedSandboxRuntime,
  packageManifestRecord,
  withDefaultSandboxPanel,
  withHostedSandboxRuntime,
} from "../../../../../lib/package-manifest-adapter";
import { requireRequestedWorkspace } from "../../../../../lib/workspace-context";
import { forwardImportedPackageInstall } from "../install";

function errorResponse(error: unknown) {
  if (error instanceof Response) return error;
  if (error instanceof PackageArchiveError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: 400 },
    );
  }
  if (error instanceof ManifestValidationError) {
    return Response.json(
      { error: "Package Manifest 校验失败", issues: error.issues },
      { status: 400 },
    );
  }
  return Response.json(
    {
      error:
        error instanceof Error ? error.message : "插件压缩包导入失败",
    },
    { status: 500 },
  );
}

export async function POST(request: Request) {
  let artifactKey = "";
  try {
    const user = await requireUser(request);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: "请选择插件压缩包" }, { status: 400 });
    }
    if (!/\.(xlpkg|zip)$/i.test(file.name)) {
      return Response.json(
        { error: "压缩包只支持 .xlpkg 或 .zip" },
        { status: 400 },
      );
    }
    if (!file.size || file.size > 50 * 1024 * 1024) {
      return Response.json(
        { error: "插件压缩包必须大于 0 B 且不能超过 50 MB" },
        { status: 400 },
      );
    }
    const requestedWorkspaceId =
      typeof form.get("workspaceId") === "string"
        ? String(form.get("workspaceId"))
        : "";
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "view",
      { workspaceId: requestedWorkspaceId },
    );
    const bytes = new Uint8Array(await file.arrayBuffer());
    let inspection: Awaited<ReturnType<typeof inspectPackageArchive>> | null =
      null;
    let sourceInspection: Awaited<ReturnType<typeof inspectSourceArchive>>;
    let generated:
      | Awaited<ReturnType<typeof generateSourcePackageManifest>>
      | null = null;
    let generatedBuild:
      | Awaited<ReturnType<typeof buildGithubStaticPackage>>
      | null = null;
    let manifestAdapted = false;
    try {
      inspection = await inspectPackageArchive(bytes);
      sourceInspection = inspection;
    } catch (error) {
      if (
        error instanceof PackageArchiveError &&
        error.code === "PACKAGE_MANIFEST_MISSING"
      ) {
        sourceInspection = await inspectSourceArchive(bytes);
        const sourceName = file.name
          .replace(/\.(?:xlpkg|zip)$/i, "")
          .replace(/[^\p{L}\p{N}._-]+/gu, "-")
          .replace(/^[._-]+|[._-]+$/g, "") || "uploaded-source";
        generated = await generateSourcePackageManifest({
          inspection: sourceInspection,
          owner: "upload",
          repository: sourceName,
          sourceUrl: `本地压缩包：${file.name.slice(0, 240)}`,
          commit: sourceInspection.archiveSha256,
          workspaceId,
        });
        if (
          !generated.executionReady &&
          generated.compatibility.projectType === "frontend"
        ) {
          generatedBuild = await buildGithubStaticPackage({
            inspection: sourceInspection,
            archiveSha256: sourceInspection.archiveSha256,
          });
          if (generatedBuild.prepared) {
            generated.executionReady = true;
            generated.staticRoot = "";
            generated.manifest.runtime = {
              type: "sandbox-ui",
              entry: `/api/v2/packages/runtime/static/${encodeURIComponent(workspaceId)}/${encodeURIComponent(generated.manifest.id)}/${encodeURIComponent(generated.manifest.version)}/${sourceInspection.archiveSha256}/_root/`,
            };
            generated.manifest.permissions = ["assets:read"];
            generated.manifest.contributes = {
              panels: [
                {
                  id: `${generated.manifest.id}.panel`,
                  title: generated.manifest.name,
                },
              ],
            };
          } else {
            generated.compatibility.issues.push(
              `自动构建失败：${generatedBuild.reason}`,
            );
          }
        }
      } else {
        throw error;
      }
    }
    let manifestPayload: unknown = generated?.manifest ?? inspection!.manifest;
    const addDefaultPanel = needsDefaultSandboxPanel(manifestPayload);
    if (addDefaultPanel || needsHostedSandboxRuntime(manifestPayload)) {
      if (!generatedBuild?.prepared) {
        generatedBuild = await buildGithubStaticPackage({
          inspection: sourceInspection,
          archiveSha256: sourceInspection.archiveSha256,
        });
      }
      if (!generatedBuild.prepared) {
        throw new PackageArchiveError(
          "FRONTEND_BUILD_FAILED",
          `普通前端项目自动适配失败：无法生成 dist/index.html（${generatedBuild.reason}）`,
        );
      }
      const candidate = packageManifestRecord(manifestPayload);
      const packageId =
        candidate && typeof candidate.id === "string"
          ? candidate.id.trim()
          : "";
      const packageVersion =
        candidate && typeof candidate.version === "string"
          ? candidate.version.trim()
          : "";
      const runtimeEntry = `/api/v2/packages/runtime/static/${encodeURIComponent(workspaceId)}/${encodeURIComponent(packageId)}/${encodeURIComponent(packageVersion)}/${sourceInspection.archiveSha256}/_root/`;
      manifestPayload = addDefaultPanel
        ? withDefaultSandboxPanel({ payload: manifestPayload, runtimeEntry })
        : withHostedSandboxRuntime({ payload: manifestPayload, runtimeEntry });
      manifestAdapted = true;
      if (generated) {
        generated.executionReady = true;
        generated.manifest = parsePackagePayload(manifestPayload);
      }
    }
    const manifest = parsePackagePayload(manifestPayload);
    const requestedAccess = String(form.get("accessScope") ?? "").trim();
    if (["personal", "marketplace"].includes(requestedAccess)) {
      manifest.access = {
        scope: requestedAccess as "personal" | "marketplace",
      };
    } else {
      return Response.json(
        { error: "请选择“私有”或“共享”可见范围" },
        { status: 400 },
      );
    }
    artifactKey = packageArtifactKey({
      workspaceId,
      packageKey: manifest.id,
      version: manifest.version,
      archiveSha256: sourceInspection.archiveSha256,
    });
    await storePackageArtifact({
      key: artifactKey,
      bytes,
      sourceKind: "archive",
    });
    const manifestIntegrity = packageManifestSha256(
      canonicalPackageManifest(manifest),
    );
    let runtimePreparation:
      | { prepared: boolean; reason: string }
      | undefined;
    try {
      runtimePreparation = generatedBuild?.prepared
        ? { prepared: true, reason: generatedBuild.reason }
        : inspection
          ? await prepareLocalIsolatedPackage({
              inspection,
              manifest,
              integritySha256: manifestIntegrity,
            })
          : {
              prepared: generated?.executionReady === true,
              reason: generated?.executionReady
                ? "auto-adapter-ready"
                : "source-imported-runtime-configuration-required",
            };
    } catch (error) {
      runtimePreparation = {
        prepared: false,
        reason:
          error instanceof Error
            ? error.message
            : "隔离运行目录准备失败",
      };
    }
    const installed = await forwardImportedPackageInstall(request, {
      workspaceId,
      manifest,
      ...(inspection?.signature && !manifestAdapted
        ? { signature: inspection.signature }
        : {}),
      ...(inspection?.publisherKeyId && !manifestAdapted
        ? { publisherKeyId: inspection.publisherKeyId }
        : {}),
      source: {
        kind: "archive",
        artifactKey,
        archiveSha256: sourceInspection.archiveSha256,
        generatedManifest: Boolean(generated) || manifestAdapted,
        executionReady: generated?.executionReady ?? true,
      },
      authenticatedUser: user,
    });
    if (!installed.response.ok) {
      await deletePackageArtifact(artifactKey).catch(() => undefined);
      return Response.json(installed.payload, {
        status: installed.response.status,
      });
    }
    return Response.json(
      {
        ...installed.payload,
        status: "installed",
        source: {
          kind: "archive",
          fileName: file.name.slice(0, 240),
          archiveSha256: sourceInspection.archiveSha256,
          fileCount: sourceInspection.files.length,
          checksumsVerified: inspection?.checksumsVerified ?? false,
          runtimePreparation,
          generatedManifest: Boolean(generated) || manifestAdapted,
          executionReady: generated?.executionReady ?? true,
          ...(generated
            ? { compatibility: generated.compatibility }
            : {}),
        },
      },
      { status: installed.response.status },
    );
  } catch (error) {
    if (artifactKey) {
      await deletePackageArtifact(artifactKey).catch(() => undefined);
    }
    return errorResponse(error);
  }
}
