import { jsonError, requireUser } from "../../../../lib/auth";
import {
  requestPhoneChallenge,
  type PhoneChallengePurpose,
} from "../../../../lib/phone-auth";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      phone?: string;
      purpose?: PhoneChallengePurpose;
    };
    const purpose = body.purpose;
    if (
      purpose !== "register" &&
      purpose !== "password_reset" &&
      purpose !== "phone_change"
    ) {
      return Response.json({ error: "验证码用途无效" }, { status: 400 });
    }
    if (purpose === "phone_change") await requireUser(request);
    const result = await requestPhoneChallenge({
      request,
      phone: body.phone ?? "",
      purpose,
    });
    return Response.json({
      message: "验证码已发送",
      ...result,
    });
  } catch (error) {
    return jsonError(error, "验证码发送失败");
  }
}

