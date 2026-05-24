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

test("getQuotaInfo reports quota token rejected when usage API returns authentication errors", async () => {
  const requests = [];
  await withMockedHttpsRequest(
    (options, handler) => {
      requests.push(options?.hostname ?? "");
      return createMockRequest(401, JSON.stringify({ detail: "authentication token expired" }))(options, handler);
    },
    async () => {
      const info = await getQuotaInfo({
        tokens: {
          access_token: "header.payload.signature",
          refresh_token: "refresh-token",
        },
      });

      assert.equal(info.unavailableReason?.code, "quota_token_rejected");
      assert.equal(info.unavailableReason?.message, "Quota API rejected current token");
      assert.equal(info.primaryWindow, null);
      assert.equal(info.secondaryWindow, null);
      assert.deepEqual(requests, ["chatgpt.com"]);
    }
  );
});

test("getQuotaInfo does not refresh tokens after quota authentication failures", async () => {
  const requests = [];
  let persistCalled = false;
  await withMockedHttpsRequest(
    (options, handler) => {
      requests.push(options?.hostname ?? "");
      return createMockRequest(401, JSON.stringify({ detail: "authentication token expired" }))(options, handler);
    },
    async () => {
      const auth = {
        tokens: {
          access_token: "header.payload.signature",
          refresh_token: "refresh-token",
        },
      };
      const info = await getQuotaInfo(auth, async () => {
        persistCalled = true;
      });

      assert.equal(info.unavailableReason?.code, "quota_token_rejected");
      assert.equal(info.unavailableReason?.statusCode, 401);
      assert.deepEqual(requests, ["chatgpt.com"]);
      assert.equal(persistCalled, false);
      assert.equal(auth.tokens.access_token, "header.payload.signature");
    }
  );
});

test("getQuotaInfo reports quota token rejected when usage API invalidates the token", async () => {
  await withMockedHttpsRequest(
    createMockRequest(401, JSON.stringify({
      error: {
        message: "Your authentication token has been invalidated. Please try signing in again.",
        type: "invalid_request_error",
        code: "token_invalidated",
        param: null,
      },
      status: 401,
    })),
    async () => {
      const info = await getQuotaInfo({
        tokens: {
          access_token: "header.payload.signature",
          refresh_token: "refresh-token",
        },
      });

      assert.equal(info.unavailableReason?.code, "quota_token_rejected");
      assert.equal(info.unavailableReason?.message, "Quota API rejected current token (token_invalidated)");
      assert.equal(info.unavailableReason?.statusCode, 401);
      assert.equal(info.primaryWindow, null);
      assert.equal(info.secondaryWindow, null);
    }
  );
});

test("getQuotaInfo reports quota token rejected for generic quota auth failures", async () => {
  await withMockedHttpsRequest(
    createMockRequest(403, JSON.stringify({ error: { message: "Forbidden" } })),
    async () => {
      const info = await getQuotaInfo({
        tokens: {
          access_token: "header.payload.signature",
          refresh_token: "refresh-token",
        },
      });

      assert.equal(info.unavailableReason?.code, "quota_token_rejected");
      assert.equal(info.unavailableReason?.message, "Quota API rejected current token");
      assert.equal(info.unavailableReason?.statusCode, 403);
      assert.equal(info.primaryWindow, null);
      assert.equal(info.secondaryWindow, null);
    }
  );
});
