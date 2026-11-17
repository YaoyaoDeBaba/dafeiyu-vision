// src/http/guards.ts
var LOOPBACK_HOSTS = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
var HOST_ORIGIN_SCHEMES = /* @__PURE__ */ new Set(["dsh-app:"]);
function hostnameOf(host) {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end === -1) return trimmed;
    const rest = trimmed.slice(end + 1);
    if (rest !== "" && !/^:\d+$/.test(rest)) return trimmed;
    return trimmed.slice(0, end + 1);
  }
  const colon = trimmed.lastIndexOf(":");
  if (colon !== -1 && !trimmed.slice(0, colon).includes(":") && /^\d+$/.test(trimmed.slice(colon + 1))) {
    return trimmed.slice(0, colon);
  }
  return trimmed;
}
function hostIsLoopback(host) {
  if (host === void 0 || host.trim() === "") return false;
  return LOOPBACK_HOSTS.has(hostnameOf(host));
}
function originIsLoopbackOrAbsent(origin) {
  if (origin === void 0 || origin.trim() === "") return true;
  return originLooksLikeTheHostItself(origin);
}
function originLooksLikeTheHostItself(origin) {
  try {
    const url = new URL(origin);
    if (HOST_ORIGIN_SCHEMES.has(url.protocol)) return true;
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}
function applyCors(request, response) {
  const origin = request?.headers?.origin;
  if (origin === void 0 || origin.trim() === "" || !originLooksLikeTheHostItself(origin)) return;
  if (typeof response.setHeader !== "function") return;
  try {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, HEAD, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "content-type, x-drc-pair");
    response.setHeader("Access-Control-Max-Age", "600");
  } catch {
  }
}
function preflight(request, response) {
  if (request.method !== "OPTIONS") return false;
  applyCors(request, response);
  response.writeHead(204, { "Access-Control-Max-Age": "600", "Content-Length": "0" });
  response.end();
  return true;
}

// src/vision/config.ts
function isWebProtocol(protocol) {
  return protocol === "web-doubao" || protocol === "web-gemini";
}
function webSiteOf(protocol) {
  return protocol === "web-doubao" ? "doubao" : "gemini";
}
var DEFAULT_VISION_PROMPT = "\u4F60\u662F\u4E00\u540D\u4E13\u4E1A\u7684\u56FE\u50CF\u8BC6\u522B\u52A9\u624B\u3002\u8BF7\u4ED4\u7EC6\u89C2\u5BDF\u7528\u6237\u63D0\u4F9B\u7684\u56FE\u7247\uFF0C\u7528\u4E2D\u6587\u7ED9\u51FA\u8BE6\u7EC6\u3001\u7ED3\u6784\u5316\u7684\u63CF\u8FF0\uFF1A\u2460 \u6574\u4F53\u662F\u4EC0\u4E48\uFF08\u622A\u56FE/\u7167\u7247/\u56FE\u8868/UI \u754C\u9762\u7B49\uFF09\uFF1B\u2461 \u5173\u952E\u5185\u5BB9\u4E0E\u5E03\u5C40\uFF1B\u2462 \u56FE\u4E2D\u6240\u6709\u53EF\u89C1\u6587\u5B57\u9010\u5B57\u8F6C\u5F55\uFF08\u4EE3\u7801\u3001\u62A5\u9519\u3001\u6309\u94AE\u6587\u6848\u90FD\u4E0D\u8981\u6F0F\uFF09\uFF1B\u2463 \u5982\u679C\u8FD9\u662F\u5C4F\u5E55\u622A\u56FE\uFF0C\u91CD\u70B9\u63CF\u8FF0\u754C\u9762\u4E0A\u7684\u62A5\u9519\u3001\u5F39\u7A97\u3001\u6309\u94AE\u72B6\u6001\u3002";
var DEFAULT_VISION_CONFIG = {
  enabled: false,
  apiBase: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
  protocol: "auto",
  prompt: DEFAULT_VISION_PROMPT,
  timeoutMs: 6e4,
  requestTemplate: "",
  responsePath: "",
  webHeadless: true
};
function redactKey(key) {
  const value = String(key ?? "");
  if (value === "") return "";
  if (value.length <= 8) return "********";
  return `${value.slice(0, 3)}\u2026${value.slice(-4)}`;
}
function toView(config) {
  return {
    enabled: config.enabled,
    apiBase: config.apiBase,
    model: config.model,
    protocol: config.protocol,
    prompt: config.prompt,
    timeoutMs: config.timeoutMs,
    requestTemplate: config.requestTemplate,
    responsePath: config.responsePath,
    webHeadless: config.webHeadless,
    apiKeySet: config.apiKey !== "",
    apiKeyHint: redactKey(config.apiKey)
  };
}
var PROTOCOLS = [
  "auto",
  "openai-chat",
  "openai-responses",
  "anthropic",
  "gemini",
  "custom",
  "web-doubao",
  "web-gemini"
];
function cleanString(value, fallback, max) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}
function normalizeVisionConfig(input, base = DEFAULT_VISION_CONFIG) {
  const raw = input && typeof input === "object" ? input : {};
  const protocol = typeof raw.protocol === "string" && PROTOCOLS.includes(raw.protocol) ? raw.protocol : base.protocol;
  const timeout = typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs) ? Math.min(Math.max(Math.round(raw.timeoutMs), 5e3), 3e5) : base.timeoutMs;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : base.enabled,
    apiBase: cleanString(raw.apiBase, base.apiBase, 500) || base.apiBase,
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey.trim().slice(0, 500) : base.apiKey,
    model: cleanString(raw.model, base.model, 200) || base.model,
    protocol,
    prompt: cleanString(raw.prompt, base.prompt, 4e3) || base.prompt,
    timeoutMs: timeout,
    requestTemplate: cleanString(raw.requestTemplate, base.requestTemplate, 8e3),
    responsePath: cleanString(raw.responsePath, base.responsePath, 200),
    webHeadless: typeof raw.webHeadless === "boolean" ? raw.webHeadless : base.webHeadless
  };
}
function detectProtocol(apiBase) {
  const lower = String(apiBase ?? "").toLowerCase();
  if (lower.includes("anthropic")) return "anthropic";
  if (lower.includes("generativelanguage") || lower.includes("googleapis") || lower.includes("gemini")) return "gemini";
  if (lower.includes("/responses")) return "openai-responses";
  return "openai-chat";
}
function resolveProtocol(config) {
  return config.protocol === "auto" ? detectProtocol(config.apiBase) : config.protocol;
}

// src/vision/protocols.ts
var VisionError = class extends Error {
  status;
  constructor(message, status = 0) {
    super(message);
    this.name = "VisionError";
    this.status = status;
  }
};
function trimBase(base) {
  return String(base ?? "").replace(/\/+$/, "");
}
function promptOf(config, image) {
  const custom = typeof image.prompt === "string" ? image.prompt.trim() : "";
  return custom !== "" ? custom : config.prompt;
}
function deepGet(value, path8) {
  let cursor = value;
  for (const key of path8) {
    if (cursor === null || typeof cursor !== "object") return void 0;
    cursor = cursor[key];
  }
  return cursor;
}
function splitPath(path8) {
  return String(path8 ?? "").split(".").map((segment) => segment.trim()).filter((segment) => segment !== "");
}
function textFrom(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    const parts = [];
    for (const item of value) {
      if (typeof item === "string") {
        parts.push(item);
      } else if (item && typeof item === "object") {
        const text = item.text;
        if (typeof text === "string") parts.push(text);
      }
    }
    return parts.join("\n").trim();
  }
  return "";
}
function openAiChatBody(config, image) {
  return JSON.stringify({
    model: config.model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: promptOf(config, image) },
          { type: "image_url", image_url: { url: `data:${image.mime};base64,${image.base64}` } }
        ]
      }
    ],
    max_tokens: 2048
  });
}
function buildRequest(config, image) {
  const base = trimBase(config.apiBase);
  const protocol = resolveProtocol(config);
  const json3 = { "content-type": "application/json" };
  if (config.apiKey) json3.Authorization = `Bearer ${config.apiKey}`;
  if (protocol === "openai-chat") {
    return {
      url: `${base}/chat/completions`,
      method: "POST",
      headers: json3,
      body: openAiChatBody(config, image),
      extract: (body2) => {
        const content = deepGet(body2, ["choices", "0", "message", "content"]);
        const text = textFrom(content);
        if (text === "") throw new VisionError("\u8BC6\u56FE\u6A21\u578B\u8FD4\u56DE\u4E86\u7A7A\u5185\u5BB9\uFF08\u68C0\u67E5\u6A21\u578B\u540D/\u534F\u8BAE\u662F\u5426\u5339\u914D\uFF09");
        return text;
      }
    };
  }
  if (protocol === "openai-responses") {
    return {
      url: `${base}/responses`,
      method: "POST",
      headers: json3,
      body: JSON.stringify({
        model: config.model,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: promptOf(config, image) },
              { type: "input_image", image_url: `data:${image.mime};base64,${image.base64}` }
            ]
          }
        ]
      }),
      extract: (body2) => {
        const output = deepGet(body2, ["output"]);
        const text = Array.isArray(output) ? output.map((item) => item && typeof item === "object" ? textFrom(item.content) : "").filter((line) => line !== "").join("\n").trim() : "";
        if (text === "") throw new VisionError("\u8BC6\u56FE\u6A21\u578B\u8FD4\u56DE\u4E86\u7A7A\u5185\u5BB9\uFF08\u68C0\u67E5\u6A21\u578B\u540D/\u534F\u8BAE\u662F\u5426\u5339\u914D\uFF09");
        return text;
      }
    };
  }
  if (protocol === "anthropic") {
    const url = base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
    return {
      url,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        ...config.apiKey ? { "x-api-key": config.apiKey } : {}
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 2048,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: promptOf(config, image) },
              { type: "image", source: { type: "base64", media_type: image.mime, data: image.base64 } }
            ]
          }
        ]
      }),
      extract: (body2) => {
        const text = textFrom(deepGet(body2, ["content"]));
        if (text === "") throw new VisionError("\u8BC6\u56FE\u6A21\u578B\u8FD4\u56DE\u4E86\u7A7A\u5185\u5BB9\uFF08\u68C0\u67E5\u6A21\u578B\u540D/\u534F\u8BAE\u662F\u5426\u5339\u914D\uFF09");
        return text;
      }
    };
  }
  if (protocol === "gemini") {
    const root = base.endsWith("/v1beta") || base.endsWith("/v1") ? base : `${base}/v1beta`;
    return {
      url: `${root}/models/${encodeURIComponent(config.model)}:generateContent`,
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...config.apiKey ? { "x-goog-api-key": config.apiKey } : {}
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: promptOf(config, image) },
              { inline_data: { mime_type: image.mime, data: image.base64 } }
            ]
          }
        ]
      }),
      extract: (body2) => {
        const text = textFrom(deepGet(body2, ["candidates", "0", "content", "parts"]));
        if (text === "") throw new VisionError("\u8BC6\u56FE\u6A21\u578B\u8FD4\u56DE\u4E86\u7A7A\u5185\u5BB9\uFF08\u68C0\u67E5\u6A21\u578B\u540D/\u534F\u8BAE\u662F\u5426\u5339\u914D\uFF09");
        return text;
      }
    };
  }
  const template = config.requestTemplate.trim();
  if (template === "") throw new VisionError("\u81EA\u5B9A\u4E49\u534F\u8BAE\u9700\u8981\u5728\u8BBE\u7F6E\u9875\u586B\u5199\u8BF7\u6C42\u6A21\u677F\uFF08requestTemplate\uFF09");
  const dataUrl = `data:${image.mime};base64,${image.base64}`;
  const body = template.replaceAll("{{model}}", JSON.stringify(config.model)).replaceAll("{{prompt}}", JSON.stringify(promptOf(config, image))).replaceAll("{{image}}", JSON.stringify(image.base64)).replaceAll("{{dataUrl}}", JSON.stringify(dataUrl)).replaceAll("{{mime}}", JSON.stringify(image.mime));
  const responsePath = config.responsePath.trim();
  if (responsePath === "") throw new VisionError("\u81EA\u5B9A\u4E49\u534F\u8BAE\u9700\u8981\u5728\u8BBE\u7F6E\u9875\u586B\u5199\u54CD\u5E94\u8DEF\u5F84\uFF08responsePath\uFF09");
  return {
    url: base,
    method: "POST",
    headers: json3,
    body,
    extract: (raw) => {
      const text = textFrom(deepGet(raw, splitPath(responsePath)));
      if (text === "") throw new VisionError(`\u54CD\u5E94\u91CC\u6309 ${responsePath} \u53D6\u4E0D\u5230\u6587\u672C\uFF08\u68C0\u67E5\u54CD\u5E94\u8DEF\u5F84\uFF09`);
      return text;
    }
  };
}

// src/vision/routes.ts
var VISION_CONFIG_ROUTE = "/api/dsh-remote-dafeiyu/vision/config";
var VISION_RECOGNIZE_ROUTE = "/api/dsh-remote-dafeiyu/vision/recognize";
var VISION_MODELS_ROUTE = "/api/dsh-remote-dafeiyu/vision/models";
var VISION_WEB_STATUS_ROUTE = "/api/dsh-remote-dafeiyu/vision/web/status";
var VISION_WEB_LOGIN_ROUTE = "/api/dsh-remote-dafeiyu/vision/web/login";
var statusCache = /* @__PURE__ */ new Map();
var STATUS_TTL_MS = 6e4;
var MAX_BODY_BYTES = 25 * 1024 * 1024;
function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  response.end(payload);
}
function rejected(request) {
  if (!hostIsLoopback(request.headers.host)) return "host-not-loopback";
  if (!originIsLoopbackOrAbsent(request.headers.origin)) return "origin-not-trusted";
  return void 0;
}
function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    request.on("data", (chunk) => {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        finish({ ok: false, status: 413, error: "\u8BF7\u6C42\u592A\u5927\uFF08\u56FE\u7247\u4E0A\u9650\u7EA6 20MB\uFF09" });
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => finish({ ok: true, text: Buffer.concat(chunks).toString("utf8") }));
    request.on("error", (error) => finish({ ok: false, status: 400, error: `\u8BFB\u53D6\u8BF7\u6C42\u5931\u8D25\uFF1A${String(error?.message ?? error)}` }));
  });
}
function visionConfigHandler(deps) {
  return async (request, response) => {
    const denied = rejected(request);
    if (denied) {
      json(response, 403, { ok: false, error: denied });
      return;
    }
    if (request.method === "GET" || request.method === "HEAD") {
      json(response, 200, { ok: true, config: deps.service.view(), storageFile: deps.service.configFile });
      return;
    }
    if (request.method !== "POST") {
      json(response, 405, { ok: false, error: "\u53EA\u652F\u6301 GET\uFF08\u8BFB\uFF09/ POST\uFF08\u5199\uFF09" });
      return;
    }
    const body = await readBody(request);
    if (!body.ok) {
      json(response, body.status, { ok: false, error: body.error });
      return;
    }
    let parsed;
    try {
      parsed = body.text === "" ? {} : JSON.parse(body.text);
    } catch {
      json(response, 400, { ok: false, error: "\u8BF7\u6C42\u4F53\u4E0D\u662F\u5408\u6CD5 JSON" });
      return;
    }
    const payload = parsed && typeof parsed === "object" ? parsed : {};
    const result = deps.service.save(payload.config !== void 0 ? payload.config : parsed);
    if (!result.ok) {
      json(response, 500, { ok: false, error: result.error ?? "\u4FDD\u5B58\u5931\u8D25" });
      return;
    }
    deps.log("\u8BC6\u56FE\u914D\u7F6E\u5DF2\u4FDD\u5B58", { enabled: result.config?.enabled, model: result.config?.model });
    json(response, 200, { ok: true, config: result.config });
  };
}
function visionRecognizeHandler(deps) {
  return async (request, response) => {
    const denied = rejected(request);
    if (denied) {
      json(response, 403, { ok: false, error: denied });
      return;
    }
    if (request.method !== "POST") {
      json(response, 405, { ok: false, error: "\u53EA\u652F\u6301 POST" });
      return;
    }
    const body = await readBody(request);
    if (!body.ok) {
      json(response, body.status, { ok: false, error: body.error });
      return;
    }
    let parsed;
    try {
      parsed = body.text === "" ? {} : JSON.parse(body.text);
    } catch {
      json(response, 400, { ok: false, error: "\u8BF7\u6C42\u4F53\u4E0D\u662F\u5408\u6CD5 JSON" });
      return;
    }
    const imageBase64 = typeof parsed.imageBase64 === "string" ? parsed.imageBase64 : "";
    if (imageBase64 === "") {
      json(response, 400, { ok: false, error: "\u7F3A\u5C11 imageBase64" });
      return;
    }
    try {
      const text = await deps.service.recognize({
        base64: imageBase64,
        mime: typeof parsed.mime === "string" && parsed.mime.trim() !== "" ? parsed.mime.trim() : "image/png",
        prompt: typeof parsed.prompt === "string" ? parsed.prompt : void 0
      });
      deps.log("\u8BC6\u56FE\u5B8C\u6210", { chars: text.length });
      json(response, 200, { ok: true, text });
    } catch (error) {
      const status = error instanceof VisionError && error.status >= 400 ? 502 : 400;
      const message = String(error?.message ?? error);
      deps.log("\u8BC6\u56FE\u5931\u8D25", { message: message.slice(0, 200) });
      json(response, status, { ok: false, error: message });
    }
  };
}
function visionModelsHandler(deps) {
  return async (request, response) => {
    const denied = rejected(request);
    if (denied) {
      json(response, 403, { ok: false, error: denied });
      return;
    }
    if (request.method !== "POST" && request.method !== "GET") {
      json(response, 405, { ok: false, error: "\u53EA\u652F\u6301 GET / POST" });
      return;
    }
    try {
      const models = await deps.service.listModels();
      json(response, 200, { ok: true, models });
    } catch (error) {
      const status = error instanceof VisionError && error.status >= 400 ? 502 : 400;
      json(response, status, { ok: false, error: String(error?.message ?? error) });
    }
  };
}
var WEB_SITES = ["doubao", "gemini"];
function parseWebSite(value) {
  return typeof value === "string" && WEB_SITES.includes(value) ? value : void 0;
}
function visionWebStatusHandler(deps) {
  return async (request, response) => {
    const denied = rejected(request);
    if (denied) {
      json(response, 403, { ok: false, error: denied });
      return;
    }
    if (request.method !== "GET" && request.method !== "POST") {
      json(response, 405, { ok: false, error: "\u53EA\u652F\u6301 GET / POST" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const raw = (url.searchParams.get("site") ?? "both").toLowerCase();
    const fresh = url.searchParams.get("fresh") === "1";
    const sites = raw === "both" ? [...WEB_SITES] : (() => {
      const one = parseWebSite(raw);
      return one ? [one] : [];
    })();
    if (sites.length === 0) {
      json(response, 400, { ok: false, error: `site \u53EA\u80FD\u662F ${WEB_SITES.join(" / ")} / both` });
      return;
    }
    const results = [];
    for (const site of sites) {
      const cached = statusCache.get(site);
      if (!fresh && cached && Date.now() - cached.at < STATUS_TTL_MS) {
        results.push({ ...cached.value, cached: true });
        continue;
      }
      try {
        const value = await deps.service.webStatus(site);
        statusCache.set(site, { at: Date.now(), value });
        results.push({ ...value, cached: false });
      } catch (error) {
        results.push({ site, label: site, loggedIn: false, error: String(error?.message ?? error) });
      }
    }
    json(response, 200, { ok: true, sites: results });
  };
}
function visionWebLoginHandler(deps) {
  return async (request, response) => {
    const denied = rejected(request);
    if (denied) {
      json(response, 403, { ok: false, error: denied });
      return;
    }
    if (request.method !== "POST") {
      json(response, 405, { ok: false, error: "\u53EA\u652F\u6301 POST" });
      return;
    }
    const body = await readBody(request);
    if (!body.ok) {
      json(response, body.status, { ok: false, error: body.error });
      return;
    }
    let parsed = {};
    try {
      parsed = body.text === "" ? {} : JSON.parse(body.text);
    } catch {
      json(response, 400, { ok: false, error: "\u8BF7\u6C42\u4F53\u4E0D\u662F\u5408\u6CD5 JSON" });
      return;
    }
    const site = parseWebSite(parsed.site);
    if (!site) {
      json(response, 400, { ok: false, error: `site \u5FC5\u987B\u662F ${WEB_SITES.join(" / ")}` });
      return;
    }
    const waitMs = typeof parsed.waitMs === "number" && Number.isFinite(parsed.waitMs) ? Math.min(Math.max(Math.round(parsed.waitMs), 3e4), 3e5) : 15e4;
    try {
      deps.log("\u6253\u5F00\u7F51\u9875\u7248\u767B\u5F55\u7A97\u53E3", { site, waitMs });
      const result = await deps.service.webLogin(site, waitMs);
      statusCache.delete(site);
      deps.log("\u7F51\u9875\u7248\u767B\u5F55\u7ED3\u679C", { site, loggedIn: result.loggedIn });
      json(response, 200, { ok: true, site, ...result });
    } catch (error) {
      json(response, 500, { ok: false, site, error: String(error?.message ?? error) });
    }
  };
}
function registerVisionRoutes(webServer, deps) {
  const definitions = [
    { kind: "exact", path: VISION_CONFIG_ROUTE, handler: visionConfigHandler(deps) },
    { kind: "exact", path: VISION_RECOGNIZE_ROUTE, handler: visionRecognizeHandler(deps) },
    { kind: "exact", path: VISION_MODELS_ROUTE, handler: visionModelsHandler(deps) },
    { kind: "exact", path: VISION_WEB_STATUS_ROUTE, handler: visionWebStatusHandler(deps) },
    { kind: "exact", path: VISION_WEB_LOGIN_ROUTE, handler: visionWebLoginHandler(deps) }
  ];
  const off = [];
  const wrapped = definitions.map((definition) => ({
    ...definition,
    handler: (request, response) => {
      applyCors(request, response);
      if (preflight(request, response)) return;
      if (request?.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }
      return definition.handler(request, response);
    }
  }));
  try {
    for (const definition of wrapped) off.push(webServer.register(definition));
  } catch (error) {
    for (const unregister of off.splice(0)) {
      try {
        unregister();
      } catch {
      }
    }
    throw error;
  }
  return () => {
    for (const unregister of off) {
      try {
        unregister();
      } catch {
      }
    }
  };
}

// src/vision/service.ts
import fs3 from "node:fs";
import path3 from "node:path";

// src/vision/web/index.ts
import fs2 from "node:fs";
import path2 from "node:path";

// src/vision/web/driver.ts
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { existsSync, mkdirSync } from "node:fs";
var wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function findBrowser(explicit) {
  if (explicit) return existsSync(explicit) ? explicit : void 0;
  const env = (process.env.DAFEIYU_WEBVISION_BROWSER ?? "").trim();
  if (env !== "") return existsSync(env) ? env : void 0;
  const candidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
  ];
  return candidates.find((candidate) => existsSync(candidate));
}
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => port > 0 ? resolve(port) : reject(new Error("\u62FF\u4E0D\u5230\u7A7A\u95F2\u7AEF\u53E3")));
    });
  });
}
function getJson(url, timeoutMs = 2e3) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("CDP \u63A2\u6D4B\u8D85\u65F6")));
    request.on("error", reject);
  });
}
function killTree(pid, log) {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch (error) {
    log("\u6740\u6D4F\u89C8\u5668\u8FDB\u7A0B\u6811\u5931\u8D25", { pid, reason: String(error?.message ?? error) });
  }
}
function startParentWatchdog(browserPid, log) {
  const timer = setInterval(() => {
    try {
      process.kill(browserPid, 0);
    } catch {
      clearInterval(timer);
      return;
    }
    if (process.ppid === 1) {
      clearInterval(timer);
      killTree(browserPid, log);
    }
  }, 5e3);
  timer.unref?.();
  return timer;
}
async function launchCdpBrowser(options) {
  const log = options.log ?? (() => void 0);
  const executable = findBrowser(options.executable);
  if (!executable) {
    throw new Error("\u627E\u4E0D\u5230 Edge/Chrome\uFF1A\u53EF\u4EE5\u7528\u73AF\u5883\u53D8\u91CF DAFEIYU_WEBVISION_BROWSER \u6307\u5B9A\u53EF\u6267\u884C\u6587\u4EF6\u8DEF\u5F84");
  }
  const headless = options.headless !== false;
  mkdirSync(options.profileDir, { recursive: true });
  const port = await freePort();
  const args = [
    headless ? "--headless=new" : "--start-maximized",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    // 关掉 Edge 的账号同步/首次弹窗：新 profile 首启动会弹 edge://sync-confirmation-dialog，
    // 那个内部页会抢走 page target（见下面 isHttpPage 的注释）。
    "--disable-sync",
    "--no-service-autorun",
    "--disable-features=Translate,OptimizationHints,msSyncConsent,SigninInterception",
    "--mute-audio",
    "--hide-scrollbars",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${options.profileDir}`,
    "--lang=zh-CN",
    "about:blank"
  ];
  const child = spawn(executable, args, {
    stdio: "ignore",
    windowsHide: headless,
    cwd: options.profileDir
  });
  if (typeof child.pid === "number") startParentWatchdog(child.pid, log);
  let closed = false;
  let watchdog;
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    if (watchdog) clearInterval(watchdog);
    try {
      await Promise.race([
        socket.readyState === 1 ? (socket.send(JSON.stringify({ id: -1, method: "Browser.close" })), Promise.resolve()) : Promise.resolve(),
        wait(2e3)
      ]);
      for (let i = 0; i < 40; i += 1) {
        if (!child.pid) break;
        try {
          process.kill(child.pid, 0);
        } catch {
          break;
        }
        await wait(100);
      }
    } catch {
    }
    if (typeof child.pid === "number") killTree(child.pid, log);
    await wait(150);
  };
  const readyTimeout = options.readyTimeoutMs ?? 25e3;
  const deadline = Date.now() + readyTimeout;
  let target;
  const isHttpPage = (row) => row.type === "page" && typeof row.webSocketDebuggerUrl === "string" && /^https?:/i.test(row.url ?? "");
  while (Date.now() < deadline) {
    try {
      const list = await getJson(`http://127.0.0.1:${port}/json/list`);
      target = list.find(isHttpPage);
      if (target) break;
      if (Date.now() > deadline - readyTimeout / 2) {
        const any = list.find((row) => row.type === "page" && typeof row.webSocketDebuggerUrl === "string");
        if (any) {
          target = any;
          break;
        }
      }
    } catch {
    }
    await wait(200);
  }
  if (!target?.webSocketDebuggerUrl) {
    await cleanup();
    throw new Error(
      `\u6D4F\u89C8\u5668\u6CA1\u8D77\u6765\uFF08\u7AEF\u53E3 ${port}\uFF0C\u7B49\u4E86 ${Math.round(readyTimeout / 1e3)} \u79D2\uFF09\u3002\u5E38\u89C1\u539F\u56E0\uFF1A\u8FD9\u4E2A profile \u5DF2\u7ECF\u88AB\u53E6\u4E00\u4E2A\u7A97\u53E3\u5360\u7740\uFF08\u5148\u5168\u90E8\u5173\u6389\u518D\u8BD5\uFF09`
    );
  }
  const WebSocketCtor = globalThis.WebSocket;
  if (typeof WebSocketCtor !== "function") {
    await cleanup();
    throw new Error("\u5BBF\u4E3B Node \u7248\u672C\u8FC7\u4F4E\uFF08\u6CA1\u6709\u5168\u5C40 WebSocket\uFF0C\u9700\u8981 22+\uFF09\uFF0C\u7F51\u9875\u7248\u89C6\u89C9\u4E0D\u53EF\u7528");
  }
  const socket = new WebSocketCtor(target.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = /* @__PURE__ */ new Map();
  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error.message ?? "CDP \u9519\u8BEF"));
    else waiter.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const [id, waiter] of pending) {
      pending.delete(id);
      clearTimeout(waiter.timer);
      waiter.reject(new Error("CDP \u8FDE\u63A5\u65AD\u4E86\uFF08\u6D4F\u89C8\u5668\u88AB\u5173\u6389\uFF1F\uFF09"));
    }
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("\u8FDE\u4E0D\u4E0A CDP WebSocket")));
    setTimeout(() => reject(new Error("\u8FDE\u4E0D\u4E0A CDP WebSocket\uFF0810s\uFF09")), 1e4);
  });
  const call = (method, params, timeoutMs = 2e4) => {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} \u8D85\u65F6\uFF08${timeoutMs}ms\uFF09`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
    });
  };
  const evaluate = async (expression, timeoutMs = 3e4) => {
    const result = await call(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true, userGesture: false },
      timeoutMs
    );
    if (result?.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "\u9875\u9762\u6267\u884C\u51FA\u9519";
      throw new Error(String(detail).slice(0, 400));
    }
    return result?.result?.value;
  };
  try {
    await call("Page.enable", {}, 1e4).catch(() => void 0);
    await call("Runtime.enable", {}, 1e4).catch(() => void 0);
    await call("DOM.enable", {}, 1e4).catch(() => void 0);
    await call("Network.enable", {}, 1e4).catch(() => void 0);
  } catch {
  }
  if (headless) {
    try {
      const raw = await evaluate("navigator.userAgent", 5e3);
      if (typeof raw === "string" && raw.includes("HeadlessChrome")) {
        await call("Network.setUserAgentOverride", { userAgent: raw.replace("HeadlessChrome", "Chrome") }, 5e3);
      }
    } catch {
    }
  }
  return {
    port,
    evaluate,
    call,
    async goto(url, timeoutMs = 4e4) {
      await call("Page.navigate", { url }, timeoutMs).catch(() => void 0);
      const dl = Date.now() + timeoutMs;
      while (Date.now() < dl) {
        const state = await evaluate("document.readyState").catch(() => "loading");
        if (state === "complete") return;
        await wait(300);
      }
    },
    async screenshot(file) {
      try {
        const shot = await call("Page.captureScreenshot", { format: "png" }, 15e3);
        if (shot?.data) {
          const fs6 = await import("node:fs");
          fs6.writeFileSync(file, Buffer.from(shot.data, "base64"));
        }
      } catch {
      }
    },
    async close() {
      try {
        socket.close();
      } catch {
      }
      await cleanup();
    }
  };
}

// src/vision/web/sites.ts
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
var DOUBAO = {
  id: "doubao",
  label: "\u8C46\u5305",
  homeUrl: "https://www.doubao.com/chat/",
  loginUrl: "https://www.doubao.com/chat/",
  editorSelector: ".ProseMirror",
  loginProbe: `(() => {
    if (document.querySelector('[data-testid="to_login_button"]')) return false;
    if (location.search.includes('from_logout')) return false;
    return true;
  })()`,
  openUpload: `(() => {
    const btn = document.querySelector('[data-testid="upload_file_button"]');
    if (!btn) return false;
    btn.click();
    return true;
  })()`,
  fileInputSelector: "input[type=file]",
  answerSelectors: [
    '[data-testid="message_text_content"]',
    '[data-testid="receive_message"] [data-testid*="text"]',
    '[data-testid="receive_message"]',
    ".flow-markdown-body"
  ],
  busySelectors: ['[data-testid="stop_generation_button"]', '[aria-label*="\u505C\u6B62\u751F\u6210"]']
};
var GEMINI = {
  id: "gemini",
  label: "Gemini",
  homeUrl: "https://gemini.google.com/app",
  loginUrl: "https://gemini.google.com/app",
  editorSelector: ".ql-editor",
  loginProbe: `(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    if (buttons.some((b) => (b.getAttribute('aria-label') || '').trim() === '\u767B\u5F55')) return false;
    if (document.querySelector('a[href*="accounts.google.com/ServiceLogin"]')) return false;
    return !!document.querySelector('.ql-editor');
  })()`,
  openUpload: `(() => {
    const btn = document.querySelector('button[aria-label="\u4E0A\u4F20\u548C\u5DE5\u5177"]')
      || Array.from(document.querySelectorAll('button')).find((b) => /\u4E0A\u4F20\u548C\u5DE5\u5177|Upload and tools/i.test(b.getAttribute('aria-label') || ''));
    if (!btn) return false;
    btn.click();
    return true;
  })()`,
  /**
   * ⚠️ 别写 `input[accept="image/*"]`（精确匹配）：登录后 Gemini 给的是
   * `accept="image/*,video/*"`，精确匹配会**一个都找不到**，表现是"点了上传却等不到输入框"。
   * 用子串匹配（`*=`）才稳。
   */
  fileInputSelector: 'input[accept*="image/"]',
  answerSelectors: ["model-response .markdown", "model-response message-content", "response-container", "model-response"],
  busySelectors: ['[aria-label*="\u505C\u6B62"]', '[aria-label*="Stop"]'],
  newChat: `(() => {
    const hit = Array.from(document.querySelectorAll('button, a')).find((el) => {
      const label = (el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '');
      return /\u53D1\u8D77\u65B0\u5BF9\u8BDD|New chat/i.test(label);
    });
    if (!hit) return false;
    hit.click();
    return true;
  })()`,
  emptyProbe: `document.querySelectorAll('model-response').length === 0`,
  sendSelector: 'button[aria-label="\u53D1\u9001"], button[aria-label*="Send"], button[aria-label*="\u53D1\u9001"]'
};
var SITES = { doubao: DOUBAO, gemini: GEMINI };
var wait2 = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function pollTrue(client, expression, timeoutMs, stepMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await client.evaluate(expression).catch(() => false);
    if (ok) return true;
    await wait2(stepMs);
  }
  return false;
}
function writeTempImage(base64, mime) {
  const ext = mime.includes("jpeg") ? "jpg" : mime.includes("webp") ? "webp" : mime.includes("gif") ? "gif" : "png";
  const file = path.join(os.tmpdir(), `dafeiyu-webvision-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
  fs.writeFileSync(file, Buffer.from(base64, "base64"));
  return file;
}
async function setFileInput(client, selector, file) {
  const handle = await client.call("Runtime.evaluate", {
    expression: `document.querySelector(${JSON.stringify(selector)})`,
    returnByValue: false
  }).catch(() => void 0);
  const objectId = handle?.result?.objectId;
  if (!objectId) return false;
  await client.call("DOM.setFileInputFiles", { files: [file], objectId }, 2e4);
  return true;
}
async function typeInto(client, selector, text) {
  return client.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      const ok = document.execCommand('insertText', false, ${JSON.stringify(text)});
      return ok !== false;
    })()`).catch(() => false);
}
async function pressEnter(client) {
  for (const type of ["rawKeyDown", "keyUp"]) {
    await client.call("Input.dispatchKeyEvent", {
      type,
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13
    });
  }
}
async function clearEditor(client, selector) {
  return client.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('delete');
      return true;
    })()`).catch(() => false);
}
function editorEmptyExpression(selector) {
  return `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? (el.innerText || '').trim() === '' : false })()`;
}
async function clickElement(client, selector) {
  const box = await client.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`).catch(() => null);
  if (!box) return false;
  for (const type of ["mousePressed", "mouseReleased"]) {
    await client.call("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  }
  return true;
}
async function readAnswer(client, selectors, exclude = "") {
  const list = JSON.stringify(selectors);
  const result = await client.evaluate(`(() => {
      const skip = ${JSON.stringify(exclude.trim())};
      for (const sel of ${list}) {
        const nodes = Array.from(document.querySelectorAll(sel));
        if (nodes.length === 0) continue;
        for (let i = nodes.length - 1; i >= 0; i -= 1) {
          const text = ((nodes[i].innerText || nodes[i].textContent || '') + '').trim();
          if (text === '' || text === skip) continue;
          return { text, selector: sel };
        }
      }
      return { text: '', selector: '' };
    })()`).catch(() => ({ text: "", selector: "" }));
  return result ?? { text: "", selector: "" };
}
async function stillBusy(client, selectors) {
  if (selectors.length === 0) return false;
  const list = JSON.stringify(selectors);
  return client.evaluate(`(() => ${list}.some((sel) => !!document.querySelector(sel)))()`).catch(() => false);
}
var NOT_LOGGED_IN_HINT = (label) => `${label}\u6CA1\u6709\u767B\u5F55\uFF1A\u5148\u5728\u300C\u80A5\u9C7C\u8BC6\u56FE\u300D\u8BBE\u7F6E\u91CC\u70B9\u300C\u767B\u5F55 ${label}\u300D\uFF0C\u5728\u5F39\u51FA\u7684\u7A97\u53E3\u91CC\u767B\u4E00\u6B21\uFF08cookie \u4F1A\u7559\u5728\u672C\u673A profile \u91CC\uFF0C\u4E4B\u540E\u957F\u671F\u6709\u6548\uFF09`;
function answerBudgetMs(timeoutMs) {
  return Math.max(Number.isFinite(timeoutMs) ? timeoutMs : 0, 15e3);
}
async function askSite(client, site, options) {
  const startedAt = Date.now();
  const log = options.log ?? (() => void 0);
  await client.goto(site.homeUrl);
  const ready = await pollTrue(client, `!!document.querySelector(${JSON.stringify(site.editorSelector)})`, 25e3);
  if (!ready) throw new VisionError(`${site.label}\u9875\u9762\u6CA1\u52A0\u8F7D\u51FA\u6765\uFF08\u627E\u4E0D\u5230\u8F93\u5165\u6846 ${site.editorSelector}\uFF09\uFF1A\u68C0\u67E5\u7F51\u7EDC\uFF0C\u6216\u5148\u5728\u8BBE\u7F6E\u91CC\u767B\u5F55\u4E00\u6B21`, 0);
  const loggedIn = await client.evaluate(site.loginProbe).catch(() => false);
  if (!loggedIn) throw new VisionError(NOT_LOGGED_IN_HINT(site.label), 401);
  if (site.newChat) {
    const clicked = await client.evaluate(site.newChat).catch(() => false);
    if (clicked && site.emptyProbe) {
      const clean = await pollTrue(client, site.emptyProbe, 1e4);
      if (!clean) log("\u65B0\u5BF9\u8BDD\u6CA1\u6E05\u5E72\u51C0\uFF0C\u7EE7\u7EED\uFF08\u53EF\u80FD\u62BD\u5230\u65E7\u56DE\u7B54\uFF09", { site: site.id });
    }
  }
  await clearEditor(client, site.editorSelector);
  const opened = await client.evaluate(site.openUpload).catch(() => false);
  if (!opened) throw new VisionError(`${site.label}\u9875\u9762\u4E0A\u627E\u4E0D\u5230\u4E0A\u4F20\u5165\u53E3\uFF08\u524D\u7AEF\u53EF\u80FD\u6539\u7248\u4E86\uFF09`, 0);
  const inputReady = await pollTrue(client, `!!document.querySelector(${JSON.stringify(site.fileInputSelector)})`, 8e3);
  if (!inputReady) throw new VisionError(`${site.label}\u70B9\u4E86\u4E0A\u4F20\u4F46\u6CA1\u51FA\u73B0\u6587\u4EF6\u8F93\u5165\u6846\uFF08\u524D\u7AEF\u53EF\u80FD\u6539\u7248\u4E86\uFF09`, 0);
  const imageFile = writeTempImage(options.base64, options.mime);
  try {
    const attached = await setFileInput(client, site.fileInputSelector, imageFile).catch(() => false);
    if (!attached) throw new VisionError(`${site.label}\u585E\u56FE\u5931\u8D25\uFF08file input \u62FF\u4E0D\u5230\u53E5\u67C4\uFF09`, 0);
    const attachProbe = `(() => {
      const nodes = document.querySelectorAll('rich-textarea img, [class*="attachment" i], [class*="file-preview" i], [class*="preview" i] img');
      const text = document.body.innerText || '';
      const uploading = /\u6B63\u5728\u4E0A\u4F20|\u4E0A\u4F20\u4E2D|Uploading/.test(text);
      const hinted = /\u89E3\u91CA\u56FE\u7247|\u56FE\u7247\u5DF2\u4E0A\u4F20|Image attached/.test(text);
      return { uploading, count: nodes.length + (hinted ? 1 : 0) };
    })()`;
    const uploadDeadline = Date.now() + 3e4;
    let attachSeen = false;
    while (Date.now() < uploadDeadline) {
      const state = await client.evaluate(attachProbe).catch(() => ({ uploading: false, count: 0 }));
      if (state.count > 0) attachSeen = true;
      if (!state.uploading && attachSeen) break;
      await wait2(400);
    }
    if (!attachSeen) log("\u6CA1\u770B\u5230\u9644\u4EF6\u843D\u5730\u8FF9\u8C61\uFF0C\u7EE7\u7EED\uFF08\u4EA4\u7ED9\u56DE\u7B54\u5224\u636E\u8BF4\u8BDD\uFF09", { site: site.id });
    const typed = await typeInto(client, site.editorSelector, options.prompt);
    if (!typed) throw new VisionError(`${site.label}\u8F93\u5165\u6846\u62FF\u4E0D\u5230\u7126\u70B9`, 0);
    const emptyProbe = editorEmptyExpression(site.editorSelector);
    let sent = false;
    if (site.sendSelector) {
      sent = await clickElement(client, site.sendSelector).catch(() => false);
      if (sent) sent = await pollTrue(client, emptyProbe, 4e3);
    }
    if (!sent) {
      await pressEnter(client);
      sent = await pollTrue(client, emptyProbe, 3e3);
    }
    if (!sent) throw new VisionError(`${site.label}\u6D88\u606F\u6CA1\u53D1\u51FA\u53BB\uFF08\u8F93\u5165\u6846\u91CC\u8FD8\u7559\u7740\u5B57\uFF09\uFF1A\u524D\u7AEF\u53EF\u80FD\u6539\u7248\uFF0C\u6216\u8FD9\u9897\u8D26\u53F7\u88AB\u9650\u5236\u4E86`, 0);
    let lastText = "";
    let stableSince = 0;
    let truncated = false;
    const answerDeadline = Date.now() + answerBudgetMs(options.timeoutMs);
    while (Date.now() < answerDeadline) {
      await wait2(500);
      const answer = await readAnswer(client, site.answerSelectors, options.prompt);
      const busy = await stillBusy(client, site.busySelectors);
      if (answer.text !== lastText) {
        lastText = answer.text;
        stableSince = Date.now();
        continue;
      }
      if (lastText !== "" && !busy && Date.now() - stableSince > 1200) break;
    }
    if (lastText === "") {
      const shot = path.join(os.tmpdir(), `dafeiyu-webvision-${site.id}-${Date.now()}.png`);
      await client.screenshot(shot);
      throw new VisionError(`${site.label}\u6CA1\u6709\u8FD4\u56DE\u53EF\u8BFB\u7684\u56DE\u7B54\uFF08\u7B49\u4E86 ${Math.round((Date.now() - startedAt) / 1e3)} \u79D2\uFF09\u3002\u622A\u56FE\uFF1A${shot}`, 0);
    }
    if (Date.now() >= answerDeadline) truncated = true;
    log("\u7F51\u9875\u7248\u8BC6\u56FE\u5B8C\u6210", { site: site.id, chars: lastText.length, elapsedMs: Date.now() - startedAt });
    return { text: lastText, truncated, elapsedMs: Date.now() - startedAt };
  } finally {
    try {
      fs.unlinkSync(imageFile);
    } catch {
    }
  }
}
async function probeLogin(client, site) {
  await client.goto(site.loginUrl);
  const ready = await pollTrue(client, `!!document.querySelector(${JSON.stringify(site.editorSelector)})`, 25e3);
  if (!ready) return { loggedIn: false, url: site.loginUrl };
  const loggedIn = await client.evaluate(site.loginProbe).catch(() => false);
  const url = await client.evaluate("location.href").catch(() => site.loginUrl);
  return { loggedIn: !!loggedIn, url };
}

// src/vision/web/index.ts
function webProfileDir(dshHome, site) {
  return path2.join(dshHome, "storages", "dsh-remote-dafeiyu", "webvision", site);
}
var runtimes = /* @__PURE__ */ new Map();
var MAX_QUEUE = 2;
function runtimeOf(site) {
  let runtime = runtimes.get(site);
  if (!runtime) {
    runtime = { chain: Promise.resolve(), pending: 0, lastUsed: 0 };
    runtimes.set(site, runtime);
  }
  return runtime;
}
function scheduleIdleClose(site, options) {
  const runtime = runtimeOf(site);
  if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
  const idleMs = options.idleMs ?? 5 * 6e4;
  runtime.idleTimer = setTimeout(() => {
    void closeSite(site, options.log);
  }, idleMs);
  runtime.idleTimer.unref?.();
}
async function closeSite(site, log) {
  const runtime = runtimes.get(site);
  if (!runtime) return;
  if (runtime.idleTimer) {
    clearTimeout(runtime.idleTimer);
    runtime.idleTimer = void 0;
  }
  const client = runtime.client;
  runtime.client = void 0;
  if (client) {
    log?.("\u5173\u95ED\u7F51\u9875\u7248\u6D4F\u89C8\u5668", { site });
    await client.close().catch(() => void 0);
  }
}
async function closeAll(log) {
  for (const site of runtimes.keys()) await closeSite(site, log);
}
async function ensureBrowser(site, options, headless) {
  const runtime = runtimeOf(site);
  if (runtime.client && runtime.headless === headless) {
    runtime.lastUsed = Date.now();
    return runtime.client;
  }
  if (runtime.client) await closeSite(site, options.log);
  const profileDir = webProfileDir(options.dshHome, site);
  fs2.mkdirSync(profileDir, { recursive: true });
  const client = await launchCdpBrowser({
    profileDir,
    headless,
    log: options.log
  });
  runtime.client = client;
  runtime.headless = headless;
  runtime.lastUsed = Date.now();
  return client;
}
async function recognizeViaWeb(site, input, options) {
  const runtime = runtimeOf(site);
  if (runtime.pending >= MAX_QUEUE) {
    throw new VisionError(`${SITES[site].label}\u8FD8\u5728\u5904\u7406\u4E0A\u4E00\u4E2A\u8BF7\u6C42\uFF08\u7F51\u9875\u7248\u4E00\u6B21\u53EA\u80FD\u8DD1\u4E00\u4E2A\uFF09\uFF0C\u7B49\u5B83\u7B54\u5B8C\u518D\u8BD5`, 429);
  }
  runtime.pending += 1;
  const gap = Math.max(0, (options.minGapMs ?? 5e3) - (Date.now() - runtime.lastUsed));
  const task = runtime.chain.catch(() => void 0).then(async () => {
    if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap));
    const client = await ensureBrowser(site, options, options.headless !== false);
    try {
      return await askSite(client, SITES[site], {
        base64: input.base64,
        mime: input.mime,
        prompt: input.prompt,
        timeoutMs: input.timeoutMs,
        log: options.log
      });
    } finally {
      runtime.lastUsed = Date.now();
      scheduleIdleClose(site, options);
    }
  }).finally(() => {
    runtime.pending = Math.max(0, runtime.pending - 1);
  });
  runtime.chain = task.catch(() => void 0);
  return task;
}
async function loginSite(site, options) {
  const runtime = runtimeOf(site);
  const alreadyBusy = runtime.client !== void 0 || runtime.pending > 0;
  if (alreadyBusy) await closeSite(site, options.log);
  const client = await ensureBrowser(site, options, false);
  const startedAt = Date.now();
  const deadline = Date.now() + (options.waitMs ?? 18e4);
  try {
    await client.goto(SITES[site].loginUrl);
    let loggedIn = false;
    while (Date.now() < deadline) {
      loggedIn = await client.evaluate(SITES[site].loginProbe).catch(() => false);
      if (loggedIn) break;
      await new Promise((resolve) => setTimeout(resolve, 2e3));
    }
    runtime.lastUsed = Date.now();
    scheduleIdleClose(site, { ...options, idleMs: 12e4 });
    return { loggedIn, waitedMs: Date.now() - startedAt };
  } catch (error) {
    await closeSite(site, options.log);
    throw error;
  }
}
async function webStatus(site, options) {
  const profileDir = webProfileDir(options.dshHome, site);
  const base = { site, label: SITES[site].label, profileDir, profileExists: fs2.existsSync(profileDir) };
  try {
    const client = await ensureBrowser(site, options, true);
    const probe = await probeLogin(client, SITES[site]);
    scheduleIdleClose(site, options);
    return { ...base, loggedIn: probe.loggedIn, url: probe.url };
  } catch (error) {
    return { ...base, loggedIn: false, error: String(error?.message ?? error) };
  }
}

// src/vision/service.ts
var MAX_IMAGE_BYTES = 20 * 1024 * 1024;
function assertUsable(config, image) {
  if (!config.enabled) {
    throw new VisionError("\u8BC6\u56FE\u672A\u5F00\u542F\uFF1A\u8BBE\u7F6E \u2192 \u5927\u80A5\u9C7C \u2192 \u4EBA\u8BBE \u2192 \u8BC6\u56FE\uFF0C\u6253\u5F00\u603B\u5F00\u5173", 0);
  }
  if (image.base64 === "") throw new VisionError("\u56FE\u7247\u5185\u5BB9\u4E3A\u7A7A", 0);
  if (image.base64.length * 0.75 > MAX_IMAGE_BYTES) throw new VisionError("\u56FE\u7247\u592A\u5927\uFF08\u4E0A\u9650 20MB\uFF09\uFF0C\u5148\u538B\u7F29\u518D\u53D1", 0);
}
async function recognizeViaBrowser(config, image, dshHome, log) {
  assertUsable(config, image);
  const protocol = resolveProtocol(config);
  if (!isWebProtocol(protocol)) throw new VisionError("\u5F53\u524D\u534F\u8BAE\u4E0D\u662F\u7F51\u9875\u7248", 0);
  const site = webSiteOf(protocol);
  const prompt = typeof image.prompt === "string" && image.prompt.trim() !== "" ? image.prompt.trim() : config.prompt;
  const result = await recognizeViaWeb(
    site,
    { base64: image.base64, mime: image.mime, prompt, timeoutMs: config.timeoutMs },
    { dshHome, headless: config.webHeadless, log }
  );
  return result.truncated ? `${result.text}

\uFF08\u7F51\u9875\u7248\u751F\u6210\u8D85\u65F6\u88AB\u622A\u65AD\uFF1A\u4EE5\u4E0A\u662F\u5DF2\u751F\u6210\u7684\u90E8\u5206\uFF0C\u53EF\u52A0\u5927\u8D85\u65F6\u6216\u91CD\u8BD5\uFF09` : result.text;
}
function visionDir(dshHome) {
  return path3.join(dshHome, "storages", "dsh-remote-dafeiyu");
}
function visionConfigFile(dshHome) {
  return path3.join(visionDir(dshHome), "vision.json");
}
function readVisionConfig(file) {
  try {
    const raw = fs3.readFileSync(file, "utf8");
    return normalizeVisionConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_VISION_CONFIG };
  }
}
function writeVisionConfig(file, config) {
  try {
    fs3.mkdirSync(path3.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs3.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}
`, "utf8");
    fs3.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}
function errorSnippet(body) {
  const text = String(body ?? "").replace(/\s+/g, " ").trim();
  return text.length > 240 ? `${text.slice(0, 240)}\u2026` : text;
}
async function recognize(config, image) {
  assertUsable(config, image);
  if (config.apiKey.trim() === "") {
    throw new VisionError("\u8BC6\u56FE\u8FD8\u6CA1\u914D\u7F6E API Key\uFF1A\u8BBE\u7F6E \u2192 \u5927\u80A5\u9C7C \u2192 \u4EBA\u8BBE \u2192 \u8BC6\u56FE\u91CC\u586B\u5916\u6302\u89C6\u89C9\u6A21\u578B\u7684 key", 0);
  }
  const prepared = buildRequest(config, image);
  let response;
  try {
    response = await fetch(prepared.url, {
      method: prepared.method,
      headers: prepared.headers,
      body: prepared.body,
      signal: typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(config.timeoutMs) : void 0
    });
  } catch (error) {
    const reason = String(error?.message ?? error);
    throw new VisionError(`\u8FDE\u4E0D\u4E0A\u8BC6\u56FE\u6A21\u578B\uFF08${prepared.url}\uFF09\uFF1A${reason}`, 0);
  }
  const raw = await response.text();
  if (!response.ok) {
    throw new VisionError(`\u8BC6\u56FE\u6A21\u578B\u8FD4\u56DE HTTP ${response.status}\uFF1A${errorSnippet(raw) || "\uFF08\u7A7A\u54CD\u5E94\uFF09"}`, response.status);
  }
  let json3;
  try {
    json3 = raw === "" ? {} : JSON.parse(raw);
  } catch {
    throw new VisionError(`\u8BC6\u56FE\u6A21\u578B\u8FD4\u56DE\u7684\u4E0D\u662F JSON\uFF1A${errorSnippet(raw)}`, response.status);
  }
  const text = prepared.extract(json3);
  if (text === "") throw new VisionError("\u8BC6\u56FE\u6A21\u578B\u8FD4\u56DE\u4E86\u7A7A\u63CF\u8FF0\uFF08\u6362\u4E00\u5F20\u56FE\u6216\u68C0\u67E5\u63D0\u793A\u8BCD\uFF09", response.status);
  return text;
}
async function listModels(config) {
  const base = String(config.apiBase ?? "").replace(/\/+$/, "");
  const url = `${base}/models`;
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
      signal: typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(15e3) : void 0
    });
  } catch (error) {
    throw new VisionError(`\u62C9\u6A21\u578B\u5217\u8868\u5931\u8D25\uFF08${url}\uFF09\uFF1A${String(error?.message ?? error)}`, 0);
  }
  const raw = await response.text();
  if (!response.ok) throw new VisionError(`\u62C9\u6A21\u578B\u5217\u8868\u5931\u8D25 HTTP ${response.status}\uFF1A${errorSnippet(raw)}`, response.status);
  try {
    const json3 = JSON.parse(raw);
    const models = Array.isArray(json3.data) ? json3.data.map((item) => typeof item?.id === "string" ? item.id : "").filter((id) => id !== "") : [];
    if (models.length === 0) throw new VisionError("\u6A21\u578B\u5217\u8868\u662F\u7A7A\u7684\uFF08\u8FD9\u4E2A\u63A5\u53E3\u53EF\u80FD\u4E0D\u652F\u6301 /models\uFF09", 0);
    return models;
  } catch (error) {
    if (error instanceof VisionError) throw error;
    throw new VisionError(`\u6A21\u578B\u5217\u8868\u89E3\u6790\u5931\u8D25\uFF1A${errorSnippet(raw)}`, response.status);
  }
}
function createVisionService(dshHome, log) {
  const dir = visionDir(dshHome);
  const configFile = visionConfigFile(dshHome);
  let config = readVisionConfig(configFile);
  return {
    dir,
    configFile,
    current: () => config,
    view: () => toView(config),
    save(input) {
      const next = normalizeVisionConfig(input, config);
      if (!writeVisionConfig(configFile, next)) {
        return { ok: false, error: "\u914D\u7F6E\u5199\u4E0D\u8FDB\u53BB\uFF08\u68C0\u67E5\u78C1\u76D8/\u6743\u9650\uFF09" };
      }
      config = next;
      return { ok: true, config: toView(config) };
    },
    enabled: () => config.enabled,
    recognize: (image) => isWebProtocol(resolveProtocol(config)) ? recognizeViaBrowser(config, image, dshHome, log) : recognize(config, image),
    listModels: () => listModels(config),
    webStatus: (site) => webStatus(site, { dshHome, headless: config.webHeadless, log }),
    webLogin: (site, waitMs) => loginSite(site, { dshHome, headless: false, waitMs, log }),
    dispose: () => closeAll(log),
    describe: () => {
      const protocol = resolveProtocol(config);
      return {
        enabled: config.enabled,
        protocol,
        webSite: isWebProtocol(protocol) ? webSiteOf(protocol) : null,
        configured: isWebProtocol(protocol) ? true : config.apiKey !== "",
        apiKeyHint: redactKey(config.apiKey),
        model: config.model
      };
    }
  };
}

// src/vision/start.ts
var VISION_SERVICE_NAME = "dafeiyuVision";
var GUIDANCE = [
  "## \u8BC6\u56FE\u80FD\u529B\uFF08\u8BC6\u56FE\u5DF2\u5F00\u542F\uFF09",
  "\u4F60\u53EF\u4EE5\u8C03\u7528 `recognize_image` \u5DE5\u5177\uFF1A\u7ED9\u4E00\u5F20\u672C\u5730\u56FE\u7247\u7684\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u5B83\u4F1A\u628A\u56FE\u7247\u4EA4\u7ED9\u5916\u6302\u89C6\u89C9\u6A21\u578B\uFF0C\u8FD4\u56DE\u6587\u672C\u63CF\u8FF0\uFF08\u542B\u9010\u5B57\u8F6C\u5F55\uFF09\u3002\u7528\u6237\u8BF4\u300C\u770B\u770B\u8FD9\u5F20\u56FE / \u8FD9\u4E2A\u622A\u56FE\u300D\u5E76\u7ED9\u51FA\u8DEF\u5F84\u65F6\u7528\u5B83\u3002",
  "\u7528\u6237\u5982\u679C\u628A\u56FE\u7247\u76F4\u63A5\u8D34\u8FDB\u804A\u5929\uFF0C\u4F60\u4F1A\u6536\u5230\u4E00\u6761\u4EE5\u300C\u3010\u56FE\u7247\u8BC6\u522B\u3011\u300D\u5F00\u5934\u7684\u6587\u672C\u2014\u2014\u90A3\u662F\u522B\u4EBA\u66FF\u4F60\u770B\u8FC7\u7684\u7ED3\u679C\uFF0C\u76F4\u63A5\u57FA\u4E8E\u5B83\u56DE\u7B54\uFF0C**\u4E0D\u8981\u58F0\u79F0\u4F60\u770B\u5230\u4E86\u539F\u56FE**\u3002"
].join("\n");
function startVision(ctx, deps) {
  const service = createVisionService(deps.dshHome, deps.log);
  const probe = {};
  let web;
  let unregister;
  let started = false;
  let stopped = false;
  const tryStart = () => {
    if (started || stopped || !web) return;
    started = true;
    try {
      unregister = registerVisionRoutes(web, { service, log: deps.log });
      probe.routes = "registered";
    } catch (error) {
      probe.routes = `register threw: ${String(error?.message ?? error).slice(0, 80)}`;
      started = false;
      deps.log("\u8BC6\u56FE\u8DEF\u7531\u6CE8\u518C\u5931\u8D25\uFF08\u8FDC\u63A7/\u4EBA\u8BBE\u4E0D\u53D7\u5F71\u54CD\uFF09", { message: String(error?.message ?? error).slice(0, 200) });
      return;
    }
    deps.log("\u8BC6\u56FE\u8DEF\u7531\u5DF2\u6302\u4E0A");
  };
  const acceptWeb = (value, via) => {
    if (!value || typeof value !== "object") return false;
    if (typeof value.register !== "function") {
      probe.webServer = "object without register()";
      return false;
    }
    web = value;
    probe.webServer = via;
    tryStart();
    return true;
  };
  const pickFrom = (source) => {
    if (!source || typeof source !== "object") return void 0;
    const asContext = source;
    if (typeof asContext.get === "function") {
      try {
        const got = asContext.get("webServer", true);
        if (got) return got;
      } catch {
      }
    }
    try {
      return source["webServer"];
    } catch {
      return void 0;
    }
  };
  try {
    const found = ctx.get?.("webServer", true);
    if (found) acceptWeb(found, "via get");
    else probe.webServer = "none";
  } catch (error) {
    probe.webServer = `get threw: ${String(error?.message ?? error).slice(0, 80)}`;
  }
  try {
    ctx.inject?.(["webServer"], ((...args) => {
      try {
        for (const candidate of [args[0], ...args, ctx]) {
          if (acceptWeb(pickFrom(candidate), "via inject")) return;
        }
        probe.webServer = `${probe.webServer ?? "none"} (inject fired, empty)`;
      } catch (error) {
        probe["injectThrew:webServer"] = String(error?.message ?? error).slice(0, 160);
      }
    }));
  } catch (error) {
    probe["injectThrew:webServer"] = String(error?.message ?? error).slice(0, 160);
  }
  try {
    ctx.provide?.(VISION_SERVICE_NAME, {
      get enabled() {
        return service.enabled();
      },
      recognize: (image) => service.recognize(image),
      describe: () => service.describe()
    });
    probe.provide = "ok";
  } catch (error) {
    probe.provide = `threw: ${String(error?.message ?? error).slice(0, 80)}`;
  }
  if (service.enabled()) {
    try {
      const systemPrompt = ctx.get?.("systemPrompt", true);
      if (systemPrompt && typeof systemPrompt.section === "function") {
        systemPrompt.section({ name: "dafeiyu:vision", order: 10100, text: GUIDANCE });
        probe.section = "registered";
      } else {
        probe.section = "no-systemPrompt";
      }
    } catch (error) {
      probe.section = `threw: ${String(error?.message ?? error).slice(0, 80)}`;
    }
    try {
      const tools = ctx.get?.("tools", true);
      if (tools && typeof tools.register === "function") {
        tools.register(recognizeImageTool(service));
        probe.tool = "registered";
      } else {
        probe.tool = "no-tools";
      }
    } catch (error) {
      probe.tool = `threw: ${String(error?.message ?? error).slice(0, 80)}`;
    }
  } else {
    probe.section = "disabled";
    probe.tool = "disabled";
  }
  const stop = () => {
    if (stopped) return;
    stopped = true;
    const off = unregister;
    unregister = void 0;
    try {
      off?.();
    } catch {
    }
    if (started) deps.log("\u8BC6\u56FE\u8DEF\u7531\u5DF2\u505C");
    void service.dispose().catch(() => void 0);
  };
  return {
    stop,
    probe,
    service,
    get available() {
      return !stopped && started && probe.routes === "registered";
    }
  };
}
var MIME_BY_EXT = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp"
};
function mimeOf(file) {
  const ext = String(file).split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "image/png";
}
function recognizeImageTool(service) {
  return {
    name: "recognize_image",
    description: "\u628A\u4E00\u5F20\u672C\u5730\u56FE\u7247\u4EA4\u7ED9\u5916\u6302\u89C6\u89C9\u6A21\u578B\uFF0C\u8FD4\u56DE\u56FE\u7247\u5185\u5BB9\u7684\u8BE6\u7EC6\u6587\u672C\u63CF\u8FF0\uFF08\u542B\u6587\u5B57\u8F6C\u5F55\uFF09\u3002\u7528\u4E8E\u770B\u622A\u56FE\u3001\u7167\u7247\u3001\u56FE\u8868\u3001UI\u3001\u62A5\u9519\u622A\u56FE\u7B49\u3002",
    parameters: {
      type: "object",
      properties: {
        image_path: { type: "string", description: "\u56FE\u7247\u6587\u4EF6\u7684\u7EDD\u5BF9\u8DEF\u5F84" },
        prompt: { type: "string", description: "\u53EF\u9009\uFF1A\u672C\u6B21\u8BC6\u56FE\u7684\u5177\u4F53\u6307\u4EE4\uFF0C\u8986\u76D6\u9ED8\u8BA4\u8BC6\u56FE\u63D0\u793A\u8BCD" }
      },
      required: ["image_path"]
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: String(value) }]
    },
    timeoutMs: 12e4,
    async execute(args) {
      const file = typeof args.image_path === "string" ? args.image_path : "";
      if (file === "") throw new Error("\u9700\u8981\u56FE\u7247\u7684\u7EDD\u5BF9\u8DEF\u5F84\uFF08image_path\uFF09");
      const { readFile } = await import("node:fs/promises");
      const data = await readFile(file);
      if (data.byteLength === 0) throw new Error(`\u56FE\u7247\u6587\u4EF6\u662F\u7A7A\u7684\uFF1A${file}`);
      if (data.byteLength > 20 * 1024 * 1024) throw new Error(`\u56FE\u7247\u592A\u5927\uFF08>20MB\uFF09\uFF1A${file}`);
      return service.recognize({
        base64: data.toString("base64"),
        mime: mimeOf(file),
        prompt: typeof args.prompt === "string" ? args.prompt : void 0
      });
    }
  };
}

// src/xyq/start.ts
import path7 from "node:path";

// src/xyq/config.ts
import fs4 from "node:fs";
import path5 from "node:path";

// src/paths.ts
import path4 from "node:path";
function resolveDshHome(env = process.env) {
  const explicit = (env.DSH_HOME ?? "").trim();
  if (explicit !== "") return explicit;
  const home = (env.USERPROFILE ?? env.HOME ?? "").trim();
  return home === "" ? "" : path4.join(home, ".dsh");
}

// src/xyq/config.ts
var DEFAULTS = {
  version: 1,
  enabled: true,
  accessKey: "",
  defaultVideoModel: "Seedance_2.0_mini_lite",
  defaultVideoDurationSec: 4,
  defaultImageModel: "",
  budget: { images: 10, videos: 2, maxVideoSeconds: 10 },
  freedom: "explicit"
};
function resolveXyqConfigFile(dshHome = resolveDshHome(process.env)) {
  return path5.join(dshHome, "storages", "dsh-remote-dafeiyu", "xyq.json");
}
function clampInt(value, min, max, fallback) {
  const num = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, num));
}
function normalizeXyqConfig(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const budget = value.budget && typeof value.budget === "object" ? value.budget : {};
  const freedom = value.freedom === "budgeted" || value.freedom === "open" ? value.freedom : "explicit";
  const duration = clampInt(value.defaultVideoDurationSec, 4, 30, DEFAULTS.defaultVideoDurationSec);
  return {
    version: 1,
    enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULTS.enabled,
    accessKey: typeof value.accessKey === "string" ? value.accessKey.trim() : "",
    defaultVideoModel: typeof value.defaultVideoModel === "string" && value.defaultVideoModel.trim() !== "" ? value.defaultVideoModel.trim() : DEFAULTS.defaultVideoModel,
    defaultVideoDurationSec: duration,
    defaultImageModel: typeof value.defaultImageModel === "string" ? value.defaultImageModel.trim() : "",
    budget: {
      images: clampInt(budget.images, 0, 200, DEFAULTS.budget.images),
      videos: clampInt(budget.videos, 0, 50, DEFAULTS.budget.videos),
      maxVideoSeconds: clampInt(budget.maxVideoSeconds, 4, 30, DEFAULTS.budget.maxVideoSeconds)
    },
    freedom
  };
}
function readXyqConfig(file) {
  try {
    return normalizeXyqConfig(JSON.parse(fs4.readFileSync(file, "utf8")));
  } catch {
    return { ...DEFAULTS, budget: { ...DEFAULTS.budget } };
  }
}
function writeXyqConfig(file, patch) {
  const next = normalizeXyqConfig({ ...readXyqConfig(file), ...patch });
  try {
    fs4.mkdirSync(path5.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs4.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}
`, "utf8");
    fs4.renameSync(tmp, file);
  } catch {
  }
  return next;
}
function viewXyqConfig(config) {
  const key = config.accessKey;
  return {
    enabled: config.enabled,
    accessKeySet: key !== "",
    accessKeyHint: key === "" ? "" : `\u2026${key.slice(-4)}`,
    defaultVideoModel: config.defaultVideoModel,
    defaultVideoDurationSec: config.defaultVideoDurationSec,
    defaultImageModel: config.defaultImageModel,
    budget: config.budget,
    freedom: config.freedom
  };
}

// src/xyq/service.ts
function parseJson(text) {
  const trimmed = text.trim();
  if (trimmed === "") return void 0;
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).filter((line) => line.trim() !== "");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        return JSON.parse(lines[i]);
      } catch {
      }
    }
    return void 0;
  }
}
function authMessage(text) {
  if (/登录凭证|XYQ_ACCESS_KEY|未授权|unauthorized|401|403/i.test(text)) {
    return "\u5C0F\u4E91\u96C0 Access Key \u5DF2\u8FC7\u671F\u6216\u65E0\u6548\u3002\u8BF7\u5230\u5C0F\u4E91\u96C0\u5B98\u7F51 \u2192 \u26A1CLI/API \u2192 API \u2192 \u7BA1\u7406 Access Key \u66F4\u65B0\u540E\uFF0C\u5728\u300C\u5927\u80A5\u9C7C \u2192 \u5C0F\u4E91\u96C0\u300D\u91CC\u91CD\u65B0\u586B\u5199\u3002";
  }
  return void 0;
}
function createXyqService(deps) {
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pollInterval = deps.pollIntervalMs ?? 5e3;
  const videoTimeout = deps.videoTimeoutMs ?? 15 * 6e4;
  const imageTimeout = deps.imageTimeoutMs ?? 6 * 6e4;
  const budgets = /* @__PURE__ */ new Map();
  const readConfig = () => readXyqConfig(deps.configFile);
  function budgetOf(sessionKey) {
    const current = budgets.get(sessionKey);
    if (current) return current;
    const fresh = { images: 0, videos: 0 };
    budgets.set(sessionKey, fresh);
    return fresh;
  }
  async function call(args, timeoutMs) {
    const config = readConfig();
    if (!config.enabled) return { result: { code: -1, stdout: "", stderr: "", timedOut: false }, message: "\u5C0F\u4E91\u96C0\u80FD\u529B\u5DF2\u5173\u95ED\uFF08\u8BBE\u7F6E\u9875 \u2192 \u5927\u80A5\u9C7C \u2192 \u5C0F\u4E91\u96C0\uFF09" };
    if (config.accessKey === "") {
      return {
        result: { code: -1, stdout: "", stderr: "", timedOut: false },
        message: "\u8FD8\u6CA1\u586B\u5C0F\u4E91\u96C0 Access Key\u3002\u8BF7\u5230\u5C0F\u4E91\u96C0\u5B98\u7F51 \u2192 \u26A1CLI/API \u2192 API \u2192 \u7BA1\u7406 Access Key \u65B0\u5EFA\uFF0C\u7136\u540E\u586B\u5230\u300C\u5927\u80A5\u9C7C \u2192 \u5C0F\u4E91\u96C0\u300D\u91CC\u3002"
      };
    }
    const cli = await deps.resolveCli();
    if (cli === void 0) {
      return {
        result: { code: -1, stdout: "", stderr: "", timedOut: false },
        message: "\u6CA1\u627E\u5230 pippit-tool-cli\uFF0C\u81EA\u52A8\u5B89\u88C5\u4E5F\u5931\u8D25\u4E86\u3002\u8BF7\u5148\u5728\u7EC8\u7AEF\u8FD0\u884C `npx @pippit-dev/cli@latest install`\uFF0C\u518D\u91CD\u8BD5\u3002"
      };
    }
    const result = await deps.run([cli, ...args], { env: { XYQ_ACCESS_KEY: config.accessKey }, timeoutMs });
    const combined = `${result.stdout}
${result.stderr}`;
    const auth = authMessage(combined);
    if (auth !== void 0) return { result, message: auth };
    const modelMissing = combined.match(/未找到可用模型[^\n]*/);
    if (modelMissing) return { result, message: modelMissing[0].trim() };
    const json3 = parseJson(result.stdout);
    if (result.timedOut) return { result, message: `\u5C0F\u4E91\u96C0\u547D\u4EE4\u8D85\u65F6\uFF08${Math.round(timeoutMs / 1e3)} \u79D2\uFF09` };
    if (json3 === void 0) {
      const reason = result.stderr.trim() !== "" ? result.stderr.trim() : result.stdout.trim();
      return { result, message: reason !== "" ? `\u5C0F\u4E91\u96C0\u8FD4\u56DE\u4E86\u65E0\u6CD5\u89E3\u6790\u7684\u5185\u5BB9\uFF1A${reason.slice(0, 200)}` : "\u5C0F\u4E91\u96C0\u6CA1\u6709\u8FD4\u56DE\u5185\u5BB9" };
    }
    return { result, json: json3 };
  }
  async function poll(threadId, runId, outDir, timeoutMs) {
    const started = (deps.now ?? Date.now)();
    for (; ; ) {
      const answered = await call(
        ["query-result", "--thread-id", threadId, "--run-id", runId, "--download-dir", outDir],
        Math.max(3e4, timeoutMs)
      );
      if (answered.message !== void 0) return { ok: false, files: [], message: answered.message };
      const json3 = answered.json ?? {};
      const status = typeof json3.status === "string" ? json3.status : "unknown";
      if (json3.error_message !== void 0 && String(json3.error_message).trim() !== "") {
        return { ok: false, files: [], status, message: `\u5C0F\u4E91\u96C0\u4EFB\u52A1\u5931\u8D25\uFF1A${String(json3.error_message).slice(0, 200)}` };
      }
      if (status === "succeeded") {
        const files = [];
        for (const key of ["videos", "images"]) {
          const list = Array.isArray(json3[key]) ? json3[key] : [];
          for (const item of list) {
            if (typeof item.output_path === "string" && item.output_path !== "") files.push(item.output_path);
          }
        }
        return { ok: true, files, status };
      }
      if (status === "failed" || status === "canceled" || status === "interrupted") {
        return { ok: false, files: [], status, message: `\u5C0F\u4E91\u96C0\u4EFB\u52A1${status === "canceled" ? "\u88AB\u53D6\u6D88" : "\u5931\u8D25"}\u4E86` };
      }
      if ((deps.now ?? Date.now)() - started > timeoutMs) {
        return { ok: false, files: [], status, message: `\u7B49\u5C0F\u4E91\u96C0\u51FA\u7247\u8D85\u65F6\uFF08${Math.round(timeoutMs / 6e4)} \u5206\u949F\uFF09\uFF0C\u4EFB\u52A1\u8FD8\u5728\u8DD1\uFF1B\u7A0D\u540E\u53EF\u4EE5\u7528 thread_id/run_id \u7EE7\u7EED\u67E5\uFF1A${threadId} / ${runId}` };
      }
      await sleep(pollInterval);
    }
  }
  return {
    config: readConfig,
    view: () => viewXyqConfig(readConfig()),
    update: (patch) => viewXyqConfig(writeXyqConfig(deps.configFile, patch)),
    async status() {
      const answered = await call(["status"], 3e4);
      if (answered.message !== void 0) return { ok: false, message: answered.message };
      const json3 = answered.json ?? {};
      return {
        ok: true,
        loggedIn: json3.logged_in === true,
        source: typeof json3.source === "string" ? json3.source : "",
        ...json3.logged_in === true ? {} : { message: "Access Key \u672A\u751F\u6548\uFF0C\u8BF7\u68C0\u67E5\u662F\u5426\u8FC7\u671F" }
      };
    },
    async balance() {
      const answered = await call(["get-credit-balance"], 3e4);
      if (answered.message !== void 0) return { ok: false, message: answered.message };
      const json3 = answered.json ?? {};
      return { ok: true, totalRemain: typeof json3.total_remain_amount === "string" ? json3.total_remain_amount : String(json3.total_remain_amount ?? "") };
    },
    async models(kind) {
      const answered = await call(["model", "list", "--type", kind], 6e4);
      if (answered.message !== void 0) return { ok: false, message: answered.message };
      const json3 = answered.json ?? {};
      const list = Array.isArray(json3.models) ? json3.models : [];
      return {
        ok: true,
        models: list.filter((row) => typeof row.name === "string" && String(row.name).trim() !== "").map((row) => ({
          // 生图模型只有 name（CLI 就用完整名称）；生视频模型有 key（提交要用 key）。
          key: typeof row.key === "string" && row.key !== "" ? String(row.key) : String(row.name),
          name: String(row.name)
        }))
      };
    },
    async generateImage(input) {
      const config = readConfig();
      const sessionKey = input.sessionKey ?? "default";
      const budget = budgetOf(sessionKey);
      if (config.budget.images > 0 && budget.images >= config.budget.images) {
        return { ok: false, message: `\u672C\u4F1A\u8BDD\u7684\u751F\u56FE\u989D\u5EA6\u5DF2\u7528\u5B8C\uFF08\u4E0A\u9650 ${config.budget.images} \u5F20\uFF0C\u53EF\u5728\u300C\u5927\u80A5\u9C7C \u2192 \u5C0F\u4E91\u96C0\u300D\u91CC\u8C03\u6574\uFF09` };
      }
      const model = (input.model ?? config.defaultImageModel).trim();
      if (model === "") {
        return { ok: false, message: "\u6CA1\u6307\u5B9A\u56FE\u7247\u6A21\u578B\u3002\u5148\u7528 `model list --type image` \u67E5\u53EF\u7528\u6A21\u578B\uFF0C\u6216\u5728\u300C\u5927\u80A5\u9C7C \u2192 \u5C0F\u4E91\u96C0\u300D\u91CC\u8BBE\u9ED8\u8BA4\u56FE\u7247\u6A21\u578B\u3002" };
      }
      const args = ["generate-image", "--prompt", input.prompt, "--model", model];
      for (const image of input.images ?? []) {
        if (typeof image === "string" && image !== "") args.push("--image", image);
      }
      if (typeof input.ratio === "string" && input.ratio !== "") args.push("--ratio", input.ratio);
      if (typeof input.count === "number" && Number.isFinite(input.count) && input.count > 0) args.push("--generate-image-count", String(Math.round(input.count)));
      const submitted = await call(args, 12e4);
      if (submitted.message !== void 0) return { ok: false, message: submitted.message };
      const json3 = submitted.json ?? {};
      const threadId = typeof json3.thread_id === "string" ? json3.thread_id : "";
      const runId = typeof json3.run_id === "string" ? json3.run_id : "";
      if (threadId === "" || runId === "") return { ok: false, message: "\u5C0F\u4E91\u96C0\u6CA1\u6709\u8FD4\u56DE thread_id / run_id\uFF0C\u751F\u6210\u672A\u63D0\u4EA4\u6210\u529F" };
      budget.images += 1;
      const outDir = input.outDir ?? "xyq_output";
      const polled = await poll(threadId, runId, outDir, imageTimeout);
      return {
        ok: polled.ok,
        ...polled.ok ? {} : { message: polled.message },
        threadId,
        runId,
        files: polled.files,
        ...typeof json3.web_thread_link === "string" ? { webLink: json3.web_thread_link } : {}
      };
    },
    /** UI 用：只提交生图任务，返回 thread/run（结果由 queryOnce 轮询）。 */
    async startImage(input) {
      const config = readConfig();
      const budget = budgetOf(input.sessionKey ?? "default");
      if (config.budget.images > 0 && budget.images >= config.budget.images) {
        return { ok: false, message: `\u672C\u4F1A\u8BDD\u7684\u751F\u56FE\u989D\u5EA6\u5DF2\u7528\u5B8C\uFF08\u4E0A\u9650 ${config.budget.images} \u5F20\uFF09` };
      }
      if (input.model.trim() === "") return { ok: false, message: "\u6CA1\u6307\u5B9A\u56FE\u7247\u6A21\u578B" };
      const args = ["generate-image", "--prompt", input.prompt, "--model", input.model];
      for (const image of input.images ?? []) if (image !== "") args.push("--image", image);
      if (typeof input.ratio === "string" && input.ratio !== "") args.push("--ratio", input.ratio);
      if (typeof input.resolution === "string" && input.resolution !== "") args.push("--resolution", input.resolution);
      if (typeof input.count === "number" && input.count > 0) args.push("--generate-image-count", String(Math.round(input.count)));
      const submitted = await call(args, 12e4);
      if (submitted.message !== void 0) return { ok: false, message: submitted.message };
      const json3 = submitted.json ?? {};
      const threadId = typeof json3.thread_id === "string" ? json3.thread_id : "";
      const runId = typeof json3.run_id === "string" ? json3.run_id : "";
      if (threadId === "" || runId === "") return { ok: false, message: "\u5C0F\u4E91\u96C0\u6CA1\u6709\u8FD4\u56DE thread_id / run_id" };
      budget.images += 1;
      return { ok: true, threadId, runId, ...typeof json3.web_thread_link === "string" ? { webLink: json3.web_thread_link } : {} };
    },
    /** UI 用：只提交生视频任务。 */
    async startVideo(input) {
      const config = readConfig();
      const budget = budgetOf(input.sessionKey ?? "default");
      if (config.budget.videos > 0 && budget.videos >= config.budget.videos) {
        return { ok: false, message: `\u672C\u4F1A\u8BDD\u7684\u89C6\u9891\u989D\u5EA6\u5DF2\u7528\u5B8C\uFF08\u4E0A\u9650 ${config.budget.videos} \u6761\uFF09` };
      }
      if (input.model.trim() === "") return { ok: false, message: "\u6CA1\u6307\u5B9A\u89C6\u9891\u6A21\u578B" };
      const duration = Math.min(config.budget.maxVideoSeconds, Math.max(4, Math.round(input.duration ?? config.defaultVideoDurationSec)));
      const args = ["generate-video", "--model", input.model, "--prompt", input.prompt, "--duration", String(duration)];
      for (const image of input.images ?? []) if (image !== "") args.push("--image", image);
      if (typeof input.ratio === "string" && input.ratio !== "" && input.ratio !== "adaptive") args.push("--ratio", input.ratio);
      if (typeof input.resolution === "string" && input.resolution !== "") args.push("--resolution", input.resolution);
      args.push("--task-type", "reference");
      const submitted = await call(args, 18e4);
      if (submitted.message !== void 0) return { ok: false, message: submitted.message };
      const json3 = submitted.json ?? {};
      const threadId = typeof json3.thread_id === "string" ? json3.thread_id : "";
      const runId = typeof json3.run_id === "string" ? json3.run_id : "";
      if (threadId === "" || runId === "") return { ok: false, message: "\u5C0F\u4E91\u96C0\u6CA1\u6709\u8FD4\u56DE thread_id / run_id" };
      budget.videos += 1;
      return { ok: true, threadId, runId, ...typeof json3.web_thread_link === "string" ? { webLink: json3.web_thread_link } : {} };
    },
    /** UI 用：查一次任务状态（不轮询、不阻塞）。 */
    async queryOnce(threadId, runId, outDir) {
      const answered = await call(
        ["query-result", "--thread-id", threadId, "--run-id", runId, "--download-dir", outDir],
        12e4
      );
      if (answered.message !== void 0) return { ok: false, message: answered.message };
      const json3 = answered.json ?? {};
      const status = typeof json3.status === "string" ? json3.status : "unknown";
      if (typeof json3.error_message === "string" && json3.error_message !== "") {
        return { ok: false, status, message: `\u5C0F\u4E91\u96C0\u4EFB\u52A1\u5931\u8D25\uFF1A${json3.error_message.slice(0, 200)}` };
      }
      if (status !== "succeeded") return { ok: true, status };
      const files = [];
      for (const key of ["videos", "images"]) {
        const list = Array.isArray(json3[key]) ? json3[key] : [];
        for (const item of list) {
          if (typeof item.output_path === "string" && item.output_path !== "") files.push(item.output_path);
        }
      }
      return { ok: true, status, files };
    },
    /** 模型详情（比例/分辨率/时长等），给设置面板的下拉框用。 */
    async describe(name, kind) {
      const answered = await call(["model", "describe", name, "--type", kind], 6e4);
      if (answered.message !== void 0) return { ok: false, message: answered.message };
      const json3 = answered.json ?? {};
      const model = json3.model && typeof json3.model === "object" ? json3.model : void 0;
      if (model === void 0) return { ok: false, message: "\u6CA1\u6709\u62FF\u5230\u6A21\u578B\u8BE6\u60C5" };
      return { ok: true, model };
    },
    async generateVideo(input) {
      const config = readConfig();
      const sessionKey = input.sessionKey ?? "default";
      const budget = budgetOf(sessionKey);
      if (config.budget.videos > 0 && budget.videos >= config.budget.videos) {
        return { ok: false, message: `\u672C\u4F1A\u8BDD\u7684\u89C6\u9891\u989D\u5EA6\u5DF2\u7528\u5B8C\uFF08\u4E0A\u9650 ${config.budget.videos} \u6761\uFF0C\u53EF\u5728\u300C\u5927\u80A5\u9C7C \u2192 \u5C0F\u4E91\u96C0\u300D\u91CC\u8C03\u6574\uFF09` };
      }
      const model = (input.model ?? config.defaultVideoModel).trim();
      if (model === "") return { ok: false, message: "\u6CA1\u6307\u5B9A\u89C6\u9891\u6A21\u578B\uFF08\u9ED8\u8BA4 Seedance_2.0_mini_lite\uFF0C\u53EF\u5728\u8BBE\u7F6E\u91CC\u6539\uFF09" };
      const duration = Math.min(config.budget.maxVideoSeconds, Math.max(4, Math.round(input.duration ?? config.defaultVideoDurationSec)));
      const args = ["generate-video", "--model", model, "--prompt", input.prompt, "--duration", String(duration)];
      for (const image of input.images ?? []) {
        if (typeof image === "string" && image !== "") args.push("--image", image);
      }
      if (typeof input.ratio === "string" && input.ratio !== "") args.push("--ratio", input.ratio);
      args.push("--task-type", "reference");
      const submitted = await call(args, 18e4);
      if (submitted.message !== void 0) return { ok: false, message: submitted.message };
      const json3 = submitted.json ?? {};
      const threadId = typeof json3.thread_id === "string" ? json3.thread_id : "";
      const runId = typeof json3.run_id === "string" ? json3.run_id : "";
      if (threadId === "" || runId === "") return { ok: false, message: "\u5C0F\u4E91\u96C0\u6CA1\u6709\u8FD4\u56DE thread_id / run_id\uFF0C\u751F\u6210\u672A\u63D0\u4EA4\u6210\u529F" };
      budget.videos += 1;
      const outDir = input.outDir ?? "xyq_output";
      const polled = await poll(threadId, runId, outDir, videoTimeout);
      return {
        ok: polled.ok,
        ...polled.ok ? {} : { message: polled.message },
        threadId,
        runId,
        files: polled.files,
        ...typeof json3.web_thread_link === "string" ? { webLink: json3.web_thread_link } : {}
      };
    }
  };
}

// src/xyq/routes.ts
var XYQ_CONFIG_ROUTE = "/api/dsh-remote-dafeiyu/xyq/config";
var XYQ_STATUS_ROUTE = "/api/dsh-remote-dafeiyu/xyq/status";
var XYQ_BALANCE_ROUTE = "/api/dsh-remote-dafeiyu/xyq/balance";
var XYQ_MODELS_ROUTE = "/api/dsh-remote-dafeiyu/xyq/models";
var XYQ_DESCRIBE_ROUTE = "/api/dsh-remote-dafeiyu/xyq/describe";
var XYQ_GENERATE_ROUTE = "/api/dsh-remote-dafeiyu/xyq/generate";
var XYQ_RESULT_ROUTE = "/api/dsh-remote-dafeiyu/xyq/result";
var XYQ_FILE_ROUTE = "/api/dsh-remote-dafeiyu/xyq/file";
function json2(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  response.end(payload);
}
function rejected2(request) {
  if (!hostIsLoopback(request.headers.host)) return "host-not-loopback";
  if (!originIsLoopbackOrAbsent(request.headers.origin)) return "origin-not-trusted";
  return void 0;
}
function readBody2(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.byteLength;
      if (size > 16 * 1024) {
        reject(new Error("\u8BF7\u6C42\u4F53\u592A\u5927"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}
function xyqConfigHandler(deps) {
  return async (request, response) => {
    applyCors(request, response);
    if (preflight(request, response)) return;
    const denied = rejected2(request);
    if (denied) {
      json2(response, 403, { ok: false, error: denied });
      return;
    }
    if (request.method === "GET" || request.method === "HEAD") {
      json2(response, 200, { ok: true, config: deps.service.view() });
      return;
    }
    if (request.method !== "POST") {
      json2(response, 405, { ok: false, error: "\u53EA\u652F\u6301 GET / POST" });
      return;
    }
    if (String(request.headers["x-drc-pair"] ?? "") === "") {
      json2(response, 403, { ok: false, error: "missing x-drc-pair" });
      return;
    }
    try {
      const body = JSON.parse(await readBody2(request));
      json2(response, 200, { ok: true, config: deps.service.update(body) });
    } catch (error) {
      json2(response, 400, { ok: false, error: String(error?.message ?? error).slice(0, 200) });
    }
  };
}
function xyqQueryHandler(kind, deps) {
  return async (request, response) => {
    applyCors(request, response);
    if (preflight(request, response)) return;
    const denied = rejected2(request);
    if (denied) {
      json2(response, 403, { ok: false, error: denied });
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      json2(response, 405, { ok: false, error: "\u53EA\u652F\u6301 GET" });
      return;
    }
    try {
      if (kind === "status") {
        json2(response, 200, await deps.service.status());
        return;
      }
      if (kind === "balance") {
        json2(response, 200, await deps.service.balance());
        return;
      }
      const url = new URL(request.url ?? "/", "http://localhost");
      const type = url.searchParams.get("type") === "image" ? "image" : "video";
      json2(response, 200, await deps.service.models(type));
    } catch (error) {
      deps.log("\u5C0F\u4E91\u96C0\u67E5\u8BE2\u8DEF\u7531\u5931\u8D25", { kind, message: String(error?.message ?? error).slice(0, 160) });
      json2(response, 500, { ok: false, error: String(error?.message ?? error).slice(0, 200) });
    }
  };
}
function xyqDescribeHandler(deps) {
  return async (request, response) => {
    applyCors(request, response);
    if (preflight(request, response)) return;
    const denied = rejected2(request);
    if (denied) return json2(response, 403, { ok: false, error: denied });
    if (request.method !== "GET" && request.method !== "HEAD") return json2(response, 405, { ok: false, error: "\u53EA\u652F\u6301 GET" });
    const url = new URL(request.url ?? "/", "http://localhost");
    const name = (url.searchParams.get("name") ?? "").trim();
    const type = url.searchParams.get("type") === "video" ? "video" : "image";
    if (name === "") return json2(response, 400, { ok: false, error: "\u7F3A\u5C11 name" });
    try {
      json2(response, 200, await deps.service.describe(name, type));
    } catch (error) {
      json2(response, 500, { ok: false, error: String(error?.message ?? error).slice(0, 200) });
    }
  };
}
function xyqGenerateHandler(deps) {
  return async (request, response) => {
    applyCors(request, response);
    if (preflight(request, response)) return;
    const denied = rejected2(request);
    if (denied) return json2(response, 403, { ok: false, error: denied });
    if (request.method !== "POST") return json2(response, 405, { ok: false, error: "\u53EA\u652F\u6301 POST" });
    if (String(request.headers["x-drc-pair"] ?? "") === "") return json2(response, 403, { ok: false, error: "missing x-drc-pair" });
    try {
      const body = JSON.parse(await readBody2(request));
      const type = body.type === "video" ? "video" : "image";
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      const model = typeof body.model === "string" ? body.model.trim() : "";
      if (prompt === "" || model === "") return json2(response, 400, { ok: false, error: "prompt \u4E0E model \u5FC5\u586B" });
      try {
        const { mkdirSync: mkdirSync2 } = await import("node:fs");
        mkdirSync2(deps.outDir, { recursive: true });
      } catch {
      }
      const sessionKey = typeof body.sessionKey === "string" && body.sessionKey !== "" ? body.sessionKey : "xyq-panel";
      const result = type === "video" ? await deps.service.startVideo({
        prompt,
        model,
        sessionKey,
        ...typeof body.duration === "number" ? { duration: body.duration } : {},
        ...typeof body.ratio === "string" ? { ratio: body.ratio } : {},
        ...typeof body.resolution === "string" ? { resolution: body.resolution } : {}
      }) : await deps.service.startImage({
        prompt,
        model,
        sessionKey,
        ...typeof body.ratio === "string" ? { ratio: body.ratio } : {},
        ...typeof body.resolution === "string" ? { resolution: body.resolution } : {},
        ...typeof body.count === "number" ? { count: body.count } : {}
      });
      json2(response, result.ok ? 200 : 502, result);
    } catch (error) {
      json2(response, 400, { ok: false, error: String(error?.message ?? error).slice(0, 200) });
    }
  };
}
function xyqResultHandler(deps) {
  return async (request, response) => {
    applyCors(request, response);
    if (preflight(request, response)) return;
    const denied = rejected2(request);
    if (denied) return json2(response, 403, { ok: false, error: denied });
    if (request.method !== "GET" && request.method !== "HEAD") return json2(response, 405, { ok: false, error: "\u53EA\u652F\u6301 GET" });
    const url = new URL(request.url ?? "/", "http://localhost");
    const threadId = (url.searchParams.get("threadId") ?? "").trim();
    const runId = (url.searchParams.get("runId") ?? "").trim();
    if (threadId === "" || runId === "") return json2(response, 400, { ok: false, error: "\u7F3A\u5C11 threadId / runId" });
    try {
      json2(response, 200, await deps.service.queryOnce(threadId, runId, deps.outDir));
    } catch (error) {
      json2(response, 500, { ok: false, error: String(error?.message ?? error).slice(0, 200) });
    }
  };
}
function xyqFileHandler(deps) {
  return async (request, response) => {
    applyCors(request, response);
    if (preflight(request, response)) return;
    const denied = rejected2(request);
    if (denied) return json2(response, 403, { ok: false, error: denied });
    if (request.method !== "GET" && request.method !== "HEAD") return json2(response, 405, { ok: false, error: "\u53EA\u652F\u6301 GET" });
    const url = new URL(request.url ?? "/", "http://localhost");
    const target = (url.searchParams.get("path") ?? "").trim();
    if (target === "") return json2(response, 400, { ok: false, error: "\u7F3A\u5C11 path" });
    const path8 = await import("node:path");
    const fs6 = await import("node:fs");
    const resolved = path8.resolve(target);
    const root = path8.resolve(deps.outDir);
    if (!resolved.startsWith(root + path8.sep)) return json2(response, 403, { ok: false, error: "path-escape" });
    try {
      const data = fs6.readFileSync(resolved);
      const ext = path8.extname(resolved).toLowerCase();
      const mime = ext === ".mp4" ? "video/mp4" : ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "application/octet-stream";
      response.writeHead(200, { "Content-Type": mime, "Content-Length": data.byteLength });
      if (request.method === "HEAD") response.end();
      else response.end(data);
    } catch {
      json2(response, 404, { ok: false, error: "\u6587\u4EF6\u4E0D\u5B58\u5728" });
    }
  };
}

// src/xyq/tools.ts
function sessionKeyOf(exec) {
  const record = exec && typeof exec === "object" ? exec : void 0;
  const agent = record?.agent && typeof record.agent === "object" ? record.agent : void 0;
  const session = agent?.session && typeof agent.session === "object" ? agent.session : void 0;
  const id = session?.id ?? record?.sessionId ?? record?.session;
  return typeof id === "string" && id !== "" ? id : "default";
}
function resultText(result) {
  if (!result.ok) return `\u751F\u6210\u5931\u8D25\uFF1A${result.message ?? "\u672A\u77E5\u539F\u56E0"}`;
  const files = result.files ?? [];
  const lines = [`\u751F\u6210\u5B8C\u6210\uFF0C${files.length} \u4E2A\u6587\u4EF6\uFF1A`, ...files.map((file) => `- ${file}`)];
  if (result.webLink !== void 0) lines.push(`\u5728\u7EBF\u67E5\u770B\uFF1A${result.webLink}`);
  if (result.threadId !== void 0) lines.push(`\u4EFB\u52A1\uFF1A${result.threadId}`);
  return lines.join("\n");
}
function xyqTools(service) {
  return [
    {
      name: "generate_image",
      description: "\u7528\u5C0F\u4E91\u96C0\u751F\u6210/\u7F16\u8F91\u56FE\u7247\u3002prompt \u5FC5\u987B\u662F\u7528\u6237\u539F\u59CB\u63CF\u8FF0\uFF1B\u53EF\u4F20\u53C2\u8003\u56FE\uFF08\u672C\u5730\u7EDD\u5BF9\u8DEF\u5F84\uFF09\u3002\u6309\u5F20\u6D88\u8017\u79EF\u5206\u3002\u7528\u6237\u6CA1\u6709\u660E\u786E\u8981\u6C42\u753B\u56FE\u65F6\u4E0D\u8981\u8C03\u7528\u3002",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "\u56FE\u7247\u63CF\u8FF0\uFF08\u7528\u6237\u539F\u8BDD\uFF0C\u4E0D\u8981\u6269\u5199\uFF09" },
          model: { type: "string", description: "\u56FE\u7247\u6A21\u578B\u5B8C\u6574\u540D\u79F0\uFF08\u5148\u7528 xyq_models \u67E5 image \u5217\u8868\uFF09\uFF1B\u4E0D\u4F20\u5219\u7528\u8BBE\u7F6E\u91CC\u7684\u9ED8\u8BA4\u503C" },
          images: { type: "array", items: { type: "string" }, description: "\u53C2\u8003\u56FE\u672C\u5730\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u53EF\u591A\u5F20" },
          ratio: { type: "string", description: "\u6BD4\u4F8B\uFF08\u6A21\u578B\u8FD4\u56DE\u7684\u6570\u5B57\u679A\u4E3E\uFF0C\u5982 3 \u8868\u793A 9:16\uFF09" },
          count: { type: "number", description: "\u751F\u6210\u6570\u91CF\uFF08\u53EF\u9009\uFF09" },
          outDir: { type: "string", description: "\u4E0B\u8F7D\u76EE\u5F55\uFF1B\u9ED8\u8BA4 xyq_output" }
        },
        required: ["prompt"]
      },
      output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
      timeoutMs: 10 * 6e4,
      async execute(args, exec) {
        const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
        if (prompt === "") throw new Error("\u9700\u8981 prompt\uFF08\u7528\u6237\u539F\u59CB\u63CF\u8FF0\uFF09");
        const images = Array.isArray(args.images) ? args.images.filter((value) => typeof value === "string" && value !== "") : [];
        const result = await service.generateImage({
          prompt,
          ...typeof args.model === "string" && args.model !== "" ? { model: args.model } : {},
          images,
          ...typeof args.ratio === "string" && args.ratio !== "" ? { ratio: args.ratio } : {},
          ...typeof args.count === "number" ? { count: args.count } : {},
          ...typeof args.outDir === "string" && args.outDir !== "" ? { outDir: args.outDir } : {},
          sessionKey: sessionKeyOf(exec)
        });
        if (!result.ok) throw new Error(result.message ?? "\u751F\u6210\u5931\u8D25");
        return resultText(result);
      }
    },
    {
      name: "generate_video",
      description: "\u7528\u5C0F\u4E91\u96C0\u751F\u6210\u89C6\u9891\uFF08\u652F\u6301\u53C2\u8003\u56FE/\u9996\u5C3E\u5E27\uFF09\u3002\u6309\u65F6\u957F\u8BA1\u8D39\uFF08Seedance 2.0 Mini \u4F53\u9A8C\u7248\u7EA6 4 \u79EF\u5206/\u79D2\uFF09\u3002\u7528\u6237\u6CA1\u6709\u660E\u786E\u8981\u6C42\u751F\u6210\u89C6\u9891\u65F6\u4E0D\u8981\u8C03\u7528\uFF1B\u65F6\u957F\u4F1A\u88AB\u8BBE\u7F6E\u91CC\u7684\u4E0A\u9650\u622A\u65AD\u3002",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "\u89C6\u9891\u63CF\u8FF0\uFF08\u7528\u6237\u539F\u8BDD\uFF09" },
          model: { type: "string", description: "\u89C6\u9891\u6A21\u578B key\uFF08\u5148\u7528 xyq_models \u67E5 video \u5217\u8868\uFF09\uFF1B\u4E0D\u4F20\u7528\u9ED8\u8BA4 Seedance_2.0_mini_lite" },
          duration: { type: "number", description: "\u65F6\u957F\uFF08\u79D2\uFF0C4~30\uFF0C\u4F1A\u88AB\u8BBE\u7F6E\u4E0A\u9650\u622A\u65AD\uFF09" },
          ratio: { type: "string", description: "\u6BD4\u4F8B\uFF0C\u5982 1:1 / 16:9 / 9:16" },
          images: { type: "array", items: { type: "string" }, description: "\u53C2\u8003\u56FE\u672C\u5730\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u53EF\u591A\u5F20" },
          outDir: { type: "string", description: "\u4E0B\u8F7D\u76EE\u5F55\uFF1B\u9ED8\u8BA4 xyq_output" }
        },
        required: ["prompt"]
      },
      output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
      timeoutMs: 20 * 6e4,
      async execute(args, exec) {
        const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
        if (prompt === "") throw new Error("\u9700\u8981 prompt\uFF08\u7528\u6237\u539F\u59CB\u63CF\u8FF0\uFF09");
        const images = Array.isArray(args.images) ? args.images.filter((value) => typeof value === "string" && value !== "") : [];
        const result = await service.generateVideo({
          prompt,
          ...typeof args.model === "string" && args.model !== "" ? { model: args.model } : {},
          ...typeof args.duration === "number" ? { duration: args.duration } : {},
          ...typeof args.ratio === "string" && args.ratio !== "" ? { ratio: args.ratio } : {},
          images,
          ...typeof args.outDir === "string" && args.outDir !== "" ? { outDir: args.outDir } : {},
          sessionKey: sessionKeyOf(exec)
        });
        if (!result.ok) throw new Error(result.message ?? "\u751F\u6210\u5931\u8D25");
        return resultText(result);
      }
    },
    {
      name: "xyq_balance",
      description: "\u67E5\u8BE2\u5C0F\u4E91\u96C0\u8D26\u6237\u5269\u4F59\u79EF\u5206\u3002\u751F\u6210\u524D\u5148\u67E5\uFF0C\u907F\u514D\u4F59\u989D\u4E0D\u8DB3\u3002",
      parameters: { type: "object", properties: {} },
      output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
      timeoutMs: 6e4,
      async execute() {
        const result = await service.balance();
        if (!result.ok) throw new Error(result.message ?? "\u67E5\u8BE2\u4F59\u989D\u5931\u8D25");
        return `\u5C0F\u4E91\u96C0\u5269\u4F59\u79EF\u5206\uFF1A${result.totalRemain ?? "\u672A\u77E5"}`;
      }
    },
    {
      name: "xyq_models",
      description: "\u67E5\u8BE2\u5C0F\u4E91\u96C0\u53EF\u7528\u6A21\u578B\uFF08type=video \u6216 image\uFF09\u3002\u751F\u56FE/\u751F\u89C6\u9891\u524D\u7528\u5B83\u786E\u8BA4\u6A21\u578B\u540D\u3002",
      parameters: {
        type: "object",
        properties: { type: { type: "string", enum: ["video", "image"], description: "\u6A21\u578B\u7C7B\u578B" } },
        required: ["type"]
      },
      output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
      timeoutMs: 9e4,
      async execute(args) {
        const kind = args.type === "image" ? "image" : "video";
        const result = await service.models(kind);
        if (!result.ok) throw new Error(result.message ?? "\u67E5\u8BE2\u6A21\u578B\u5931\u8D25");
        const list = result.models ?? [];
        return list.length === 0 ? "\uFF08\u6CA1\u6709\u67E5\u5230\u6A21\u578B\uFF09" : list.map((model) => `- ${model.name}\uFF08${model.key}\uFF09`).join("\n");
      }
    }
  ];
}

// src/xyq/cli.ts
import { spawn as spawn2 } from "node:child_process";
import fs5 from "node:fs";
import os2 from "node:os";
import path6 from "node:path";
function platformDir() {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (process.platform === "win32") return `win32-${arch}`;
  if (process.platform === "darwin") return `darwin-${arch}`;
  return `linux-${arch}`;
}
function binaryName() {
  return process.platform === "win32" ? "pippit-tool-cli.exe" : "pippit-tool-cli";
}
function cachedCliCandidates(home = os2.homedir()) {
  const base = path6.join(home, ".cache", "pippit-tool-cli", "xyq-skill", platformDir(), "current");
  return [
    path6.join(base, "node_modules", "@pippit-dev", "cli", "bin", binaryName()),
    path6.join(base, "node_modules", ".bin", binaryName())
  ];
}
function ensureCliScript(home = os2.homedir()) {
  return path6.join(home, ".agents", "skills", "xyq-skill", "scripts", "ensure-cli.js");
}
var defaultCliRunner = (args, options) => new Promise((resolve) => {
  const child = spawn2(cliPathForRun(args), args.slice(1), {
    env: { ...process.env, ...options.env },
    windowsHide: true,
    // 同 sprite/browser.ts 的理由：**别继承宿主的工作目录**。
    // 子进程以某个目录为 cwd 时，Windows 不允许把那个目录改名；DSH 自更新恰恰要把
    // `D:\FeiYu` 改成 `D:\FeiYu.old-*`，一个还活着的子进程就能让安装器连试 10 次
    // `error 32` 后放弃（2026-11-12 现场就是这样）。CLI 跑完就退，但别赌它来得及。
    cwd: os2.tmpdir()
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill();
    } catch {
    }
  }, options.timeoutMs);
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  child.on("error", (error) => {
    clearTimeout(timer);
    resolve({ code: -1, stdout, stderr: `${stderr}${String(error?.message ?? error)}`, timedOut });
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    resolve({ code: code ?? -1, stdout, stderr, timedOut });
  });
});
function cliPathForRun(args) {
  return args[0] ?? "";
}
async function installCli(run, options = {}) {
  const home = options.home ?? os2.homedir();
  const script = ensureCliScript(home);
  if (!fs5.existsSync(script)) return void 0;
  const result = await run([process.execPath, script], { env: {}, timeoutMs: options.timeoutMs ?? 3e5 });
  const lines = result.stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (typeof parsed.cli_path === "string" && parsed.cli_path !== "") return parsed.cli_path;
    } catch {
    }
  }
  return void 0;
}
async function resolveCliPath(run, options = {}) {
  const home = options.home ?? os2.homedir();
  for (const candidate of cachedCliCandidates(home)) {
    if (fs5.existsSync(candidate)) return candidate;
  }
  const installed = await installCli(run, { home });
  if (installed !== void 0 && fs5.existsSync(installed)) {
    options.log?.("\u5C0F\u4E91\u96C0 CLI \u5DF2\u5B89\u88C5", { path: path6.basename(installed) });
    return installed;
  }
  return void 0;
}

// src/xyq/guidance.ts
function xyqGuidance(freedom) {
  const lines = [
    "## \u5C0F\u4E91\u96C0\uFF08\u56FE\u7247 / \u89C6\u9891\u751F\u6210\uFF09",
    "\u672C\u673A\u63A5\u5165\u4E86\u5C0F\u4E91\u96C0\u5B98\u65B9 CLI\uFF0C\u63D0\u4F9B `generate_image`\u3001`generate_video`\u3001`xyq_balance`\u3001`xyq_models` \u56DB\u4E2A\u5DE5\u5177\u3002",
    "\u4F7F\u7528\u987A\u5E8F\uFF1A\u5148 `xyq_models` \u67E5\u6A21\u578B \u2192 `xyq_balance` \u770B\u79EF\u5206 \u2192 \u751F\u6210 \u2192 \u628A\u5DE5\u5177\u8FD4\u56DE\u7684**\u672C\u5730\u6587\u4EF6\u7EDD\u5BF9\u8DEF\u5F84**\u544A\u8BC9\u7528\u6237\u3002",
    "\u6210\u672C\uFF1A\u89C6\u9891\u6309\u65F6\u957F\u8BA1\u8D39\uFF08Seedance 2.0 Mini \u4F53\u9A8C\u7248\u7EA6 4 \u79EF\u5206/\u79D2\uFF09\uFF0C\u56FE\u7247\u6309\u5F20\u8BA1\u8D39\uFF1B\u65F6\u957F\u4F1A\u88AB\u8BBE\u7F6E\u91CC\u7684\u4E0A\u9650\u622A\u65AD\u3002"
  ];
  if (freedom === "explicit") lines.push("\u8C03\u7528\u7EA6\u675F\uFF1A**\u53EA\u6709\u7528\u6237\u660E\u786E\u8981\u6C42\u751F\u6210\u56FE\u7247/\u89C6\u9891\u65F6\u624D\u80FD\u8C03\u7528**\uFF1B\u4E0D\u8981\u4E3A\u4E86\u201C\u7701\u4E8B\u201D\u81EA\u884C\u751F\u6210\u3002");
  else if (freedom === "budgeted") lines.push("\u8C03\u7528\u7EA6\u675F\uFF1A\u5F00\u53D1\u4EFB\u52A1\u9700\u8981\u7D20\u6750\u65F6\u53EF\u4EE5\u81EA\u884C\u8C03\u7528\uFF0C\u4F46\u5FC5\u987B\u53D7\u8BBE\u7F6E\u91CC\u7684\u989D\u5EA6\u4E0E\u65F6\u957F\u4E0A\u9650\u7EA6\u675F\uFF1B\u7528\u5B8C\u5C31\u505C\uFF0C\u4E0D\u8981\u91CD\u590D\u751F\u6210\u3002");
  else lines.push("\u8C03\u7528\u7EA6\u675F\uFF1A\u989D\u5EA6\u5DF2\u653E\u5F00\uFF0C\u81EA\u884C\u5224\u65AD\u662F\u5426\u751F\u6210\uFF1B\u4ECD\u7136\u4E0D\u8981\u91CD\u590D\u751F\u6210\u540C\u4E00\u4E2A\u7D20\u6750\u3002");
  lines.push("Access Key \u8FC7\u671F/\u65E0\u6548\u65F6\u5DE5\u5177\u4F1A\u62A5\u9519\uFF0C\u628A\u539F\u6587\u8F6C\u544A\u7528\u6237\uFF0C\u8BA9\u4ED6\u53BB\u5C0F\u4E91\u96C0\u5B98\u7F51 \u26A1CLI/API \u2192 API \u66F4\u65B0\u3002");
  return lines.join("\n");
}

// src/xyq/start.ts
function startXyq(ctx, deps) {
  const probe = {};
  const run = deps.run ?? defaultCliRunner;
  const resolveCli = deps.resolveCli ?? (() => resolveCliPath(run, { log: (message, fields) => deps.log(message, fields) }));
  const configFile = resolveXyqConfigFile(deps.dshHome);
  const service = createXyqService({ configFile, run, resolveCli, log: deps.log });
  const disposers = [];
  let unregister;
  let started = false;
  let stopped = false;
  const outDir = path7.join(deps.dshHome, "storages", "dsh-remote-dafeiyu", "xyq-output");
  const routeDeps = { service, outDir, log: deps.log };
  const tryStart = () => {
    if (started || stopped) return;
    started = true;
    try {
      const registers = [
        [XYQ_CONFIG_ROUTE, xyqConfigHandler(routeDeps)],
        [XYQ_STATUS_ROUTE, xyqQueryHandler("status", routeDeps)],
        [XYQ_BALANCE_ROUTE, xyqQueryHandler("balance", routeDeps)],
        [XYQ_MODELS_ROUTE, xyqQueryHandler("models", routeDeps)],
        [XYQ_DESCRIBE_ROUTE, xyqDescribeHandler(routeDeps)],
        [XYQ_GENERATE_ROUTE, xyqGenerateHandler(routeDeps)],
        [XYQ_RESULT_ROUTE, xyqResultHandler(routeDeps)],
        [XYQ_FILE_ROUTE, xyqFileHandler(routeDeps)]
      ];
      for (const [path8, handler] of registers) disposers.push(web.register({ kind: "exact", path: path8, handler }));
      unregister = () => {
        for (const dispose of disposers.splice(0)) dispose();
      };
      probe.routes = "registered";
    } catch (error) {
      probe.routes = `register threw: ${String(error?.message ?? error).slice(0, 80)}`;
      started = false;
      if (disposers.length > 0) {
        const registered = disposers.splice(0);
        unregister = () => {
          for (const dispose of registered) dispose();
        };
      }
    }
  };
  let web;
  const acceptWeb = (value, via) => {
    if (!value || typeof value !== "object") return false;
    if (typeof value.register !== "function") {
      probe.webServer = "object without register()";
      return false;
    }
    web = value;
    probe.webServer = via;
    tryStart();
    return true;
  };
  const pickFrom = (source) => {
    if (!source || typeof source !== "object") return void 0;
    const asContext = source;
    if (typeof asContext.get === "function") {
      try {
        const got = asContext.get("webServer", true);
        if (got) return got;
      } catch {
      }
    }
    try {
      return source["webServer"];
    } catch {
      return void 0;
    }
  };
  try {
    const found = ctx.get?.("webServer", true);
    if (found) acceptWeb(found, "via get");
    else probe.webServer = "none";
  } catch (error) {
    probe.webServer = `get threw: ${String(error?.message ?? error).slice(0, 80)}`;
  }
  try {
    ctx.inject?.(["webServer"], ((...args) => {
      try {
        for (const candidate of [args[0], ...args, ctx]) if (acceptWeb(pickFrom(candidate), "via inject")) return;
        probe.webServer = `${probe.webServer ?? "none"} (inject fired, empty)`;
      } catch (error) {
        probe["injectThrew:webServer"] = String(error?.message ?? error).slice(0, 160);
      }
    }));
  } catch (error) {
    probe["injectThrew:webServer"] = String(error?.message ?? error).slice(0, 160);
  }
  const config = readXyqConfig(configFile);
  if (!config.enabled) {
    probe.tools = "disabled-by-config";
  } else {
    try {
      const tools = ctx.get?.("tools", true);
      if (tools && typeof tools.register === "function") {
        for (const tool of xyqTools(service)) tools.register(tool);
        probe.tools = "registered";
      } else {
        probe.tools = "no-tools";
      }
    } catch (error) {
      probe.tools = `threw: ${String(error?.message ?? error).slice(0, 80)}`;
    }
    try {
      const systemPrompt = ctx.get?.("systemPrompt", true);
      if (systemPrompt && typeof systemPrompt.section === "function") {
        systemPrompt.section({ name: "dafeiyu:xyq", order: 10095, text: xyqGuidance(config.freedom) });
        probe.section = "registered";
      } else {
        probe.section = "no-systemPrompt";
      }
    } catch (error) {
      probe.section = `threw: ${String(error?.message ?? error).slice(0, 80)}`;
    }
  }
  return {
    probe,
    service,
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        unregister?.();
      } catch {
      }
      unregister = void 0;
    }
  };
}

// src/index.ts
function apply(ctx) {
  const log = (message, extra) => {
    try {
      console.log(`[vision] ${message}`, extra ?? "");
    } catch {
    }
  };
  const dshHome = resolveDshHome(process.env);
  let visionHandle;
  try {
    visionHandle = startVision(ctx, { dshHome, log });
  } catch (error) {
    visionHandle = void 0;
    log("\u8BC6\u56FE\u670D\u52A1\u8D77\u4E0D\u6765\uFF08\u8FDC\u63A7/\u4EBA\u8BBE\u4E0D\u53D7\u5F71\u54CD\uFF09", {
      message: String(error?.message ?? error).slice(0, 200)
    });
  }
  let xyqHandle;
  try {
    xyqHandle = startXyq(ctx, { dshHome: resolveDshHome(process.env), log });
  } catch (error) {
    xyqHandle = void 0;
    log("\u5C0F\u4E91\u96C0\u80FD\u529B\u8D77\u4E0D\u6765\uFF08\u8FDC\u63A7/\u8BC6\u56FE/\u8BB0\u5FC6\u4E0D\u53D7\u5F71\u54CD\uFF09", {
      message: String(error?.message ?? error).slice(0, 200)
    });
  }
  const stop = () => {
    try {
      visionHandle?.stop();
    } catch {
    }
    try {
      xyqHandle?.stop();
    } catch {
    }
  };
  try {
    if (typeof ctx.effect === "function") {
      ctx.effect(() => stop);
    } else if (typeof ctx.on === "function") {
      ctx.on("dispose", stop);
    }
  } catch {
  }
}
export {
  apply
};
