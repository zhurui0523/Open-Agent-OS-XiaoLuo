import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchExternalEndpoint,
  modelAdapterProbeRequest,
  probeModelAdapter,
} from "../app/lib/model-adapters.ts";
import { resolveModelApiEndpoint } from "../app/lib/model-endpoints.ts";
import {
  modelResponseAssetUrl,
  modelResponseText,
} from "../app/lib/model-response.ts";

test("model endpoints are always called exactly as entered", () => {
  for (const endpoint of [
    "https://api.example.com/v1",
    "https://api.example.com/v1/chat/completions",
    "https://api.example.com/custom/image",
    "https://api.example.com/v1/images/generations/",
  ]) {
    assert.equal(resolveModelApiEndpoint(endpoint), endpoint);
  }
});

test("native Claude probe uses the Messages API format", async () => {
  const request = modelAdapterProbeRequest({
    protocol: "anthropic-compatible",
    baseUrl: "https://api.example.com/v1/messages",
    modelName: "claude-test",
    modalities: ["text"],
    credential: "secret",
  });

  assert.equal(request.url, "https://api.example.com/v1/messages");
  assert.equal(request.method, "POST");
  assert.equal(request.headers.get("anthropic-version"), "2023-06-01");
  assert.equal(request.headers.get("x-api-key"), "secret");
  assert.deepEqual(await request.json(), {
    model: "claude-test",
    max_tokens: 1,
    messages: [{ role: "user", content: "Hi" }],
  });
});

test("external model requests use manual redirect handling and reject redirects", async () => {
  const originalFetch = globalThis.fetch;
  let observedRedirect;
  globalThis.fetch = async (_url, init) => {
    observedRedirect = init?.redirect;
    return new Response(null, {
      status: 302,
      headers: { location: "https://redirect.example.com/target" },
    });
  };

  try {
    await assert.rejects(
      fetchExternalEndpoint("https://api.example.com/v1/messages"),
      /远程端点不允许重定向（HTTP 302）/,
    );
    assert.equal(observedRedirect, "manual");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI Responses probe uses the Responses API request format", async () => {
  const request = modelAdapterProbeRequest({
    protocol: "openai-responses",
    baseUrl: "https://api.example.com/v1/responses",
    modelName: "gpt-test",
    modalities: ["text"],
    credential: "secret",
  });

  assert.equal(request.url, "https://api.example.com/v1/responses");
  assert.equal(request.method, "POST");
  assert.equal(request.headers.get("authorization"), "Bearer secret");
  assert.deepEqual(await request.json(), {
    model: "gpt-test",
    input: "Hi",
    max_output_tokens: 1,
  });
});

test("OpenAI Responses output text is extracted from output message content", () => {
  assert.equal(
    modelResponseText({
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "Responses API 正常" }],
        },
      ],
    }),
    "Responses API 正常",
  );
});

test("DALL-E 3 probe accepts the full generation endpoint", async () => {
  const request = modelAdapterProbeRequest({
    protocol: "dall-e-3",
    baseUrl: "https://api.vectorengine.cn/v1/images/generations/",
    modelName: "dall-e-3",
    modalities: ["image"],
    credential: "secret",
  });

  assert.equal(
    request.url,
    "https://api.vectorengine.cn/v1/images/generations/",
  );
  assert.equal(request.method, "POST");
  assert.equal(request.headers.get("authorization"), "Bearer secret");
  assert.deepEqual(await request.json(), {
    model: "dall-e-3",
    prompt: "A simple white circle on a black background",
    n: 1,
    size: "1024x1024",
  });
});

test("probe failures preserve the provider HTTP status and message", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json(
      { message: "upstream model is temporarily unavailable" },
      { status: 503 },
    );

  try {
    const result = await probeModelAdapter({
      protocol: "dall-e-3",
      baseUrl: "https://api.example.com/v1/images/generations/",
      modelName: "gpt-image-1",
      modalities: ["image"],
      credential: "secret",
    });
    assert.equal(result.ok, false);
    assert.equal(
      result.message,
      "端点返回 HTTP 503：upstream model is temporarily unavailable",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("probe failures prefer the nested provider message over a generic outer error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json(
      {
        message: "openai_error",
        error: {
          message: "upstream image channel rejected the request",
          type: "openai_error",
          code: "unknown_error",
        },
      },
      { status: 514 },
    );

  try {
    const result = await probeModelAdapter({
      protocol: "dall-e-3",
      baseUrl: "https://api.example.com/v1/images/generations",
      modelName: "gpt-image-2",
      modalities: ["image"],
      credential: "secret",
    });
    assert.equal(result.ok, false);
    assert.equal(
      result.message,
      "端点返回 HTTP 514：upstream image channel rejected the request",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DALL-E compatible image model keeps a full chat endpoint and uses chat format", async () => {
  const request = modelAdapterProbeRequest({
    protocol: "dall-e-3",
    baseUrl: "https://api.example.com/v1/chat/completions",
    modelName: "gpt-image-chat",
    modalities: ["image"],
    credential: "secret",
  });

  assert.equal(request.url, "https://api.example.com/v1/chat/completions");
  assert.equal(request.method, "POST");
  assert.deepEqual(await request.json(), {
    model: "gpt-image-chat",
    messages: [
      {
        role: "user",
        content: "A simple white circle on a black background",
      },
    ],
  });
});

test("chat-style image responses expose nested image URLs to the canvas", () => {
  assert.equal(
    modelResponseAssetUrl({
      choices: [
        {
          message: {
            content: [
              {
                type: "image_url",
                image_url: { url: "https://cdn.example.com/result.png" },
              },
            ],
          },
        },
      ],
    }),
    "https://cdn.example.com/result.png",
  );
  assert.equal(
    modelResponseAssetUrl({
      choices: [
        {
          message: {
            content: "![result](https://cdn.example.com/result-2.png)",
          },
        },
      ],
    }),
    "https://cdn.example.com/result-2.png",
  );
});

test("external fetch failures are converted to a user-facing provider error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };

  try {
    await assert.rejects(
      fetchExternalEndpoint("https://api.example.com/v1/images/generations"),
      (error) => {
        assert.match(error.message, /无法连接远程模型服务（api\.example\.com）/);
        assert.doesNotMatch(error.message, /fetch failed/i);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("native Gemini probe uses the models endpoint and Bearer authentication", () => {
  const request = modelAdapterProbeRequest({
    protocol: "gemini",
    baseUrl: "https://api.example.com/v1beta/models",
    modelName: "gemini-test",
    modalities: ["text"],
    credential: "secret",
  });

  assert.equal(request.url, "https://api.example.com/v1beta/models");
  assert.equal(request.method, "GET");
  assert.equal(request.headers.get("authorization"), "Bearer secret");
  assert.equal(request.headers.get("x-goog-api-key"), null);
});

test("native Gemini image probe uses generateContent image format", async () => {
  const request = modelAdapterProbeRequest({
    protocol: "gemini",
    baseUrl:
      "https://api.vectorengine.cn/v1beta/models/gemini-3-pro-image-preview:generateContent",
    modelName: "gemini-3-pro-image-preview",
    modalities: ["image"],
    credential: "secret",
  });

  assert.equal(
    request.url,
    "https://api.vectorengine.cn/v1beta/models/gemini-3-pro-image-preview:generateContent",
  );
  assert.equal(request.method, "POST");
  assert.equal(request.headers.get("authorization"), "Bearer secret");
  assert.deepEqual(await request.json(), {
    contents: [
      { role: "user", parts: [{ text: "Draw a simple white circle" }] },
    ],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio: "1:1", imageSize: "1K" },
    },
  });
});

test("native Gemini output text is extracted from candidate parts", () => {
  assert.equal(
    modelResponseText({
      candidates: [
        {
          content: {
            parts: [{ text: "Gemini 原生接口正常" }],
          },
        },
      ],
    }),
    "Gemini 原生接口正常",
  );
});

for (const protocol of [
  "runninghub-sparkvideo-mini",
  "runninghub-sparkvideo-mini-multimodal",
  "runninghub-sparkvideo",
  "runninghub-sparkvideo-multimodal",
  "runninghub-minimax-h3",
]) {
  test(`${protocol} probe uses the non-generating RunningHub query endpoint`, async () => {
    const request = modelAdapterProbeRequest({
      protocol,
      baseUrl: "https://www.runninghub.cn/openapi/v2/rhart-video/example/image-to-video",
      modelName: "sparkvideo-test",
      modalities: ["video"],
      credential: "secret",
    });

    assert.equal(request.url, "https://www.runninghub.cn/openapi/v2/query");
    assert.equal(request.method, "POST");
    assert.equal(request.headers.get("authorization"), "Bearer secret");
    assert.deepEqual(await request.json(), { taskId: "0" });
  });
}
