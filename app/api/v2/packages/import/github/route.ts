import { requireUser } from "../../../../../lib/auth";
import {
  PackageArchiveError,
  inspectPackageArchive,
  inspectSourceArchive,
} from "../../../../../lib/package-archive";
import {
  buildGithubStaticPackage,
  deletePackageArtifact,
  downloadGithubPackage,
  generateGithubPackageManifest,
  GithubImportNetworkError,
  packageArtifactKey,
  parseGithubRepositoryUrl,
  prepareLocalIsolatedPackage,
  storePackageArtifact,
} from "../../../../../lib/package-import";
import {
  ManifestValidationError,
  parsePackagePayload,
} from "../../../../../lib/package-contract";
import {
  needsHostedSandboxRuntime,
  needsDefaultSandboxPanel,
  packageManifestRecord,
  withDefaultSandboxPanel,
  withHostedSandboxRuntime,
} from "../../../../../lib/package-manifest-adapter";
import {
  canonicalPackageManifest,
  packageManifestSha256,
} from "../../../../../lib/package-trust";
import { requireRequestedWorkspace } from "../../../../../lib/workspace-context";
import { forwardImportedPackageInstall } from "../install";

function errorResponse(error: unknown) {
  if (error instanceof Response) return error;
  if (error instanceof GithubImportNetworkError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: 502 },
    );
  }
  if (error instanceof ManifestValidationError) {
    return Response.json(
      { error: "Package Manifest 校验失败", issues: error.issues },
      { status: 400 },
    );
  }
  if (error instanceof PackageArchiveError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: 400 },
    );
  }
  return Response.json(
    {
      error: error instanceof Error ? error.message : "GitHub 插件导入失败",
    },
    { status: 500 },
  );
}

export async function POST(request: Request) {
  let artifactKey = "";
  try {
    const user = await requireUser(request);
    const body = (await request.json()) as {
      workspaceId?: string;
      url?: string;
      ref?: string;
      accessScope?: string;
    };
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "view",
      body,
    );
    const reference = parseGithubRepositoryUrl(body.url ?? "", body.ref);
    const download = await downloadGithubPackage(reference);
    let inspection: Awaited<ReturnType<typeof inspectPackageArchive>> | null =
      null;
    let sourceInspection: Awaited<
      ReturnType<typeof inspectSourceArchive>
    > | null = null;
    let generated:
      | Awaited<ReturnType<typeof generateGithubPackageManifest>>
      | null = null;
    let generatedBuild:
      | Awaited<ReturnType<typeof buildGithubStaticPackage>>
      | null = null;
    let manifestAdapted = false;
    try {
      inspection = await inspectPackageArchive(download.bytes);
      sourceInspection = inspection;
    } catch (error) {
      if (
        error instanceof PackageArchiveError &&
        error.code === "PACKAGE_MANIFEST_MISSING"
      ) {
        sourceInspection = await inspectSourceArchive(download.bytes);
        generated = await generateGithubPackageManifest({
          inspection: sourceInspection,
          owner: reference.owner,
          repository: reference.repository,
          repositoryUrl: download.repositoryUrl,
          commit: download.commit,
          workspaceId,
        });
        if (
          !generated.executionReady &&
          generated.compatibility.projectType === "frontend"
        ) {
          const build = await buildGithubStaticPackage({
            inspection: sourceInspection,
            archiveSha256: sourceInspection.archiveSha256,
          });
          generatedBuild = build;
          if (build.prepared) {
            generated.executionReady = true;
            generated.staticRoot = "";
            generated.manifest.runtime = {
              type: "sandbox-ui",
              entry: `/api/v2/packages/runtime/static/${encodeURIComponent(workspaceId)}/${encodeURIComponent(generated.manifest.id)}/${encodeURIComponent(generated.manifest.version)}/${sourceInspection.archiveSha256}/_root/`,
            };
            generated.manifest.description = `从 ${download.repositoryUrl} 自动构建的静态沙箱插件，固定 Commit ${download.commit.slice(0, 12)}。`;
          } else {
            generated.compatibility.issues.push(`自动构建失败：${build.reason}`);
          }
        }
      } else {
        throw error;
      }
    }
    if (!sourceInspection) {
      throw new Error("GitHub 源码包分析失败");
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
    const requestedAccess = body.accessScope?.trim() ?? "";
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
      bytes: download.bytes,
      sourceKind: "github",
      repository: download.repositoryUrl,
      commit: download.commit,
    });
    const manifestIntegrity = packageManifestSha256(
      canonicalPackageManifest(manifest),
    );
    let runtimePreparation:
      | { prepared: boolean; reason: string }
      | undefined;
    try {
      runtimePreparation = generatedBuild?.prepared
        ? {
            prepared: true,
            reason: manifestAdapted
              ? "vite-build-complete-default-panel-adapted"
              : generatedBuild.reason,
          }
        : inspection
          ? await prepareLocalIsolatedPackage({
            inspection,
            manifest,
            integritySha256: manifestIntegrity,
          })
          : {
              prepared: generated?.executionReady === true,
              reason: generated?.executionReady
                ? "static-sandbox-ready"
                : "source-imported-build-required",
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
        kind: "github",
        artifactKey,
        archiveSha256: sourceInspection.archiveSha256,
        repository: download.repositoryUrl,
        commit: download.commit,
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
          kind: "github",
          repository: download.repositoryUrl,
          commit: download.commit,
          sourceKind: download.sourceKind,
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
