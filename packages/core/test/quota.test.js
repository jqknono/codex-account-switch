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
