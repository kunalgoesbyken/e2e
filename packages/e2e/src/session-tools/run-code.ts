/**
 * The session's `run_code`: JavaScript run against the live app, in the
 * sandbox of `code-sandbox.ts`. The code holds no capability: a chain it
 * builds on `screen`, `app`, or `expect` only spells a test line, and the
 * line comes here to be parsed into the closed grammar of `code-parse.ts`.
 * The runner walks the parsed chain and reaches each fixture member by a name
 * the grammar's table listed, on the session's `app` and a `screen` over the
 * session's engine, so a line waits, matches, and fails as it would in a
 * test. A call on a fixture the engine contributes (`browser`, `device`)
 * has no grammar to pass, since core names none of its members; it goes to
 * `code-fixtures.ts` as a member path and data. Each line's wait is capped at
 * the call's `timeout`, a line that fails throws in the code, and the result
 * ends with what changed on screen. The lines that pass, reads aside, join
 * the session's `test_lines`.
 *
 * The coding agent is not trusted the way test code is. A Secret reaches the
 * screen only through the authorization `type_secret` runs, on the node the
 * fill lands on. Every node the screen reads passes the attempt's secret
 * ledger first, so a read returns, and a matcher compares, `<secret:name>`
 * where a value was: nothing the code computes depends on a secret's
 * characters. A locator found by part of a text is matched inside the engine,
 * where the ledger cannot reach, so a project that configures secrets has
 * such a line refused before it runs.
 */

import type { ToolExecutionOptions, ToolSet } from 'ai';
import { z } from 'zod';
import type { StepExecutorContext } from '@e2e-dev/core/lib/agent/executor';
import { redactNode, type NodeRedaction } from '@e2e-dev/core/lib/agent/observation';
import { recordPolicyEvent } from '@e2e-dev/core/lib/agent/phases';
import type { ScreenPresenter } from '@e2e-dev/core/lib/agent/screen-update';
import { authorizeSecretFill } from '@e2e-dev/core/lib/agent/secrets';
import type { TargetSession } from '@e2e-dev/core/lib/engine/surface';
import { createAsyncExpectation } from '../expect/async.ts';
import { classifyError, codedMessage, ConfigurationError, TestError, type E2EError } from '@e2e-dev/core/lib/internal/errors';
import { isPlainObject, rejectUnknownOptions } from '@e2e-dev/core/lib/internal/options';
import { describeExpression } from '@e2e-dev/core/lib/locator/expression';
import { createScreen, locatorInternals, type LocatorInternals } from '@e2e-dev/core/lib/locator/screen';
import { createScreenContext } from '@e2e-dev/core/lib/run/fixtures';
import type { StandaloneAttempt } from '@e2e-dev/core/lib/run/standalone-attempt';
import { secretHandle } from '@e2e-dev/core/lib/secrets';
import type { App, Screen, Secret } from '@e2e-dev/core/lib/types';
import { parseCode, type Call, type Chain, type Statement, type Value } from './code-parse.ts';
import { FixtureCalls, parseFixtureRequest } from './code-fixtures.ts';
import { runInSandbox, type CallReply, type LineReply, type SandboxResult } from './code-sandbox.ts';
import { SURFACE } from './code-surface.ts';

/** How long one statement may wait unless the call says otherwise, in milliseconds. */
const RUN_CODE_TIMEOUT_MS = 5_000;
/** The longest a call may let one statement wait. */
const MAX_TIMEOUT_MS = 120_000;
/** The longest one call's whole program may run, waits on the app included. */
const PROGRAM_TIMEOUT_MS = 300_000;
/** Every member that builds a locator, so a query the grammar gains is checked as soon as it is listed. */
const QUERIES: ReadonlySet<string> = new Set([...SURFACE.locator].flatMap(([name, member]) => (member.kind === 'query' ? [name] : [])));
/** What the secret ledger writes where a value was. */
const SECRET_MARKER = '<secret:';

/** The parts of the attempt a statement uses. */
type RunCodeAttempt = Pick<StandaloneAttempt, 'agentRuntime' | 'budget' | 'session' | 'runId' | 'attemptId'> & {
  readonly fixtures: Pick<StandaloneAttempt['fixtures'], 'app'>;
};

/** What the session hands `run_code`. */
export interface RunCodeSession {
  /** The fixtures, runtime, and budget for this call on the session's attempt. */
  readonly attempt: (signal: AbortSignal | undefined) => RunCodeAttempt;
  /** The fixtures of the target's engine that the attempt's `fixtures` hold, which the code calls by member (`code-fixtures.ts`). */
  readonly engineFixtures: readonly string[];
}

interface RunCodeOptions extends RunCodeSession {
  /** The session step, observed once the statements ran. */
  readonly context: Pick<StepExecutorContext, 'observe'>;
  /** The session's presenter, so the screen comes back as changes since the one the agent holds. */
  readonly screen: Pick<ScreenPresenter, 'update'>;
  /** Told the source of every statement that passed and is not a read, in the order they ran, for `test_lines`. */
  readonly record?: ((passed: readonly string[]) => void) | undefined;
}

interface RunCodeArgs {
  readonly code: string;
  readonly timeout?: number | undefined;
}

/** The rendered result, and whether a statement failed. */
interface RunCodeResult {
  readonly text: string;
  readonly failed: boolean;
}

/** What became of one line: the value it read, or the error it failed with. */
type Outcome = { readonly source: string; readonly read: boolean; readonly value: unknown } | { readonly source: string; readonly error: E2EError };

/** What `run_code`'s code may call, as the session's opening and the tool's description both spell it. */
export function runCodeApi(session: RunCodeSession): readonly string[] {
  return [...RUN_CODE_API, ...session.engineFixtures.map((name) => fixtureLine(session, name))];
}

/** One engine fixture and the members it has, read off the fixture itself: core names none of them. */
function fixtureLine(session: RunCodeSession, name: string): string {
  let members: readonly string[] = [];
  try {
    const fixture: unknown = Reflect.get(session.attempt(undefined).fixtures, name);
    if (typeof fixture === 'object' && fixture !== null) members = Object.keys(fixture);
  } catch {
    // A fixture that cannot be built now fails where the code first calls it, with its own error.
  }
  return `${name}: the engine's fixture, as a test body gets it${members.length === 0 ? '' : `: ${members.join(', ')}`}. Any member can be called; a function passed to one runs only where the fixture sends its source (${name}.evaluate(() => ...) style), never as a handler the host calls. Values come back with secrets redacted.`;
}

const RUN_CODE_API: readonly string[] = [
  'These are the objects an e2e test body gets; there is no page.',
  "screen: getByRole(role, name?), getByLabel(text), getByText(text), getByPlaceholder(text), getByTestId(id), getByDisplayValue(value), each returning a locator; scrollUntilVisible(locator), swipe({ direction: 'down' }), tapAt({ x, y }), tree().",
  "locator: the same getBy* queries, filter({ has: locator }), or(locator), first(), last(), nth(i); actions tap(), click(), doubleTap(), longPress(), fill(text), pressSequentially(text), clear(), press(key), check(), uncheck(), selectOption(value), hover(), dragTo(locator), scrollIntoView(), swipe({ direction: 'down' }), scrollUntilVisible(locator), waitFor(); reads textContent(), allTextContents(), count(), inputValue(), getAttribute(name), isVisible(), isHidden(), isEnabled(), isDisabled(), isChecked(), boundingBox().",
  'expect(locator): toBeVisible, toBeHidden, toBeEnabled, toBeDisabled, toBeChecked, toHaveText, toContainText, toHaveValue, toHaveAttribute, toHaveCount, toHaveAccessibleName, toHaveRole, with .not. expect(value): toBe, toEqual, toContain, toMatch, toHaveLength, toBeGreaterThan, toBeLessThan, toBeTruthy.',
  'app: open(path?), restart(), clearState(), back().',
  "Secrets: fill(credentials.user('name').password) and fill(secrets.get('name')) fill a configured value you never see, into a field type_secret would fill; fill(credentials.user('name').username) fills the username. The names are the ones open_session lists.",
  'To pick a node by part of its text, read the texts and index: const texts = await rows.allTextContents(); const row = rows.nth(texts.findIndex((text) => text.includes(\'Golden\')));',
];

function scopeNames(session: RunCodeSession): string {
  return ['screen', 'app', ...session.engineFixtures, 'expect', 'credentials', 'secrets'].join(', ') + ', and console';
}

/** The `run_code` catalog tool. */
export function runCodeTool(options: RunCodeOptions): ToolSet[string] {
  return {
    description: [
      `Run JavaScript against the live session: the body of an async function with ${scopeNames(options)} in scope, the objects a test body gets.`,
      "await screen.getByLabel('Email').fill('ada@example.com'); await expect(screen.getByRole('status')).toHaveText('Saved');",
      'Variables, loops, conditionals, try/catch, functions, and every JavaScript built-in work, so read values, compute on them, and act on what you find in one call:',
      "const rows = screen.getByRole('listitem'); const prices = (await rows.allTextContents()).map((text) => Number(text.match(/\\$([\\d.]+)/)[1])); return { prices, sorted: prices.every((price, i) => i === 0 || prices[i - 1] <= price) };",
      'return a JSON value to get it back; console.log lines come back too. The result lists each test line the code ran, then what changed on screen.',
      ...runCodeApi(options),
      `Actions and matchers wait like a test: each waits at most timeout ms (default ${String(RUN_CODE_TIMEOUT_MS)}), so a loop rarely needs a sleep; setTimeout works when it does.`,
      'A line that fails throws an Error whose code is the runner code (LOCATOR_NOT_FOUND, ASSERTION_FAILED, ...); uncaught, it stops the code and the app stays where it is.',
      "Lines that pass, except reads, join test_lines' draft in the order they ran.",
      'Reads and matchers see <secret:name> where a secret value is. When the project configures secrets, find locators by their exact text: a regular expression, exact: false, or hasText in a query is refused with POLICY_DENIED.',
    ].join(' '),
    inputSchema: z.object({
      code: z.string().min(1).describe(`JavaScript: the body of an async function; ${scopeNames(options)} are in scope`),
      timeout: z
        .number()
        .int()
        .min(1)
        .max(MAX_TIMEOUT_MS)
        .optional()
        .describe(`How long each action or matcher may wait, in milliseconds; default ${String(RUN_CODE_TIMEOUT_MS)}`),
    }).strict(),
    execute: (args: RunCodeArgs, call: ToolExecutionOptions<unknown>) => runCode(options, args, call.abortSignal),
    toModelOutput: ({ output }: { readonly output: RunCodeResult }) => ({ type: output.failed ? ('error-text' as const) : ('text' as const), value: output.text }),
  };
}

/** Runs the code in the sandbox, each line it spells through the grammar and the runner, and renders what happened. */
async function runCode(options: RunCodeOptions, args: RunCodeArgs, signal: AbortSignal | undefined): Promise<RunCodeResult> {
  const attempt = options.attempt(signal);
  const { agentRuntime: runtime, budget } = attempt;
  const timeout = args.timeout ?? RUN_CODE_TIMEOUT_MS;
  const runner = new LineRunner(attempt);
  const outcomes: Outcome[] = [];
  const line = async (source: string): Promise<LineReply> => {
    try {
      const [statement, ...rest] = parseCode(source, { fixtures: options.engineFixtures });
      if (statement === undefined || rest.length > 0) throw new TestError('INVALID_ARGUMENT', 'run_code: a line is one statement');
      refuseMarkerExpectation(statement);
      if (runtime.config.allSecrets.size > 0) refuseLocatorByPart(statement);
      const value = await budget.capped(timeout, () => runner.run(statement));
      outcomes.push({ source: statement.source, read: isRead(statement), value });
      return { ok: true, value: value ?? null };
    } catch (cause) {
      const error = classifyError(cause);
      outcomes.push({ source, error });
      return { ok: false, code: error.code, message: error.message };
    }
  };
  const fixtures = new FixtureCalls((name) => (options.engineFixtures.includes(name) ? Reflect.get(attempt.fixtures, name) : undefined), runtime.redact);
  const call = async (payload: string): Promise<CallReply> => {
    let source = 'a call on an engine fixture';
    try {
      const request = parseFixtureRequest(payload);
      source = `await ${request.source};`;
      const settled = await budget.capped(timeout, () => fixtures.run(request));
      // An object the host keeps is a step on the way to a call, not a line of its own.
      if ('handle' in settled) return { ok: true, handle: settled.handle };
      outcomes.push({ source, read: settled.value !== undefined, value: settled.value });
      return { ok: true, value: settled.value ?? null };
    } catch (cause) {
      const error = classifyError(cause);
      outcomes.push({ source, error });
      return { ok: false, code: error.code, message: runtime.redact(error.message) };
    }
  };
  const result = await runInSandbox({ code: args.code, line, call, fixtures: options.engineFixtures, signal, timeoutMs: PROGRAM_TIMEOUT_MS });
  options.record?.(outcomes.flatMap((outcome) => ('error' in outcome || outcome.read ? [] : [outcome.source])));
  let screen: string;
  try {
    screen = options.screen.update(await options.context.observe(), { expectChange: false });
  } catch (cause) {
    screen = `Observing the screen afterwards failed: ${codedMessage(cause)}`;
  }
  return { text: render(result, outcomes, screen), failed: result.error !== undefined };
}

/** Whether a statement only reads, which a test body has no use for once its value is known. */
function isRead(statement: Statement): boolean {
  return statement.body.kind === 'call' && statement.body.read;
}

/**
 * Refuses, before it runs, a line that finds a locator by part of a text: a
 * regular expression, an `exact` that is not `true`, or a `hasText` filter.
 * The engine matches those on unredacted text, secret values included, so
 * whether one matches could spell a value out a piece at a time.
 */
function refuseLocatorByPart(statement: Statement): void {
  const { body } = statement;
  const subject = body.kind === 'call' ? body.chain : body.locator;
  const calls = body.kind === 'call' ? subject.calls : [...subject.calls, body.matcher];
  if (![subject, ...locatorsIn(calls)].some((chain) => chain.calls.some(findsByPart))) return;
  throw new ConfigurationError(
    'POLICY_DENIED',
    `run_code: ${statement.source} finds a locator by part of a text, and this project configures secrets: the engine matches a regular expression, exact: false, or hasText on unredacted text, so whether it matches could spell a secret out one piece at a time. Find the locator by its exact text, or read the texts and pick by index: const texts = await rows.allTextContents(); rows.nth(texts.findIndex((text) => text.includes('...'))); the line did not run.`,
  );
}

/**
 * Refuses, before it runs, a matcher that expects a secret marker. The
 * matcher would compare it against redacted text and pass, while the same
 * line in a test compares the real value and fails.
 */
function refuseMarkerExpectation(statement: Statement): void {
  const holdsMarker = (value: Value): boolean => {
    switch (value.kind) {
      case 'literal':
        return typeof value.value === 'string' && value.value.includes(SECRET_MARKER);
      case 'regex':
        return value.source.includes(SECRET_MARKER);
      case 'array':
        return value.items.some(holdsMarker);
      case 'object':
        return value.entries.some(([, item]) => holdsMarker(item));
      default:
        return false;
    }
  };
  if (statement.body.kind !== 'expect' || !statement.body.matcher.args.some(holdsMarker)) return;
  throw new ConfigurationError(
    'INVALID_ARGUMENT',
    `run_code: ${statement.source} expects ${SECRET_MARKER}name>, which only redacted text holds: a test compares the real value, so the line would fail there. Assert what the screen shows around the secret instead; the line did not run.`,
  );
}

/** Every locator passed as an argument to these calls, at any depth. */
function locatorsIn(calls: readonly Call[]): Chain[] {
  const found: Chain[] = [];
  const visit = (value: Value): void => {
    if (value.kind === 'locator') {
      found.push(value.chain);
      for (const call of value.chain.calls) call.args.forEach(visit);
    } else if (value.kind === 'array') {
      value.items.forEach(visit);
    } else if (value.kind === 'object') {
      for (const [, item] of value.entries) visit(item);
    }
  };
  for (const call of calls) call.args.forEach(visit);
  return found;
}

/** Whether a query or filter matches part of a text. */
function findsByPart(call: Call): boolean {
  if (call.name === 'filter') return call.args.some((arg) => arg.kind === 'object' && arg.entries.some(([key]) => key === 'hasText'));
  if (!QUERIES.has(call.name)) return false;
  const partial = (value: Value, key: string | undefined): boolean => {
    if (value.kind === 'regex') return true;
    if (key === 'exact') return !(value.kind === 'literal' && value.value === true);
    return value.kind === 'object' && value.entries.some(([entry, item]) => partial(item, entry));
  };
  return call.args.some((arg) => partial(arg, undefined));
}

/**
 * A screen over the attempt's engine session whose every read passes the
 * secret ledger, wired like the attempt's own through the same factory.
 */
function redactingScreen(attempt: RunCodeAttempt): Screen {
  const runtime = attempt.agentRuntime;
  const redaction: NodeRedaction = { redact: runtime.redact, redactCut: runtime.redactCut };
  return createScreen(
    createScreenContext({
      session: readingRedacted(attempt.session, redaction),
      budget: attempt.budget,
      runId: attempt.runId,
      attemptId: attempt.attemptId,
      config: runtime.config,
      steps: runtime.steps,
      secrets: runtime.secrets,
      redaction,
      appOrigin: runtime.app.base?.origin,
    }),
  );
}

/**
 * The session with `read` answering each node through the ledger; every other
 * member is the session's own, which `createEngineSession` builds as plain
 * properties of one object.
 */
function readingRedacted(session: TargetSession, redaction: NodeRedaction): TargetSession {
  return { ...session, read: async (ref, operation) => redactNode(await session.read(ref, operation), redaction) };
}

/** Runs parsed statements on the session's fixtures. */
class LineRunner {
  private readonly screen: Screen;
  private readonly app: App;

  constructor(private readonly attempt: RunCodeAttempt) {
    this.screen = redactingScreen(attempt);
    this.app = attempt.fixtures.app;
  }

  async run(statement: Statement): Promise<unknown> {
    const { body } = statement;
    if (body.kind === 'call') {
      const value: unknown = await this.chain(body.chain);
      return body.read ? value : undefined;
    }
    const expectation = createAsyncExpectation(this.locator(this.chain(body.locator), 'expect'));
    await this.invoke(body.negated ? expectation.not : expectation, body.matcher);
    return undefined;
  }

  /** Walks a chain from its fixture: a query returns its locator at once, the last call its promise. */
  private chain(chain: Chain): unknown {
    let receiver: unknown = chain.root === 'screen' ? this.screen : this.app;
    for (const call of chain.calls) {
      const [first, second] = call.args;
      receiver =
        call.name === 'fill' && first?.kind === 'secret'
          ? this.fillSecret(this.locator(receiver, 'fill'), this.secret(first), this.fillTimeout(second))
          : this.invoke(receiver, call);
    }
    return receiver;
  }

  /** What a walked chain built, as the locator `expect` and a secret fill take: its expression and its screen. */
  private locator(value: unknown, api: string): LocatorInternals {
    const internals = locatorInternals(value);
    if (internals === undefined) throw new TestError('INVALID_ARGUMENT', `${api} takes a locator`);
    return internals;
  }

  /** Calls a member the grammar's table listed by this name, on the object it was listed for. */
  private invoke(receiver: unknown, call: Call): unknown {
    const method: unknown = Reflect.get(receiver as object, call.name);
    if (typeof method !== 'function') {
      throw new ConfigurationError('UNSUPPORTED_CAPABILITY', `${call.name} is not available on this target`);
    }
    return Reflect.apply(method, receiver, call.args.map((arg) => this.value(arg)));
  }

  /** An argument as the fixture receives it; a Secret stays a handle and goes through `fillSecret` only. */
  private value(value: Value): unknown {
    switch (value.kind) {
      case 'literal':
        return value.value;
      case 'regex':
        return new RegExp(value.source, value.flags);
      case 'array':
        return value.items.map((item) => this.value(item));
      case 'object': {
        // Defined, not assigned: a property named like a prototype member stays a plain own property.
        const object = {};
        for (const [key, item] of value.entries) {
          Object.defineProperty(object, key, { value: this.value(item), enumerable: true, writable: true, configurable: true });
        }
        return object;
      }
      case 'locator':
        return this.chain(value.chain);
      case 'username':
        return this.credential(value.credential).username;
      case 'secret':
        throw new TestError('INVALID_ARGUMENT', "a secret is accepted only as fill's value");
    }
  }

  private credential(name: string) {
    const credential = this.attempt.agentRuntime.config.credentials.get(name);
    if (credential === undefined) {
      throw new ConfigurationError('AUTH_CREDENTIAL_UNAVAILABLE', `credential "${name}" is not configured; add it to config.credentials or E2E_USER_* variables`);
    }
    return credential;
  }

  /** The handle a secret reference names, from the session's own config. */
  private secret(value: Extract<Value, { kind: 'secret' }>): Secret {
    if (value.from === 'credential') return secretHandle(this.credential(value.name).password);
    const secret = this.attempt.agentRuntime.config.secrets.get(value.name);
    if (secret === undefined) {
      throw new ConfigurationError('SECRET_UNAVAILABLE', `secret "${value.name}" is not configured; add it to config.secrets`);
    }
    return secretHandle(secret);
  }

  /**
   * `locator.fill(secret)` under the authorization `type_secret` runs: a
   * configured secret, an enabled editable field, and a password field for a
   * password, checked on the node the value lands on, every time the locator
   * resolves. A test's own `fill` skips this as trusted code; `run_code`
   * statements come from the coding agent, which is not.
   */
  private fillSecret(internals: LocatorInternals, secret: Secret, timeout: number | undefined): Promise<void> {
    const runtime = this.attempt.agentRuntime;
    const host = {
      recordPolicy: (policy: string, decision: 'allowed' | 'denied', code?: string) => recordPolicyEvent(runtime.steps, policy, decision, code),
    };
    const { engine, steps } = internals.context;
    return steps.run('locator', 'locator.fill', describeExpression(internals.expression), () =>
      engine.fillSecret(internals.expression, (node) => authorizeSecretFill(host, runtime, secret, node), timeout),
    );
  }

  /** The timeout in `fill`'s options, checked as `locator.fill` checks them. */
  private fillTimeout(value: Value | undefined): number | undefined {
    const options = value === undefined ? undefined : this.value(value);
    if (options !== undefined && !isPlainObject(options)) throw new TestError('INVALID_ARGUMENT', 'fill options must be a plain object');
    rejectUnknownOptions('fill', options, ['timeout']);
    const timeout = options?.['timeout'];
    if (timeout !== undefined && typeof timeout !== 'number') throw new TestError('INVALID_ARGUMENT', 'fill timeout must be a number of milliseconds');
    return timeout;
  }
}

/** The most lines the result spells out; a longer run shows its first and last ones. */
const MAX_LINES_SHOWN = 30;

/**
 * The result: how the program ended, what it logged, each test line, then the
 * screen. Code that returns or logs has said what it wants to see, so the
 * reads that passed are counted and not listed; otherwise each read shows its value.
 */
function render(result: SandboxResult, outcomes: readonly Outcome[], screen: string): string {
  const lines: string[] = [];
  if (result.error !== undefined) {
    const { code, message } = result.error;
    lines.push(`Failed: ${code === undefined || message.startsWith(code) ? message : `${code}: ${message}`}`, 'The app is where the lines that passed left it.');
  } else {
    lines.push(result.value === undefined ? 'Ran; the code returned nothing.' : `Returned: ${show(result.value)}`);
  }
  if (result.logs.length > 0) lines.push('console:', ...result.logs.map((log) => indent(log)));
  const spoke = result.value !== undefined || result.logs.length > 0;
  const listed = spoke ? outcomes.filter((outcome) => 'error' in outcome || !outcome.read) : outcomes;
  const reads = outcomes.length - listed.length;
  if (outcomes.length > 0) {
    const failed = outcomes.filter((outcome) => 'error' in outcome).length;
    const counts = [...(failed === 0 ? [] : [`${String(failed)} failed`]), ...(reads === 0 ? [] : [`${String(reads)} ${reads === 1 ? 'read' : 'reads'} not listed`])];
    lines.push(`Test lines: ${String(outcomes.length)}${counts.map((count) => `, ${count}`).join('')}.`);
    const numbered = listed.map((outcome, index) => ({ outcome, index }));
    const shown = numbered.length <= MAX_LINES_SHOWN ? numbered : [...numbered.slice(0, 10), ...numbered.slice(-10)];
    let previous = -1;
    for (const { outcome, index } of shown) {
      if (index !== previous + 1) lines.push(`   ... ${String(index - previous - 1)} more ...`);
      previous = index;
      const number = `${String(index + 1)}.`;
      if ('error' in outcome) {
        lines.push(`${number} failed: ${outcome.source}`, indent(`${outcome.error.code}: ${outcome.error.message}`));
      } else {
        const { value } = outcome;
        lines.push(`${number} ${outcome.source}${value === undefined ? '' : ` -> ${clip(show(value))}`}`);
      }
    }
  }
  return `${lines.join('\n')}\n\n${screen}`;
}

/** A value as JSON, so a string reads apart from the text around it and an empty one still shows. */
function show(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function clip(text: string): string {
  return text.length <= 200 ? text : `${text.slice(0, 200)}...`;
}

function indent(text: string): string {
  return text.split('\n').map((line) => `   ${line}`).join('\n');
}
