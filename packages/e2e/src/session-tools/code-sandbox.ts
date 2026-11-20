/**
 * Where `run_code`'s JavaScript runs: a fresh QuickJS context in a worker
 * (`run`), with no Node globals, modules, timers, or network. The guest gets `screen`, `app`,
 * `expect`, `credentials`, and `secrets` as proxies that hold no capability:
 * each one only writes down the test line a chain spells, and a chain that
 * ends in an action, a read, or a matcher sends that line to the host. The
 * host parses the line with the closed grammar of `code-parse.ts` and runs it
 * as it always has, so the sandbox decides what the program computes and the
 * grammar still decides what reaches the app. A fixture the engine
 * contributes (`browser`, `device`) is a proxy of another kind: each read or
 * call on it goes to the host as a member path and data (`code-fixtures.ts`).
 */

import { z } from 'zod';
import { SURFACE } from './code-surface.ts';

/** What the host answers one line with: its value, or the code and message it failed with. */
export type LineReply = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly code: string; readonly message: string };

/** A line's reply, or the number of an object the host kept for the code. */
export type CallReply = LineReply | { readonly ok: true; readonly handle: number };

export interface SandboxOptions {
  readonly code: string;
  /** Runs one test line the guest spelled; never throws. */
  readonly line: (source: string) => Promise<LineReply>;
  /** The names of the engine's fixtures, each in the code's scope as an object whose members `call` runs. */
  readonly fixtures?: readonly string[] | undefined;
  /** Runs one read or call on an engine fixture, from the payload the guest encoded; never throws. */
  readonly call?: ((payload: string) => Promise<CallReply>) | undefined;
  readonly signal: AbortSignal | undefined;
  /** The wall-clock ceiling of the whole program, waits on the app included. */
  readonly timeoutMs: number;
}

/** How the program ended: what it returned or the error that stopped it, and what it logged. */
export interface SandboxResult {
  readonly value: unknown;
  readonly error: { readonly code: string | undefined; readonly message: string } | undefined;
  readonly logs: readonly string[];
}

/** The longest the guest's own JavaScript may run, waits on the app excluded. */
const CPU_TIMEOUT_MS = 5_000;
const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
/** The most lines and sleeps one program may ask the host for. */
const MAX_BRIDGE_REQUESTS = 1_000;
/** The longest one `setTimeout` waits. */
const MAX_SLEEP_MS = 10_000;

/** Names a Playwright habit reaches for, and the e2e member that does the same. */
const ALIASES: Readonly<Record<string, string>> = {
  scrollIntoViewIfNeeded: 'scrollIntoView',
  innerText: 'textContent',
  allInnerTexts: 'allTextContents',
};

const QUERIES = [...SURFACE.locator].flatMap(([name, member]) => (member.kind === 'query' ? [name] : []));

/**
 * The guest's side, written in the JavaScript it runs beside. A locator proxy
 * answers `then` with undefined so awaiting one does not call the host.
 */
const PRELUDE = `
const __queries = new Set(${JSON.stringify(QUERIES)});
const __logs = [];
const __quote = (text) => "'" + text.replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'").replace(/\\n/g, '\\\\n').replace(/\\r/g, '\\\\r').replace(/\\u2028/g, '\\\\u2028').replace(/\\u2029/g, '\\\\u2029') + "'";
const __refuse = (message) => { const error = new Error('INVALID_ARGUMENT: ' + message); error.code = 'INVALID_ARGUMENT'; throw error; };
const __lit = (value, loose) => {
  if (typeof value === 'string') return __quote(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof RegExp) return String(value);
  if (typeof value === 'function' || (typeof value === 'object' && typeof value.__src === 'string')) {
    if (typeof value.__src === 'string') return value.__src;
    if (loose) return typeof value.__text === 'string' ? value.__text : Function.prototype.toString.call(value);
    __refuse('a function is not an argument a test line takes');
  }
  if (Array.isArray(value)) return '[' + value.map((item) => __lit(item, loose)).join(', ') + ']';
  if (typeof value === 'object') return '{ ' + Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => (/^[A-Za-z_$][\\w$]*$/.test(key) ? key : __quote(key)) + ': ' + __lit(item, loose)).join(', ') + ' }';
  __refuse('a ' + typeof value + ' is not an argument a test line takes');
};
const __args = (values, loose) => { while (values.length > 0 && values[values.length - 1] === undefined) values.pop(); return values.map((value) => __lit(value, loose)).join(', '); };
const __aliases = new Map(Object.entries(${JSON.stringify(ALIASES)}));
const __pending = new Set();
const __track = (sent) => {
  __pending.add(sent);
  const settled = () => { __pending.delete(sent); };
  sent.then(settled, settled);
  return sent;
};
const __reply = (reply) => {
  if (reply.ok) return reply;
  const error = new Error(reply.code + ': ' + reply.message);
  error.code = reply.code;
  throw error;
};
// One line at the host at a time, in the order the code made them. Lines made without waiting for one that then
// fails do not run, as a test stops at its first failure; a line made after the failure reached the code does.
let __tail = Promise.resolve();
let __made = 0;
let __stoppedThrough = 0;
const __inTurn = (ask) => {
  const place = ++__made;
  const turn = __tail.then(async () => {
    if (place <= __stoppedThrough) return { ok: false, code: 'CANCELLED', message: 'a line before this one failed, and this one was made without waiting for it, so it did not run; await each line' };
    const reply = JSON.parse(await ask());
    if (!reply.ok && reply.code !== 'CANCELLED') __stoppedThrough = __made;
    return reply;
  });
  __tail = turn.catch(() => {});
  return turn;
};
const __send = (source) => __track((async () => __reply(await __inTurn(() => __line(source))).value)());
// Lines the code did not await and timers it set still run to their end, so the result shows them and the app is
// where they left it. Answers the first failure among them: nothing in the code was there to catch it.
const __settle = async () => {
  if (__pending.size > 0) __logs.push(String(__pending.size) + ' call(s) on the app were not awaited when the code ended; they ran, but await each one so a failure stops the code.');
  const lost = [];
  while (__pending.size > 0 || __timers.size > 0) {
    for (const line of await Promise.allSettled([...__pending])) if (line.status === 'rejected') lost.push(line.reason);
    await Promise.all([...__timers.values()]);
  }
  return [...lost, ...__thrown][0];
};
const __chain = (source, ends) => new Proxy(function () {}, {
  get: (_, name) => {
    if (name === '__src') return source;
    // A chain put into a string reads as its source, not as a line to run.
    if (name === Symbol.toPrimitive || name === 'toString' || name === 'valueOf') return () => source;
    if (typeof name !== 'string' || name === 'then' || name === 'toJSON') return undefined;
    return (...values) => {
      const scroll = name === 'scroll';
      const member = scroll ? 'swipe' : __aliases.get(name) ?? name;
      const given = scroll ? [{ direction: typeof values[0] === 'string' ? values[0] : (values[0] && values[0].direction) || 'down' }] : values;
      const next = source + '.' + member + '(' + __args(given) + ')';
      return !ends && __queries.has(member) ? __chain(next, false) : __send('await ' + next + ';');
    };
  },
});
const screen = __chain('screen', false);
const app = __chain('app', true);
const credentials = { user: (name) => ({ username: { __src: 'credentials.user(' + __quote(String(name)) + ').username' }, password: { __src: 'credentials.user(' + __quote(String(name)) + ').password' } }) };
const secrets = { get: (name) => ({ __src: 'secrets.get(' + __quote(String(name)) + ')' }) };
const __show = (value) => { if (typeof value === 'string') return value; if (value instanceof RegExp) return String(value); try { return JSON.stringify(value) ?? String(value); } catch { return String(value); } };
const __fail = (message) => { const error = new Error('ASSERTION_FAILED: ' + message); error.code = 'ASSERTION_FAILED'; throw error; };
// Equality as the test API's expect has it for plain data: key order aside, an undefined property as a missing one.
const __same = (a, b) => {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  for (const value of [a, b]) if (value instanceof Map || value instanceof Set) __refuse('expect(value) compares plain data here; turn a Map or Set into an array first');
  if (a instanceof RegExp || b instanceof RegExp) return a instanceof RegExp && b instanceof RegExp && a.source === b.source && a.flags === b.flags;
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => __same(item, b[index]));
  const keys = (object) => Object.keys(object).filter((key) => object[key] !== undefined);
  return keys(a).length === keys(b).length && keys(a).every((key) => Object.hasOwn(b, key) && __same(a[key], b[key]));
};
const __contains = (actual, expected) => {
  if (typeof actual === 'string') return typeof expected === 'string' ? actual.includes(expected) : __fail('toContain on a string requires a string, got ' + __show(expected));
  if (!Array.isArray(actual)) __fail('toContain requires a string or an array, got ' + __show(actual));
  return actual.some((item) => __same(item, expected));
};
// A global or sticky RegExp keeps lastIndex between tests, so the match runs on a copy without those flags.
const __matches = (actual, expected) => {
  if (typeof actual !== 'string') __fail('toMatch requires a string, got ' + __show(actual));
  return expected instanceof RegExp ? new RegExp(expected.source, expected.flags.replace(/[gy]/g, '')).test(actual) : actual.includes(String(expected));
};
const __values = (actual, negated) => {
  const check = (pass, message) => { if (pass === negated) __fail('expected ' + __show(actual) + (negated ? ' not ' : ' ') + message); };
  return {
    toBe: (expected) => check(Object.is(actual, expected), 'to be ' + __show(expected)),
    toEqual: (expected) => check(__same(actual, expected), 'to equal ' + __show(expected)),
    toStrictEqual: (expected) => check(__same(actual, expected), 'to equal ' + __show(expected)),
    toContain: (expected) => check(__contains(actual, expected), 'to contain ' + __show(expected)),
    toMatch: (expected) => check(__matches(actual, expected), 'to match ' + String(expected)),
    toHaveLength: (expected) => check(actual != null && actual.length === expected, 'to have length ' + String(expected)),
    toBeGreaterThan: (expected) => check(actual > expected, 'to be greater than ' + __show(expected)),
    toBeGreaterThanOrEqual: (expected) => check(actual >= expected, 'to be at least ' + __show(expected)),
    toBeLessThan: (expected) => check(actual < expected, 'to be less than ' + __show(expected)),
    toBeLessThanOrEqual: (expected) => check(actual <= expected, 'to be at most ' + __show(expected)),
    toBeTruthy: () => check(Boolean(actual), 'to be truthy'),
    toBeFalsy: () => check(!actual, 'to be falsy'),
    toBeNull: () => check(actual === null, 'to be null'),
    toBeUndefined: () => check(actual === undefined, 'to be undefined'),
    toBeDefined: () => check(actual !== undefined, 'to be defined'),
  };
};
const expect = (actual) => {
  if (actual == null || typeof actual.__src !== 'string') return { ...__values(actual, false), not: __values(actual, true) };
  const matchers = (prefix) => new Proxy({}, {
    get: (_, name) => {
      if (typeof name !== 'string' || name === 'then') return undefined;
      if (name === 'not') return matchers(prefix + '.not');
      return (...values) => __send('await ' + prefix + '.' + name + '(' + __args(values) + ');');
    },
  });
  return matchers('expect(' + actual.__src + ')');
};
// An engine fixture, or an object one of its calls returned: the host holds it, and each read or call on it goes there.
const __encode = (value) => {
  if (value === undefined) return { t: 'undefined' };
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return { t: 'value', v: value };
  if (value instanceof RegExp) return { t: 'regex', s: value.source, f: value.flags };
  if (typeof value === 'function') {
    if (typeof value.__handle === 'number') return { t: 'handle', id: value.__handle };
    if (typeof value.__text === 'string') __refuse(value.__text + ' is not awaited; await it before passing it on');
    return { t: 'function', s: Function.prototype.toString.call(value) };
  }
  if (typeof value.__src === 'string') __refuse(value.__src + ' is a locator or secret of screen, which a call on an engine fixture does not take');
  if (Array.isArray(value)) return { t: 'array', v: value.map(__encode) };
  if (typeof value === 'object') return { t: 'object', v: Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, __encode(item)]) };
  __refuse('a ' + typeof value + ' is not an argument a call takes');
};
const __request = (base, path, values, text) => __track((async () => {
  let from = base;
  if (base.after !== undefined) {
    const held = await base.after;
    if (held == null || typeof held.__handle !== 'number') __refuse(text + ' reads or calls a value, not an object; await the value first');
    from = { handle: held.__handle };
  }
  const args = values === undefined ? undefined : values.map(__encode);
  const reply = __reply(await __inTurn(() => __e2e.call(JSON.stringify({ base: from, path, args, source: text }))));
  return reply.handle === undefined ? reply.value : __remote({ handle: reply.handle }, text, []);
})());
const __told = (text) => (name) => (name === '__text' ? text : name === Symbol.toPrimitive || name === 'toString' || name === 'valueOf' ? () => text : undefined);
const __remote = (base, source, path) => {
  const text = [source, ...path].join('.');
  const told = __told(text);
  return new Proxy(function () {}, {
    get: (_, name) => {
      if (name === '__handle') return path.length === 0 ? base.handle : undefined;
      if (told(name) !== undefined) return told(name);
      if (typeof name !== 'string' || name === 'toJSON' || name === '__src') return undefined;
      if (name === 'then') {
        if (path.length === 0) return undefined;
        const read = __request(base, path, undefined, text);
        return read.then.bind(read);
      }
      return __remote(base, source, [...path, name]);
    },
    apply: (_, __, values) => {
      const called = text + '(' + __args([...values], true) + ')';
      const result = __request(base, path, values, called);
      // What a call returns can be awaited, or read on before it settles: browser.locator('.row').click().
      const toldCall = __told(called);
      return new Proxy(function () {}, {
        get: (_, name) => {
          if (name === 'then' || name === 'catch' || name === 'finally') return result[name].bind(result);
          if (toldCall(name) !== undefined) return toldCall(name);
          if (typeof name !== 'string' || name === 'toJSON' || name === '__src' || name === '__handle') return undefined;
          return __remote({ after: result }, called, [name]);
        },
        apply: (_, __, values) => Reflect.apply(__remote({ after: result }, called, []), undefined, values),
      });
    },
  });
};
const __log = (...values) => { __logs.push(values.map(__show).join(' ')); };
// Passed to the code as parameters, since the runtime's own console cannot be replaced.
const __console = { log: __log, info: __log, debug: __log, warn: __log, error: __log };
// A timer's callback runs with nothing awaiting it, so what it throws is kept for the program's end.
const __timers = new Map();
const __thrown = [];
let __timer = 0;
const __setTimeout = (callback, ms, ...values) => {
  const id = ++__timer;
  __timers.set(id, __sleep(Number(ms) || 0).then(() => (__timers.has(id) ? callback(...values) : undefined)).catch((error) => { __thrown.push(error); }).finally(() => { __timers.delete(id); }));
  return id;
};
const __clearTimeout = (id) => { __timers.delete(id); };
`;

/** What the program returns, as its own last lines write it. */
const SETTLED = z.object({
  value: z.unknown().optional(),
  error: z.object({ code: z.string().optional(), message: z.string() }).optional(),
  logs: z.array(z.string()),
});

/** Every name the code has in scope, for the error a name outside it gets. */
const scope = (fixtures: readonly string[]): string => ['screen', 'app', ...fixtures, 'expect', 'credentials', 'secrets', 'console'].join(', ') + ', and setTimeout';

/** What the program puts ahead of the code, up to the line the code starts on. */
const head = (fixtures: readonly string[]): string => `const __line = (source) => __e2e.line(source);
const __sleep = (ms) => __e2e.sleep(ms);
${PRELUDE}
try {
  const __value = await (async (${['console', 'setTimeout', 'clearTimeout', ...fixtures].join(', ')}) => {
`;
const HEAD_LINES = head([]).split('\n').length - 1;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** The guest's program around the code: its value or its error, with what it logged either way, as JSON. */
function program(code: string, fixtures: readonly string[]): string {
  return `${head(fixtures)}${code}
  })(${['__console', '__setTimeout', '__clearTimeout', ...fixtures.map((name) => `__remote({ root: ${JSON.stringify(name)} }, ${JSON.stringify(name)}, [])`)].join(', ')});
  const __lost = await __settle();
  if (__lost !== undefined) throw __lost;
  return JSON.stringify({ value: __value, logs: __logs });
} catch (error) {
  await __settle();
  if (error instanceof ReferenceError) return JSON.stringify({ error: { code: 'INVALID_ARGUMENT', message: 'run_code: ' + error.message + '; the code has ${scope(fixtures)}' }, logs: __logs });
  return JSON.stringify({ error: { code: error && typeof error.code === 'string' ? error.code : undefined, message: error instanceof Error ? (error.code ? error.message : error.name + ': ' + error.message) : __show(error) }, logs: __logs });
}`;
}

/** Runs `code` in the sandbox; a failure of the sandbox itself, such as a limit, comes back as the program's error. */
export async function runInSandbox(options: SandboxOptions): Promise<SandboxResult> {
  const { run, RunCpuTimeoutError, RunTimeoutError, RunBridgeLimitError } = await import('run');
  // One line at a time: the attempt's budget caps one body, and the app has one screen.
  let queue: Promise<unknown> = Promise.resolve();
  // Set once the program is over, however it ended: a line still queued then never reaches the app.
  let over = false;
  const queued = (answer: ((source: string) => Promise<CallReply>) | undefined) => (source: unknown): Promise<string> => {
    if (typeof source !== 'string' || answer === undefined) return Promise.resolve(JSON.stringify({ ok: false, code: 'INVALID_ARGUMENT', message: 'a line is a string' } satisfies LineReply));
    const reply = queue
      .then((): CallReply | Promise<CallReply> =>
        over || options.signal?.aborted === true ? { ok: false, code: 'CANCELLED', message: 'the call ended before this line ran' } : answer(source),
      )
      .then((settled) => JSON.stringify(settled));
    queue = reply.catch(() => undefined);
    return reply;
  };
  const fixtures = (options.fixtures ?? []).filter((name) => IDENTIFIER.test(name));
  const sleep = (ms: unknown): Promise<null> =>
    new Promise((resolve) => setTimeout(() => resolve(null), Math.min(Math.max(typeof ms === 'number' ? ms : 0, 0), MAX_SLEEP_MS)));
  const restoreWarnings = withoutTypeStrippingWarning();
  try {
    const result = await run<string>({
      source: program(options.code, fixtures),
      hostFunctions: { __e2e: { line: queued(options.line), call: queued(options.call), sleep } },
      ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
      limits: {
        timeoutMs: options.timeoutMs,
        cpuTimeoutMs: CPU_TIMEOUT_MS,
        memoryLimitBytes: MEMORY_LIMIT_BYTES,
        maxBridgeRequests: MAX_BRIDGE_REQUESTS,
        // Lines run one at a time here, so the code may have any number of them waiting.
        maxInFlightBridgeRequests: MAX_BRIDGE_REQUESTS,
        // The runtime's own console writes to the server's stdout, which the MCP stream owns; one byte is the least the limit takes.
        maxConsoleOutputBytes: 1,
      },
    });
    if (result.status !== 'completed') return { value: undefined, error: { code: 'ERROR', message: 'the code was interrupted' }, logs: [] };
    const settled = SETTLED.parse(JSON.parse(result.value));
    const { error } = settled;
    return { value: settled.value, error: error === undefined ? undefined : { code: error.code, message: error.message }, logs: settled.logs };
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'SyntaxError') {
      return { value: undefined, error: { code: 'INVALID_ARGUMENT', message: `run_code: the code does not parse${syntaxPosition(cause)}: ${cause.message}` }, logs: [] };
    }
    const message =
      cause instanceof RunCpuTimeoutError
        ? `the code ran for more than ${String(CPU_TIMEOUT_MS)} ms of its own; a loop that waits on the app is fine, one that spins is not`
        : cause instanceof RunTimeoutError
          ? `the code did not finish within ${String(options.timeoutMs)} ms`
          : cause instanceof RunBridgeLimitError
            ? `the code crossed a limit of one call (${String(MAX_BRIDGE_REQUESTS)} lines and waits): ${cause.message}`
            : cause instanceof Error
              ? cause.message
              : String(cause);
    return { value: undefined, error: { code: undefined, message }, logs: [] };
  } finally {
    over = true;
    // The line the app is in the middle of settles before the result is read; the ones behind it are refused above.
    await queue;
    restoreWarnings();
  }
}

/** ` at line:column` of a syntax error in the code, from the frame the runtime reports against the whole program. */
function syntaxPosition(error: Error): string {
  const frame = /run\.js:(\d+):(\d+)/.exec(error.stack ?? '');
  if (frame === null) return '';
  const line = Number(frame[1]) - HEAD_LINES;
  return line < 1 ? '' : ` at ${String(line)}:${frame[2]!}`;
}

/**
 * Drops Node's ExperimentalWarning for the type stripping the runtime applies
 * to every source, which would otherwise print to the server's stderr on the
 * first call. Returns what puts the process's own `emitWarning` back.
 */
function withoutTypeStrippingWarning(): () => void {
  if (filtering === undefined) {
    const emitWarning = process.emitWarning;
    const filtered = (...args: Parameters<typeof process.emitWarning>): void => {
      if (String(args[0]).includes('stripTypeScriptTypes')) return;
      emitWarning.apply(process, args);
    };
    process.emitWarning = filtered as typeof process.emitWarning;
    filtering = { programs: 0, restore: () => { if (process.emitWarning === filtered) process.emitWarning = emitWarning; } };
  }
  const active = filtering;
  active.programs++;
  return () => {
    active.programs--;
    if (active.programs > 0) return;
    active.restore();
    filtering = undefined;
  };
}

/** The filter in place while any program runs: sessions run programs at once, and each must not undo another's. */
let filtering: { programs: number; restore: () => void } | undefined;
