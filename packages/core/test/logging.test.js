const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const core = require("../dist/index.js");

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.`;
}

function makeAuthFile(accountId, options = {}) {
  return {
    ...(options.lastRefresh ? { last_refresh: options.lastRefresh } : {}),
    tokens: {
      access_token: options.accessToken ?? "access-token",
      refresh_token: options.refreshToken ?? "refresh-token",
      account_id: accountId,
      id_token: makeJwt({
        email: options.email ?? `${accountId}@example.com`,
        name: options.name ?? accountId,
        "https://api.openai.com/auth": {
          chatgpt_plan_type: options.plan ?? "plus",
        },
      }),
    },
  };
}

function withMockedHttpsRequest(fn) {
  const originalRequest = https.request;
  https.request = (requestOptions, handler) => {
    const hostname = requestOptions?.hostname;
    const body =
      hostname === "auth.openai.com"
        ? JSON.stringify({
            access_token: "access-rotated",
            refresh_token: "refresh-rotated",
            id_token: makeJwt({
              email: "perf@example.com",
              name: "perf-user",
              "https://api.openai.com/auth": {
                chatgpt_plan_type: "plus",
              },
            }),
          })
        : JSON.stringify({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 10,
                reset_at: null,
                limit_window_seconds: 18000,
              },
            },
          });
    const response = {
      statusCode: 200,
      on(event, listener) {
        if (event === "data") {
          setImmediate(() => listener(body));
        }
        if (event === "end") {
          setImmediate(listener);
        }
        return response;
      },
    };

    const request = {
      on() {
        return request;
      },
      setTimeout() {
        return request;
      },
      destroy() {},
      write() {},
      end() {
        handler(response);
      },
    };

    return request;
  };

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      https.request = originalRequest;
    });
}

function captureDiagnosticLogs() {
  const lines = [];
  core.setDiagnosticLogger((level, line) => {
    lines.push({ level, line });
  });
  return lines;
}

test("queryQuota keeps performance logs at summary level when detailed logging is disabled", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-core-query-quota-summary-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;

  try {
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(
        makeAuthFile("acct-summary", {
          lastRefresh: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
        }),
        null,
        2
      ),
      "utf-8"
    );

    const lines = captureDiagnosticLogs();
    core.setDiagnosticLogOptions({ detailedPerformanceLogging: false });

    await withMockedHttpsRequest(async () => {
      const result = await core.queryQuota();
      assert.equal(result.kind, "ok");
    });

    assert.equal(
      lines.some((entry) => entry.line.includes("\"operation\":\"queryQuota\"") && entry.line.includes("\"durationMs\":")),
      true
    );
    assert.equal(
      lines.some((entry) => entry.line.includes("\"operation\":\"queryQuota\"") && entry.line.includes("\"stage\":")),
      false
    );
  } finally {
    core.setDiagnosticLogger(null);
    core.setDiagnosticLogOptions({ detailedPerformanceLogging: false });
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("detailed core performance logging emits stage timings for quota and refresh flows", async () => {
  const lines = captureDiagnosticLogs();
  core.setDiagnosticLogOptions({ detailedPerformanceLogging: true });

  await withMockedHttpsRequest(async () => {
    const refreshAuth = makeAuthFile("acct-refresh");
    await core.refreshAccessToken(refreshAuth);

    const quotaInfo = await core.getQuotaInfo(makeAuthFile("acct-quota"));
    assert.equal(quotaInfo.unavailableReason, null);
  });

  assert.equal(
    lines.some((entry) => entry.line.includes("\"operation\":\"refreshAccessToken\"") && entry.line.includes("\"stage\":")),
    true
  );
  assert.equal(
    lines.some((entry) => entry.line.includes("\"operation\":\"getQuotaInfo\"") && entry.line.includes("\"stage\":")),
    true
  );
  assert.equal(
    lines.some((entry) => entry.line.includes("\"operation\":\"fetchUsageApi\"") && entry.line.includes("\"stage\":")),
    true
  );

  core.setDiagnosticLogger(null);
  core.setDiagnosticLogOptions({ detailedPerformanceLogging: false });
});
