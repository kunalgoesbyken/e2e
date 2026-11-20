/**
 * `run_code` end to end: the built CLI serving a fixture project over stdio
 * to a real MCP client, on the web engine and the fixture app. The code is
 * JavaScript in a sandbox: it computes on what it reads, and every call on
 * `screen`, `app`, or `expect` runs as a test line with the test API's own
 * waiting, matching, and matchers. An uncaught failure stops the code within
 * the call's timeout; a line outside the grammar never reaches the app. A
 * Secret fills only under the authorization `type_secret` runs, reads and
 * matchers see redacted text, a locator found by part of a text is refused
 * in a project with secrets, a password field stays unreadable, and
 * screenshots stay on after a fill. The lines that pass join `test_lines`.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { createProject, type FixtureProject } from '../helpers/run-project.ts';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = path.join(PACKAGE_ROOT, 'dist', 'cli', 'bin.js');

const PASSWORD = 'admin-pass-7Qz';
const API_KEY = 'sk-live-RUNCODE-0000';

const CONFIG = `import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

export default {
  targets: [{ name: 'web', engine: web(), app: { url: process.env.APP_URL! } }],
  credentials: { admin: { username: 'admin', password: ${JSON.stringify(PASSWORD)} } },
  secrets: { apiKey: ${JSON.stringify(API_KEY)} },
} satisfies E2EConfig;
`;

interface ToolText {
  readonly text: string;
  readonly isError: boolean;
  readonly images: number;
}

describe('e2e mcp run_code', { timeout: 120_000 }, () => {
  let app: FixtureApp;
  let project: FixtureProject;
  let client: Client;
  /** Every text a tool returned, to check no secret value ever left the server. */
  const returned: string[] = [];

  const invoke = async (name: string, args: Record<string, unknown> = {}): Promise<ToolText> => {
    const result = (await client.callTool({ name, arguments: args }, { timeout: 110_000 })) as {
      content: { type: string; text?: string }[];
      isError?: boolean;
    };
    const text = result.content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
    returned.push(text);
    return { text, isError: result.isError === true, images: result.content.filter((part) => part.type === 'image').length };
  };

  const call = (tool: string, args: Record<string, unknown> = {}): Promise<ToolText> => invoke('call', { tool, args });
  const runCode = (code: string, timeout?: number): Promise<ToolText> => call('run_code', { code, ...(timeout === undefined ? {} : { timeout }) });
  const nodeId = (text: string, pattern: RegExp): string => {
    const match = /#(n\d+)/.exec(text.split('\n').find((line) => pattern.test(line)) ?? '');
    if (match === null) throw new Error(`no node matches ${pattern} in:\n${text}`);
    return match[1]!;
  };

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'e2e.config.ts': CONFIG });
    client = new Client({ name: 'e2e-mcp-run-code-test', version: '0.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [CLI, 'mcp'],
        cwd: project.dir,
        env: { ...(process.env as Record<string, string>), APP_URL: app.url, CI: '' },
        stderr: 'ignore',
      }),
    );
    const opened = await invoke('open_session');
    expect(opened.isError, opened.text).toBe(false);
    expect(opened.text).toMatch(/^- run_code \{code, timeout\?\}: JavaScript with loops, variables, and return values\. /m);
    expect(opened.text.match(/^- run_code /gm)).toHaveLength(1);
    expect(opened.text).toContain("fill(credentials.user('name').password)");
  }, 60_000);

  afterAll(async () => {
    await invoke('close_session').catch(() => undefined);
    await client?.close().catch(() => undefined);
    project?.cleanup();
    await app?.close();
  });

  it("runs lines on the session's fixtures with the test API's semantics, shows reads, and reports what changed", async () => {
    const result = await runCode(`await app.open('/');
await screen.getByRole('button', 'Increment').tap();
await expect(screen.getByRole('status', 'Counter')).toHaveText('1');
await screen.getByRole('status', 'Counter').textContent();
await screen.getByLabel('Plan').selectOption('Pro');
await expect(screen.getByLabel('Plan')).toHaveValue('pro');
await expect(screen.getByText('Late arrival')).toBeVisible();
await screen.getByTestId('item').allTextContents();`);
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toMatch(/^Ran; the code returned nothing\.\nTest lines: 8\.\n1\. await app\.open\('\/'\);\n/);
    expect(result.text).toContain("4. await screen.getByRole('status', 'Counter').textContent(); -> \"1\"\n");
    expect(result.text).toContain('-> ["Item Alpha","Item Beta","Item Gamma"]\n');
    expect(result.text).toMatch(/\n\n(?:Screen changes since revision|The screen changed substantially)/);
    expect(result.text).toContain('status "Counter" text="1"');

    const observed = await call('observe');
    expect(observed.text).toMatch(/combobox "Plan" value="pro"/);
  });

  it('stops at the first uncaught failure within the timeout, gives its code and message, and leaves the rest unrun', async () => {
    const started = Date.now();
    const missing = await runCode(
      `await screen.getByLabel('Emial').fill('ada@example.test');
await screen.getByRole('button', 'Increment').tap();`,
      500,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(
      /^Failed: LOCATOR_NOT_FOUND: locator matched no nodes within getByLabel\("Emial"\)\nThe app is where the lines that passed left it\.\nTest lines: 1, 1 failed\.\n1\. failed: await screen\.getByLabel\('Emial'\)\.fill\('ada@example\.test'\);\n {3}LOCATOR_NOT_FOUND: locator matched no nodes within getByLabel\("Emial"\)\n\nScreen unchanged since revision/,
    );
    expect(missing.text).not.toContain('Increment');

    const ambiguous = await runCode("await screen.getByRole('button', 'Increment').tap();\nawait screen.getByText('Duplicated').tap();\nawait app.back();");
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toContain("Test lines: 2, 1 failed.\n1. await screen.getByRole('button', 'Increment').tap();\n2. failed: await screen.getByText('Duplicated').tap();\n");
    expect(ambiguous.text).toContain('LOCATOR_AMBIGUOUS: locator matched 2 nodes, expected exactly one: getByText("Duplicated")');
    expect(ambiguous.text).not.toContain('app.back');

    const assertion = await runCode("await expect(screen.getByRole('status', 'Counter')).toHaveText('99');", 300);
    expect(assertion.isError).toBe(true);
    expect(assertion.text).toContain('ASSERTION_FAILED: expect.toHaveText failed\n   locator: getByRole("status", name: "Counter")\n   expected: text "99"\n   observed: text "2"');
  });

  it('runs the code in a sandbox that reaches the app only through lines the grammar takes', async () => {
    const host = await runCode('return [typeof process, typeof require, typeof fetch, typeof globalThis.Bun];');
    expect(host.text).toMatch(/^Returned: \["undefined","undefined","undefined","undefined"\]\n/);
    const page = await runCode("await page.goto('/')");
    expect(page.isError).toBe(true);
    expect(page.text).toMatch(/^Failed: INVALID_ARGUMENT: run_code: page is not defined; the code has screen, app, browser, expect, credentials, secrets, console, and setTimeout\n/);
    const member = await runCode("await screen.evaluate('document.title')");
    expect(member.isError).toBe(true);
    expect(member.text).toMatch(/^Failed: INVALID_ARGUMENT: run_code: "evaluate" at 1:14 /);
    // The bridge itself takes only what the grammar takes, whatever the code hands it.
    const bridge = await runCode("return JSON.parse(await __e2e.line('process.exit(1)'));");
    expect(bridge.text).toMatch(/^Returned: \{"ok":false,"code":"INVALID_ARGUMENT","message":"run_code: \\"process\\" at 1:1 is not in the grammar/);
    const two = await runCode("return JSON.parse(await __e2e.line('await app.back(); await app.back();')).message;");
    expect(two.text).toMatch(/^Returned: "run_code: a line is one statement"\n/);
    const syntax = await runCode('const first = 1;\nconst second = ;');
    expect(syntax.isError).toBe(true);
    expect(syntax.text).toMatch(/^Failed: INVALID_ARGUMENT: run_code: the code does not parse at 2:\d+: /);
    const spinning = await runCode('while (true) {}');
    expect(spinning.isError).toBe(true);
    expect(spinning.text).toMatch(/^Failed: the code ran for more than 5000 ms of its own/);
    const unchanged = await runCode("await expect(screen.getByRole('status', 'Counter')).toHaveText('2')", 300);
    expect(unchanged.isError, unchanged.text).toBe(false);
  });

  it('adds the lines that passed to test_lines, reads and failures aside, and keeps the ids its screen listed', async () => {
    const drafted = await call('test_lines');
    expect(drafted.text.split('\n').filter((line) => line.startsWith('await '))).toEqual([
      'await app.open();',
      "await app.open('/');",
      "await screen.getByRole('button', 'Increment').tap();",
      "await expect(screen.getByRole('status', 'Counter')).toHaveText('1');",
      "await screen.getByLabel('Plan').selectOption('Pro');",
      "await expect(screen.getByLabel('Plan')).toHaveValue('pro');",
      "await expect(screen.getByText('Late arrival')).toBeVisible();",
      "await screen.getByRole('button', 'Increment').tap();",
      "await expect(screen.getByRole('status', 'Counter')).toHaveText('2');",
    ]);
    // The next action's test line is read from the screen run_code returned.
    const echo = await runCode("await app.open('/echo');");
    const typed = await call('type', { target: nodeId(echo.text, /textbox "Token"/), value: 'typed by id' });
    expect(typed.text.split('\n')[1]).toBe('Test line: await screen.getByRole("textbox", "Token").fill("typed by id");');
    const home = await runCode("await app.open('/');");
    expect(home.isError, home.text).toBe(false);
  });

  it("calls any member of the engine's fixture, and keeps the host out of reach through it", async () => {
    const result = await runCode(`const before = await browser.url();
await browser.goto(before + 'echo');
const inputs = await browser.evaluate((selector) => document.querySelectorAll(selector).length, 'input');
await browser.locator('input').first().fill('by selector');
const value = await browser.evaluate(() => document.querySelector('input').value);
const tabs = await browser.tabs();
await browser.keyboard.press('Tab');
await browser.goto(before);
return { path: before.replace(/^https?:\\/\\/[^/]+/, ''), inputs: inputs > 0, value, tabs: await tabs.length };`);
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toMatch(/^Returned: \{"path":"\/","inputs":true,"value":"by selector","tabs":1\}\n/);
    expect(result.text).toContain("await browser.locator('input').first().fill('by selector');\n");
    expect(result.text).not.toContain("document.querySelector('input').value);");
    expect(result.text).not.toMatch(/^\d+\. await browser\.locator\('input'\);$/m);

    for (const code of [
      "return await browser.constructor.constructor('return process')();",
      "return await browser.evaluate.constructor('return process')();",
      "return await browser.__proto__.constructor;",
      "return await browser.keyboard.press.call;",
    ]) {
      const escaped = await runCode(code);
      expect(escaped.isError, code).toBe(true);
      expect(escaped.text, code).toMatch(/^Failed: INVALID_ARGUMENT: run_code: "(constructor|__proto__|call)" in .* is not a member the fixture has\n/);
    }
    const handler = await runCode("const off = await browser.onDialog(() => {});\nawait off();\nreturn 'kept';");
    expect(handler.text, handler.text).toMatch(/^Returned: "kept"\n/);
    const missing = await runCode('await browser.teleport();');
    expect(missing.text).toMatch(/^Failed: INVALID_ARGUMENT: run_code: "teleport" in browser\.teleport\(\) is not a member the fixture has\n/);
    const drafted = await call('test_lines');
    expect(drafted.text).toContain("\nawait browser.locator('input').first().fill('by selector');\n");
  });

  it('runs a locator built with or, as a test would', async () => {
    const either = await runCode("await expect(screen.getByRole('button', 'Increment').or(screen.getByRole('button', 'Nowhere'))).toBeVisible();");
    expect(either.isError, either.text).toBe(false);
    expect(either.text).toContain('Test lines: 1.\n');
  });

  it('computes on what it reads: variables, loops, value assertions, a caught failure, a return value, and the console', async () => {
    const result = await runCode(
      `const counter = screen.getByRole('status', 'Counter');
const before = Number(await counter.textContent());
for (let i = 0; i < 3; i++) await screen.getByRole('button', 'Increment').tap();
const after = Number(await counter.textContent());
console.log('added', after - before);
expect(after - before).toBe(3);
let code;
try {
  await screen.getByRole('button', 'Nowhere').tap();
} catch (error) {
  code = error.code;
}
const items = (await screen.getByTestId('item').allTextContents()).map((text) => text.toUpperCase());
return { added: after - before, code, items };`,
      500,
    );
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toMatch(/^Returned: \{"added":3,"code":"LOCATOR_NOT_FOUND","items":\["ITEM ALPHA","ITEM BETA","ITEM GAMMA"\]\}\nconsole:\n {3}added 3\nTest lines: 7, 1 failed, 3 reads not listed\.\n1\. await screen\.getByRole\('button', 'Increment'\)\.tap\(\);\n/);
    expect(result.text).not.toContain('textContent(); -> ');

    const wrong = await runCode('expect([1, 2]).toHaveLength(3);');
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toMatch(/^Failed: ASSERTION_FAILED: expected \[1,2\] to have length 3\n/);
  });

  it('lets a line the code did not await finish, and says so', async () => {
    const result = await runCode("screen.getByRole('button', 'Increment').tap();\nreturn 'early';");
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toMatch(/^Returned: "early"\nconsole:\n {3}1 call\(s\) on the app were not awaited when the code ended; .*\nTest lines: 1\.\n1\. await screen\.getByRole\('button', 'Increment'\)\.tap\(\);\n/);
  });

  it('stops at a failure the code did not await, and at one a timer callback throws', async () => {
    const counter = "Number(await screen.getByRole('status', 'Counter').textContent())";
    const before = await runCode(`return ${counter};`);
    const flat = await runCode("screen.getByRole('button', 'Nowhere').tap();\nscreen.getByRole('button', 'Increment').tap();", 300);
    expect(flat.isError).toBe(true);
    expect(flat.text).toMatch(/^Failed: LOCATOR_NOT_FOUND: /);
    expect(flat.text).not.toContain("'Increment').tap();");
    expect((await runCode(`return ${counter};`)).text.split('\n')[0]).toBe(before.text.split('\n')[0]);

    const timer = await runCode("setTimeout(() => { expect(1).toBe(2); }, 10);\nawait new Promise((resolve) => setTimeout(resolve, 60));\nreturn 'after';");
    expect(timer.isError).toBe(true);
    expect(timer.text).toMatch(/^Failed: ASSERTION_FAILED: expected 1 to be 2\n/);
    const direct = await runCode('expect(1).toBe(2);');
    expect(direct.text).toMatch(/^Failed: ASSERTION_FAILED: expected 1 to be 2\n/);
  });

  it('refuses what the grammar and the serializer do not take with a code the code can catch', async () => {
    const caught = await runCode(`const codes = [];
for (const attempt of [() => screen.getByRole('button', 'Increment').filter(() => true).tap(), () => screen.getByRole('button', 'Increment').isEditable()]) {
  try { await attempt(); } catch (error) { codes.push(error.code); }
}
return codes;`);
    expect(caught.isError, caught.text).toBe(false);
    expect(caught.text).toMatch(/^Returned: \["INVALID_ARGUMENT","INVALID_ARGUMENT"\]\n/);
  });

  describe('secrets', () => {
    it('fills a password only where type_secret would, and keeps the screenshot after the fill', async () => {
      const before = await call('screenshot');
      expect(before.images).toBe(1);

      const intoEmail = await runCode("await screen.getByLabel('Email').fill(credentials.user('admin').password);");
      expect(intoEmail.isError).toBe(true);
      expect(intoEmail.text).toContain('POLICY_DENIED: field purpose username is incompatible with secret purpose password');
      const intoButton = await runCode("await screen.getByRole('button', 'Increment').fill(secrets.get('apiKey'));");
      expect(intoButton.text).toContain('POLICY_DENIED: the target is not an editable input (role button)');
      const unconfigured = await runCode("await screen.getByLabel('Password').fill(credentials.user('ghost').password);");
      expect(unconfigured.text).toContain('AUTH_CREDENTIAL_UNAVAILABLE: credential "ghost" is not configured');
      const unknown = await runCode("await screen.getByLabel('Email').fill(secrets.get('stripeKey'));");
      expect(unknown.text).toContain('SECRET_UNAVAILABLE: secret "stripeKey" is not configured');
      const badOptions = await runCode("await screen.getByLabel('Password').fill(credentials.user('admin').password, { delay: 5 });");
      expect(badOptions.text).toContain('INVALID_ARGUMENT: fill options has no key "delay"; it takes timeout');
      const badTimeout = await runCode("await screen.getByLabel('Password').fill(credentials.user('admin').password, { timeout: '1s' });");
      expect(badTimeout.text).toContain('INVALID_ARGUMENT: fill timeout must be a number of milliseconds');
      const emailValue = await runCode("await screen.getByLabel('Email').inputValue()");
      expect(emailValue.text).toContain('-> ""');
      const signedIn = await runCode(`await screen.getByLabel('Email').fill(credentials.user('admin').username);
await screen.getByLabel('Password').fill(credentials.user('admin').password);`);
      expect(signedIn.isError, signedIn.text).toBe(false);
      expect(signedIn.text).toContain('Test lines: 2.\n');
      const read = await runCode("await screen.getByLabel('Password').inputValue();");
      expect(read.isError).toBe(true);
      expect(read.text).toContain('POLICY_DENIED: reading values from a secure field is denied: getByLabel("Password")');
      const asserted = await runCode("await expect(screen.getByLabel('Password')).toHaveValue('guess')", 300);
      expect(asserted.text).toContain('POLICY_DENIED: reading values from a secure field is denied');

      const after = await call('screenshot');
      expect(after.images).toBe(1);
    });

    it('fills a generic secret into a plain field and redacts it from every read and failure', async () => {
      const filled = await runCode(`await app.open('/echo');
await screen.getByLabel('Token').fill(secrets.get('apiKey'));`);
      expect(filled.isError, filled.text).toBe(false);
      // The short timeout is for the assertion meant to fail; the open and the fill above need the default one under load.
      const echoed = await runCode(`await screen.getByLabel('Token').inputValue();
await screen.getByTestId('plain').textContent();
await screen.getByTestId('upper').allTextContents();
await expect(screen.getByTestId('plain')).toHaveText('nothing yet');`, 300);
      expect(echoed.isError).toBe(true);
      expect(echoed.text).toContain("1. await screen.getByLabel('Token').inputValue(); -> \"<secret:apiKey>\"\n");
      expect(echoed.text).toContain("2. await screen.getByTestId('plain').textContent(); -> \"<secret:apiKey>\"\n");
      expect(echoed.text).toContain('-> ["<secret:apiKey>"]\n');
      expect(echoed.text).toContain('4. failed:');
      expect(echoed.text).toContain('observed: text "<secret:apiKey>"');
      // The message the code catches has passed the ledger too, before the result is rendered.
      const message = await runCode("try { await expect(screen.getByTestId('plain')).toHaveText('nothing yet'); } catch (error) { return { code: error.code, message: error.message }; }", 300);
      expect(message.text).toMatch(/^Returned: \{"code":"ASSERTION_FAILED","message":"[^\n]*<secret:apiKey>/);
      expect(message.text).not.toContain('sk-live');
    });

    it('compares matchers against redacted text, so no pass or fail depends on a secret', async () => {
      // The secret from the test before is still in the Token field and its echoes.
      for (const code of [
        "await expect(screen.getByTestId('plain')).toContainText('sk-live');",
        "await expect(screen.getByLabel('Token')).toHaveValue(/^sk-l/);",
        "await expect(screen.getByTestId('upper')).toHaveText(/SK-LIVE/i);",
      ]) {
        const probed = await runCode(code, 300);
        expect(probed.isError, code).toBe(true);
        expect(probed.text, code).toContain('ASSERTION_FAILED');
        expect(probed.text, code).toContain('<secret:apiKey>');
      }
      // A test compares the real value, so a line expecting the marker would pass here and fail there.
      for (const code of [
        "await expect(screen.getByTestId('plain')).toHaveText('<secret:apiKey>');",
        "const marker = '<secret:' + 'apiKey>';\nawait expect(screen.getByTestId('plain')).toHaveText(marker);",
      ]) {
        const marker = await runCode(code);
        expect(marker.isError, code).toBe(true);
        expect(marker.text, code).toMatch(
          /^Failed: INVALID_ARGUMENT: run_code: await expect\(screen\.getByTestId\('plain'\)\)\.toHaveText\('<secret:apiKey>'\); expects <secret:name>, which only redacted text holds: .* the line did not run\.\n/,
        );
      }
    });

    it('hands the code redacted reads and handles, so nothing it computes holds a secret', async () => {
      const computed = await runCode(`const value = await screen.getByLabel('Token').inputValue();
return { value, length: value.length, starts: value.startsWith('sk-'), handles: [String(secrets.get('apiKey')), JSON.stringify(credentials.user('admin'))] };`);
      expect(computed.isError, computed.text).toBe(false);
      expect(computed.text).toContain('"value":"<secret:apiKey>","length":15,"starts":false');
    });

    it("redacts what a call on the engine's fixture returns", async () => {
      const read = await runCode("return await browser.evaluate(() => Array.from(document.querySelectorAll('input')).map((input) => input.value));");
      expect(read.isError, read.text).toBe(false);
      expect(read.text).toMatch(/^Returned: \[.*"<secret:apiKey>".*\]\n/);
    });

    it('refuses a locator found by part of a text in a project with secrets, before anything runs', async () => {
      for (const [code, lines] of [
        ["await screen.getByDisplayValue(/^sk-l/).count();", 1],
        ["await screen.getByText('sk-l', { exact: false }).count();", 1],
        ["await screen.getByText('sk-l', { exact: 0 }).count();", 1],
        ["await screen.getByTestId('plain').filter({ hasText: 'sk-l' }).count();", 1],
        ["await screen.getByRole('textbox', { name: /Token/ }).fill('typed');", 1],
        ["await expect(screen.getByRole('row').filter({ has: screen.getByText(/sk/) })).toHaveCount(0);", 1],
        ["await screen.getByLabel('Token').or(screen.getByText(/sk/)).count();", 1],
      ] as const) {
        const probed = await runCode(code);
        expect(probed.isError, code).toBe(true);
        expect(probed.text, code).toMatch(/^Failed: POLICY_DENIED: run_code: .* finds a locator by part of a text, and this project configures secrets/);
        expect(probed.text, code).toContain('the line did not run.');
        expect(probed.text, code).toContain(`Test lines: ${String(lines)}, 1 failed.`);
      }
      const exact = await runCode("await screen.getByDisplayValue('sk-live-WRONG').count();");
      expect(exact.isError, exact.text).toBe(false);
      expect(exact.text).toContain('-> 0\n');
      // No refused line touched the app: the field still holds the secret.
      const still = await runCode("await screen.getByLabel('Token').inputValue();");
      expect(still.text).toContain('-> "<secret:apiKey>"');
    });

    it('drafts the secret fills it ran in test_lines by name', async () => {
      const drafted = await call('test_lines');
      expect(drafted.text).toContain("\nawait screen.getByLabel('Password').fill(credentials.user('admin').password);\n");
      expect(drafted.text).toContain("\nawait screen.getByLabel('Token').fill(secrets.get('apiKey'));\n");
      expect(drafted.text).toContain("Import credentials and secrets from 'e2e'.");
    });

    it('never returns a secret value', () => {
      for (const text of returned) {
        expect(text).not.toContain(PASSWORD);
        expect(text).not.toContain(API_KEY);
        expect(text.toLowerCase()).not.toContain(API_KEY.toLowerCase());
      }
    });
  });
});
