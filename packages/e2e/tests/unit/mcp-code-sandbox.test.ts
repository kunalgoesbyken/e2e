/**
 * The `run_code` sandbox on its own, with a host that only writes down the
 * lines the code spells. Every line a chain spells parses in the grammar
 * (`code-parse.ts`), whatever text the code puts in it; a reply reaches the
 * code as a value or a thrown error; and the limits end a program that
 * spins, grows, or asks too much.
 */

import { describe, expect, it } from 'vitest';
import { parseCode } from '../../src/session-tools/code-parse.ts';
import { runInSandbox, type LineReply, type SandboxResult } from '../../src/session-tools/code-sandbox.ts';

interface Ran extends SandboxResult {
  readonly lines: readonly string[];
}

/** Runs `code` against a host that answers each line with `reply`, and keeps the lines. */
async function run(code: string, reply: (source: string) => LineReply = () => ({ ok: true, value: null })): Promise<Ran> {
  const lines: string[] = [];
  const result = await runInSandbox({
    code,
    line: (source) => {
      lines.push(source);
      return Promise.resolve(reply(source));
    },
    signal: undefined,
    timeoutMs: 30_000,
  });
  return { ...result, lines };
}

describe('run_code sandbox', { timeout: 60_000 }, () => {
  it('spells each call on screen, app, and expect as one line the grammar parses', async () => {
    const ran = await run(`const row = screen.getByRole('row', { name: 'Ada' }).filter({ has: screen.getByText('Admin') }).nth(2);
await row.getByRole('button', 'Edit').tap();
await screen.getByLabel('Note').fill('it\\'s a "quote"\\\\ and\\na new line\\u2028');
await screen.getByText(/^Total: \\$\\d+$/i).count();
await expect(row).not.toHaveText(['a', 'b'], { timeout: 250 });
await app.open('/cart?id=1');
await screen.getByLabel('Password').fill(credentials.user('admin').password);
await screen.getByLabel('Email').fill(credentials.user('admin').username);
await screen.getByLabel('Token').fill(secrets.get('apiKey'), undefined);`);
    expect(ran.error).toBeUndefined();
    expect(ran.lines).toEqual([
      "await screen.getByRole('row', { name: 'Ada' }).filter({ has: screen.getByText('Admin') }).nth(2).getByRole('button', 'Edit').tap();",
      "await screen.getByLabel('Note').fill('it\\'s a \"quote\"\\\\ and\\na new line\\u2028');",
      'await screen.getByText(/^Total: \\$\\d+$/i).count();',
      "await expect(screen.getByRole('row', { name: 'Ada' }).filter({ has: screen.getByText('Admin') }).nth(2)).not.toHaveText(['a', 'b'], { timeout: 250 });",
      "await app.open('/cart?id=1');",
      "await screen.getByLabel('Password').fill(credentials.user('admin').password);",
      "await screen.getByLabel('Email').fill(credentials.user('admin').username);",
      "await screen.getByLabel('Token').fill(secrets.get('apiKey'));",
    ]);
    for (const line of ran.lines) expect(parseCode(line, { fixtures: [] }), line).toHaveLength(1);
    const [, fill] = ran.lines.map((line) => parseCode(line, { fixtures: [] })[0]!);
    expect(fill!.body).toMatchObject({ chain: { calls: [{}, { name: 'fill', args: [{ kind: 'literal', value: 'it\'s a "quote"\\ and\na new line ' }] }] } });
  });

  it('maps the names a Playwright habit reaches for onto the members that do the same', async () => {
    const ran = await run(`await screen.getByText('Row').scrollIntoViewIfNeeded();
await screen.getByText('Row').innerText();
await screen.getByRole('list').scroll('up');
await screen.getByRole('list').scroll();`);
    expect(ran.lines).toEqual([
      "await screen.getByText('Row').scrollIntoView();",
      "await screen.getByText('Row').textContent();",
      "await screen.getByRole('list').swipe({ direction: 'up' });",
      "await screen.getByRole('list').swipe({ direction: 'down' });",
    ]);
  });

  it('hands a reply to the code as a value, or as a thrown error with the code', async () => {
    const ran = await run(
      `const texts = await screen.getByRole('listitem').allTextContents();
let caught;
try { await screen.getByText('Gone').tap(); } catch (error) { caught = [error.code, error.message, error instanceof Error]; }
console.log('read', texts.length, { texts });
return { upper: texts.map((text) => text.toUpperCase()), caught };`,
      (source) => (source.includes('Gone') ? { ok: false, code: 'LOCATOR_NOT_FOUND', message: 'locator matched no nodes' } : { ok: true, value: ['a', 'b'] }),
    );
    expect(ran.error).toBeUndefined();
    expect(ran.value).toEqual({ upper: ['A', 'B'], caught: ['LOCATOR_NOT_FOUND', 'LOCATOR_NOT_FOUND: locator matched no nodes', true] });
    expect(ran.logs).toEqual(['read 2 {"texts":["a","b"]}']);

    const uncaught = await run("await screen.getByText('Gone').tap();\nawait app.back();", () => ({ ok: false, code: 'LOCATOR_NOT_FOUND', message: 'locator matched no nodes' }));
    expect(uncaught.error).toEqual({ code: 'LOCATOR_NOT_FOUND', message: 'LOCATOR_NOT_FOUND: locator matched no nodes' });
    expect(uncaught.lines).toHaveLength(1);
  });

  it('checks values the code holds with expect', async () => {
    const passed = await run("expect(2 + 2).toBe(4); expect([1, 2]).toContain(2); expect('abc').toMatch(/b/); expect({ a: [1] }).toEqual({ a: [1] }); expect(1).not.toBe(2); expect(3).toBeGreaterThan(2);");
    expect(passed.error).toBeUndefined();
    const failed = await run("expect('abc').not.toContain('b');");
    expect(failed.error).toEqual({ code: 'ASSERTION_FAILED', message: 'ASSERTION_FAILED: expected abc not to contain b' });
  });

  it('has no host to reach, and names what it has when the code reaches for anything else', async () => {
    const globals = await run('return [typeof process, typeof require, typeof fetch, typeof module, typeof __dirname];');
    expect(globals.value).toEqual(['undefined', 'undefined', 'undefined', 'undefined', 'undefined']);
    const page = await run("await page.goto('/');");
    expect(page.error?.code).toBe('INVALID_ARGUMENT');
    expect(page.error?.message).toBe('run_code: page is not defined; the code has screen, app, expect, credentials, secrets, console, and setTimeout');
    const handle = await run("return [JSON.stringify(secrets.get('apiKey')), typeof credentials.user('admin').password];");
    expect(handle.value).toEqual(['{"__src":"secrets.get(\'apiKey\')"}', 'object']);
    const callback = await run("await screen.getByRole('row').filter(() => true).count();");
    expect(callback.error?.message).toBe('Error: a function is not an argument a test line takes');
    expect(callback.lines).toEqual([]);
  });

  it('reports a syntax error with its place in the code, before anything runs', async () => {
    const ran = await run("await app.open('/');\nconst broken = ;");
    expect(ran.error?.code).toBe('INVALID_ARGUMENT');
    expect(ran.error?.message).toMatch(/^run_code: the code does not parse at 2:\d+: /);
    expect(ran.lines).toEqual([]);
  });

  it('lets a line the code did not await run to its end, and notes it', async () => {
    const ran = await run("app.open('/');\nreturn 'early';");
    expect(ran.value).toBe('early');
    expect(ran.lines).toEqual(["await app.open('/');"]);
    expect(ran.logs).toEqual(['1 call(s) on the app were not awaited when the code ended; they ran, but await each one so a failure stops the code.']);
  });

  it('ends a program that spins, grows without bound, or asks the app for too much', async () => {
    const spinning = await run('while (true) {}');
    expect(spinning.error?.message).toMatch(/^the code ran for more than 5000 ms of its own/);
    const growing = await run("const chunks = []; while (true) chunks.push('x'.repeat(1_000_000) + chunks.length);");
    expect(growing.error?.message).toMatch(/memory/i);
    const asking = await run("for (let i = 0; i < 2_000; i++) await screen.getByText('Row').count();");
    expect(asking.error?.message).toMatch(/^the code crossed a limit of one call \(1000 lines and waits\): /);
    expect(asking.lines.length).toBeLessThanOrEqual(1_000);
  });

  it('takes many lines at once and runs them one at a time, in order', async () => {
    let running = 0;
    let most = 0;
    const lines: string[] = [];
    const result = await runInSandbox({
      code: "return (await Promise.all(Array.from({ length: 40 }, (_, i) => screen.getByText('row ' + i).count()))).length;",
      line: async (source) => {
        most = Math.max(most, ++running);
        lines.push(source);
        await new Promise((resolve) => setTimeout(resolve, 1));
        running--;
        return { ok: true, value: 1 };
      },
      signal: undefined,
      timeoutMs: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.value).toBe(40);
    expect(most).toBe(1);
    expect(lines[39]).toBe("await screen.getByText('row 39').count();");
  });

  it('runs no queued line once the call is cancelled, and waits for the one in the app', async () => {
    const abort = new AbortController();
    const started: string[] = [];
    let settled = 0;
    const result = await runInSandbox({
      code: "for (let i = 0; i < 6; i++) screen.getByText('row ' + i).tap();\nawait new Promise(() => {});",
      line: async (source) => {
        started.push(source);
        if (started.length === 1) abort.abort();
        await new Promise((resolve) => setTimeout(resolve, 100));
        settled++;
        return { ok: true, value: null };
      },
      signal: abort.signal,
      timeoutMs: 30_000,
    });
    expect(result.error).toBeDefined();
    expect(started).toEqual(["await screen.getByText('row 0').tap();"]);
    expect(settled).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(started).toHaveLength(1);
  });

  it('reads a locator put into a string as its source, without a line', async () => {
    const ran = await run("return `${screen.getByText('Row').first()} and ` + screen.getByRole('button', 'Save');");
    expect(ran.value).toBe("screen.getByText('Row').first() and screen.getByRole('button', 'Save')");
    expect(ran.lines).toEqual([]);
  });

  it("sends a read or call on an engine fixture as a member path and data, and chains on what comes back", async () => {
    const sent: unknown[] = [];
    const result = await runInSandbox({
      code: `const title = await browser.evaluate((selector) => document.title, 'h1');
await browser.locator('.row').first().click({ force: true });
const width = await browser.viewport.width;
return [title, width, String(browser.keyboard), typeof device];`,
      line: () => Promise.resolve({ ok: true, value: null }),
      fixtures: ['browser'],
      call: (payload) => {
        const request = JSON.parse(payload) as { path: string[]; source: string };
        sent.push(request);
        if (request.path.at(-1) === 'evaluate') return Promise.resolve({ ok: true, value: 'Home' });
        if (request.path.at(-1) === 'width') return Promise.resolve({ ok: true, value: 800 });
        return Promise.resolve(request.path.at(-1) === 'click' ? { ok: true, value: null } : { ok: true, handle: sent.length });
      },
      signal: undefined,
      timeoutMs: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual(['Home', 800, 'browser.keyboard', 'undefined']);
    expect(sent).toEqual([
      { base: { root: 'browser' }, path: ['evaluate'], args: [{ t: 'function', s: '(selector) => document.title' }, { t: 'value', v: 'h1' }], source: "browser.evaluate((selector) => document.title, 'h1')" },
      { base: { root: 'browser' }, path: ['locator'], args: [{ t: 'value', v: '.row' }], source: "browser.locator('.row')" },
      { base: { handle: 2 }, path: ['first'], args: [], source: "browser.locator('.row').first()" },
      { base: { handle: 3 }, path: ['click'], args: [{ t: 'object', v: [['force', { t: 'value', v: true }]] }], source: "browser.locator('.row').first().click({ force: true })" },
      { base: { root: 'browser' }, path: ['viewport', 'width'], source: 'browser.viewport.width' },
    ]);
  });

  it('waits with setTimeout', async () => {
    const started = Date.now();
    const ran = await run('await new Promise((resolve) => setTimeout(resolve, 150)); return 1;');
    expect(ran.value).toBe(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });
});
