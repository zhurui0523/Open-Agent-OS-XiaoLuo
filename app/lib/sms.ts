import type { PhoneChallengePurpose } from "./phone-auth";

interface SmsInput {
  phone: string;
  code: string;
  purpose: PhoneChallengePurpose;
}

function percentEncode(value: string) {
  return encodeURIComponent(value)
    .replaceAll("!", "%21")
    .replaceAll("'", "%27")
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll("*", "%2A");
}

async function hmacSha1Base64(value: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
  );
  let binary = "";
  signature.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function templateCode(purpose: PhoneChallengePurpose) {
  if (purpose === "password_reset") {
    return (
      process.env.ALIYUN_SMS_PASSWORD_RESET_TEMPLATE_CODE ??
      process.env.ALIYUN_SMS_TEMPLATE_CODE
    );
  }
  return (
    process.env.ALIYUN_SMS_REGISTER_TEMPLATE_CODE ??
    process.env.ALIYUN_SMS_TEMPLATE_CODE
  );
}

async function sendAliyunSms(input: SmsInput) {
  const accessKeyId = process.env.ALIYUN_SMS_ACCESS_KEY_ID?.trim();
  const accessKeySecret = process.env.ALIYUN_SMS_ACCESS_KEY_SECRET?.trim();
  const signName = process.env.ALIYUN_SMS_SIGN_NAME?.trim();
  const template = templateCode(input.purpose)?.trim();
  if (!accessKeyId || !accessKeySecret || !signName || !template) {
    throw new Error("阿里云短信配置不完整");
  }

  const parameters: Record<string, string> = {
    AccessKeyId: accessKeyId,
    Action: "SendSms",
    Format: "JSON",
    PhoneNumbers: input.phone.replace(/^\+86/, ""),
    RegionId: process.env.ALIYUN_SMS_REGION?.trim() || "cn-hangzhou",
    SignName: signName,
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: "1.0",
    TemplateCode: template,
    TemplateParam: JSON.stringify({ code: input.code }),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    Version: "2017-05-25",
  };
  const canonical = Object.entries(parameters)
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([key, value]) => `${percentEncode(key)}=${percentEncode(value)}`)
    .join("&");
  const stringToSign = `POST&%2F&${percentEncode(canonical)}`;
  parameters.Signature = await hmacSha1Base64(
    stringToSign,
    `${accessKeySecret}&`,
  );
  const response = await fetch("https://dysmsapi.aliyuncs.com/", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=utf-8",
    },
    body: new URLSearchParams(parameters),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    Code?: string;
    Message?: string;
  };
  if (!response.ok || payload.Code !== "OK") {
    throw new Error(payload.Message || "短信发送失败");
  }
}

export async function sendVerificationSms(input: SmsInput) {
  const provider =
    process.env.SMS_PROVIDER?.trim().toLowerCase() ||
    (process.env.NODE_ENV === "production" ? "aliyun" : "development");
  if (provider === "development") {
    if (process.env.NODE_ENV === "production") {
      throw new Error("生产环境禁止使用开发短信模式");
    }
    return { developmentCode: input.code };
  }
  if (provider !== "aliyun") {
    throw new Error(`不支持的短信服务商：${provider}`);
  }
  await sendAliyunSms(input);
  return {};
}

