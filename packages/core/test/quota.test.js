const test = require("node:test");
const assert = require("node:assert/strict");
const https = require("node:https");
const { EventEmitter } = require("node:events");

const { getQuotaInfo } = require("../dist/quota.js");

function withMockedHttpsRequest(mockImpl, fn) {
  const original = https.request;
  https.request = mockImpl;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      https.request = original;
    });
}

function createMockRequest(statusCode, body) {
  return (_options, handler) => {
    const response = new EventEmitter();
    response.statusCode = statusCode;

    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = () => {};
    request.write = () => {};
    request.end = () => {
      handler(response);
      response.emit("data", body);
      response.emit("end");
    };

    return request;
  };
}

test("getQuotaInfo reports missing auth tokens when access token is absent", async () => {
  const info = await getQuotaInfo({ OPENAI_API_KEY: "sk-test" });

  assert.equal(info.unavailableReason?.code, "missing_auth_tokens");
  assert.equal(info.unavailableReason?.message, "Missing auth tokens");
  assert.equal(info.primaryWindow, null);
  assert.equal(info.secondaryWindow, null);
});

test("getQuotaInfo reports workspace deactivated when usage API returns deactivated workspace", async () => {
  await withMockedHttpsRequest(
    createMockRequest(402, JSON.stringify({ detail: { code: "deactivated_workspace" } })),
    async () => {
      const info = await getQuotaInfo({
        tokens: {
          access_token: "header.payload.signature",
        },
      });

      assert.equal(info.unavailableReason?.code, "workspace_deactivated");
      assert.equal(info.unavailableReason?.message, "Workspace deactivated");
      assert.equal(info.unavailableReason?.statusCode, 402);
      assert.equal(info.primaryWindow, null);
      assert.equal(info.secondaryWindow, null);
    }
  );
});

test("getQuotaInfo reports relogin required when refresh token was reused", async () => {
  await withMockedHttpsRequest(
    (options, handler) => {
      const isTokenRequest = options?.hostname === "auth.openai.com";
      const body = isTokenRequest
        ? JSON.stringify({
            error: {
              message: "Your refresh token has already been used to generate a new access token. Please try signing in again.",
              type: "invalid_request_error",
              param: null,
              code: "refresh_token_reused",
            },
          })
        : JSON.stringify({ detail: "authentication token expired" });
      return createMockRequest(401, body)(options, handler);
    },
    async () => {
      const info = await getQuotaInfo({
        tokens: {
          access_token: "header.payload.signature",
          refresh_token: "refresh-token",
        },
      });

      assert.equal(info.unavailableReason?.code, "relogin_required");
      assert.equal(info.unavailableReason?.message, "Relogin required");
      assert.equal(info.primaryWindow, null);
      assert.equal(info.secondaryWindow, null);
    }
  );
});
