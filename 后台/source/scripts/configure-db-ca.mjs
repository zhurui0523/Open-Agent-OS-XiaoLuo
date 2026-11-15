import { createHash, X509Certificate } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

const certificatePath = process.argv[2];
if (!certificatePath) {
  throw new Error(
    "Usage: node scripts/configure-db-ca.mjs <ApsaraDB-CA-Chain.pem> [CA common name]",
  );
}

const pem = await readFile(certificatePath, "utf8");
const blocks =
  pem.match(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
  ) ?? [];
if (blocks.length === 0) {
  throw new Error("The selected file is not a PEM certificate chain");
}

const requestedCommonName = process.argv[3]?.trim();
let selectedBlocks = blocks;
if (requestedCommonName) {
  const certificates = blocks.map((block) => ({
    block,
    certificate: new X509Certificate(block),
  }));
  const leafCa = certificates.find(({ certificate }) =>
    certificate.subject
      .split(/\r?\n/)
      .some((part) => part === `CN=${requestedCommonName}`),
  );
  if (!leafCa) {
    throw new Error(`CA not found in chain: ${requestedCommonName}`);
  }
  const rootCa = certificates.find(
    ({ certificate }) =>
      certificate.subject === leafCa.certificate.issuer &&
      leafCa.certificate.verify(certificate.publicKey),
  );
  selectedBlocks = [rootCa?.block ?? leafCa.block];
}

const selectedPem = `${selectedBlocks.join("\n")}\n`;
const envPath = ".env.local";
const encoded = Buffer.from(selectedPem, "utf8").toString("base64");
const current = await readFile(envPath, "utf8");
const line = `DB_SSL_CA_BASE64=${encoded}`;
const withCa = /^DB_SSL_CA_BASE64=.*$/m.test(current)
  ? current.replace(/^DB_SSL_CA_BASE64=.*$/m, line)
  : `${current.trimEnd()}\n${line}\n`;
const next = withCa.replace(/^DB_SSL_CA_RUNTIME=.*\r?\n?/m, "");
await writeFile(envPath, next, "utf8");

const sha256 = createHash("sha256").update(selectedPem).digest("hex");
console.log(
  `Configured ${selectedBlocks.length} of ${blocks.length} CA certificates in ${envPath} (sha256 ${sha256}).`,
);
