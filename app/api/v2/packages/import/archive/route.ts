import { requireUser } from "../../../../../lib/auth";
import {
  PackageArchiveError,
  inspectPackageArchive,
} from "../../../../../lib/package-archive";
import {
  deletePackageArtifact,
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
    const inspection = await inspectPackageArchive(bytes);
    const manifest = parsePackagePayload(inspection.manifest);
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
      archiveSha256: inspection.archiveSha256,
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
      runtimePreparation = await prepareLocalIsolatedPackage({
        inspection,
        manifest,
        integritySha256: manifestIntegrity,
      });
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
      ...(inspection.signature
        ? { signature: inspection.signature }
        : {}),
      ...(inspection.publisherKeyId
        ? { publisherKeyId: inspection.publisherKeyId }
        : {}),
      source: {
        kind: "archive",
        artifactKey,
        archiveSha256: inspection.archiveSha256,
      },
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
          archiveSha256: inspection.archiveSha256,
          fileCount: inspection.files.length,
          checksumsVerified: inspection.checksumsVerified,
          runtimePreparation,
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
