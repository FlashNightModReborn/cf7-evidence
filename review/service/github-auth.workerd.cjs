const assert = require("node:assert/strict");
const {randomBytes} = require("node:crypto");
const {readFileSync} = require("node:fs");
const path = require("node:path");
const {test} = require("node:test");
const {Miniflare} = require("miniflare");

// Exercise the runtime's fetch implementation as well as the application code.
test("workerd converts a manifest and stores an organization identity provider", async () => {
  const origin = "https://cf7-art-review-receipts.crazyfs.chatgpt.site/github-auth/";
  const script = readFileSync(path.join(__dirname, "github-auth.mjs"), "utf8");
  let conversions = 0;
  const runtime = new Miniflare({
    modules: true,
    script: script + "\nexport default {fetch(request,env){ return githubAuth(request,env); }}",
    compatibilityDate: "2026-05-15",
    d1Databases: ["DB"],
    bindings: {REVIEW_AUTH_KEY: randomBytes(32).toString("base64url")},
    outboundService: async request => {
      assert.equal(request.url, "https://api.github.com/app-manifests/fixture-manifest/conversions");
      assert.equal(request.method, "POST");
      assert.deepEqual(await request.json(), {});
      conversions++;
      return Response.json({
        owner: {id: 183065313, login: "FlashNightModReborn"},
        html_url: "https://github.com/apps/fixture-review",
        permissions: {metadata: "read", issues: "none"},
        client_id: "fixture-client",
        client_secret: "fixture-secret"
      });
    }
  });
  try {
    const db = await runtime.getD1Database("DB");
    for (const file of ["001-feedback.sql", "002-github-identity.sql"]) {
      const sql = readFileSync(path.join(__dirname, file), "utf8");
      for (const statement of sql.split("--> statement-breakpoint").map(s => s.trim()).filter(Boolean)) {
        await db.prepare(statement).run();
      }
    }
    const setup = await runtime.dispatchFetch(origin + "setup");
    const cookie = setup.headers.get("set-cookie").split(";")[0];
    const state = /settings\/apps\/new\?state=([\w-]+)/.exec(await setup.text())[1];
    const registration = await runtime.dispatchFetch(origin + "registered?code=fixture-manifest&state=" + state, {
      headers: {Cookie: cookie}, redirect: "manual"
    });
    assert.equal(registration.status, 200);
    assert.equal(conversions, 1);
    const status = await (await runtime.dispatchFetch(origin + "status")).json();
    assert.deepEqual(status, {configured: true, provider: "github", app: "fixture-review"});
  } finally {
    await runtime.dispose();
  }
});
