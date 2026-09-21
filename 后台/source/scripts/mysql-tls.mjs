function decodeCaBase64(value, name) {
  const encoded = value?.trim();
  if (!encoded) return undefined;
  if (!/^[A-Za-z0-9+/=]+$/.test(encoded)) {
    throw new Error(`${name} is not valid Base64`);
  }
  const pem = Buffer.from(encoded, "base64").toString("utf8");
  if (
    !pem.includes("-----BEGIN CERTIFICATE-----") ||
    !pem.includes("-----END CERTIFICATE-----")
  ) {
    throw new Error(`${name} does not contain a PEM certificate chain`);
  }
  return pem;
}

export function mysqlSslOptions(prefix = "DB") {
  const mode = process.env[`${prefix}_SSL_MODE`];
  if (mode === "disabled") return undefined;
  const caName = `${prefix}_SSL_CA_BASE64`;
  const ca = decodeCaBase64(process.env[caName], caName);
  return {
    rejectUnauthorized: mode === "required",
    ...(ca ? { ca } : {}),
  };
}
