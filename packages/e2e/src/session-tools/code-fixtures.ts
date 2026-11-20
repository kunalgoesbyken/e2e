/**
 * Calls `run_code`'s JavaScript makes on the fixtures the target's engine
 * contributes (`browser`, `device`): any member a test calls, by name. Core
 * has no table of those members, so nothing here is parsed against one. A
 * call crosses from the sandbox as data, a member path and encoded arguments,
 * and three rules hold in place of a grammar: a path never reaches what
 * every object inherits (`constructor`, `__proto__`), a function the code
 * passes is only ever read as source and never called here, and every value
 * that goes back passes the secret ledger. An object that is not plain data,
 * such as a locator, a tab, or a function, stays here under a number the code holds.
 */

import { TestError } from '@e2e-dev/core/lib/internal/errors';
import { z } from 'zod';

type Encoded =
  | { readonly t: 'undefined' }
  | { readonly t: 'value'; readonly v: string | number | boolean | null }
  | { readonly t: 'function'; readonly s: string }
  | { readonly t: 'regex'; readonly s: string; readonly f: string }
  | { readonly t: 'handle'; readonly id: number }
  | { readonly t: 'array'; readonly v: readonly Encoded[] }
  | { readonly t: 'object'; readonly v: readonly (readonly [string, Encoded])[] };

const ENCODED: z.ZodType<Encoded> = z.lazy(() =>
  z.discriminatedUnion('t', [
    z.object({ t: z.literal('undefined') }),
    z.object({ t: z.literal('value'), v: z.union([z.string(), z.number(), z.boolean(), z.null()]) }),
    z.object({ t: z.literal('function'), s: z.string() }),
    z.object({ t: z.literal('regex'), s: z.string(), f: z.string() }),
    z.object({ t: z.literal('handle'), id: z.number().int().nonnegative() }),
    z.object({ t: z.literal('array'), v: z.array(ENCODED) }),
    z.object({ t: z.literal('object'), v: z.array(z.tuple([z.string(), ENCODED])) }),
  ]),
);

/** One read or call on a fixture, or on an object an earlier call returned, as the sandbox sends it. */
const REQUEST = z.object({
  base: z.union([z.object({ root: z.string() }), z.object({ handle: z.number().int().nonnegative() })]),
  path: z.array(z.string()),
  /** Present for a call, absent for a read of the member at `path`. */
  args: z.array(ENCODED).optional(),
  /** The expression as the code wrote it, for the result's listing and `test_lines`. */
  source: z.string(),
});

export type FixtureRequest = z.infer<typeof REQUEST>;

/** What a call came to: plain data, or the number of an object kept on the host. */
export type FixtureResult = { readonly value: unknown } | { readonly handle: number };

/** Members every object or function inherits, which lead out of the fixture to the host. */
const INHERITED = new Set(['constructor', '__proto__', 'prototype']);
const MAX_DEPTH = 50;

export function parseFixtureRequest(payload: string): FixtureRequest {
  const parsed = REQUEST.safeParse(JSON.parse(payload));
  if (!parsed.success) throw new TestError('INVALID_ARGUMENT', 'run_code: a call on an engine fixture is not in the shape the sandbox sends');
  return parsed.data;
}

/** The engine fixtures of one `run_code` call, and the objects its calls returned. */
export class FixtureCalls {
  private readonly handles: object[] = [];

  constructor(
    /** Reads a fixture by its name; `undefined` for a name the engine does not contribute. */
    private readonly root: (name: string) => unknown,
    private readonly redact: (text: string) => string,
  ) {}

  async run(request: FixtureRequest): Promise<FixtureResult> {
    const { path, args } = request;
    let receiver: unknown = 'root' in request.base ? this.root(request.base.root) : this.handles[request.base.handle];
    if (receiver === undefined) throw new TestError('INVALID_ARGUMENT', `run_code: ${request.source} starts from nothing this session has`);
    const read = args === undefined ? path : path.slice(0, -1);
    for (const name of read) receiver = member(receiver, name, request.source);
    if (args === undefined) return this.result(await receiver);
    const name = path.at(-1);
    // With no member named, the call is on a function an earlier call returned, such as what takes a handler off.
    const method = name === undefined ? receiver : member(receiver, name, request.source);
    if (typeof method !== 'function') throw new TestError('INVALID_ARGUMENT', `run_code: ${request.source} calls what is not a function`);
    const value: unknown = await Reflect.apply(method, name === undefined ? undefined : receiver, args.map((arg) => this.argument(arg)));
    return this.result(value);
  }

  private argument(encoded: Encoded): unknown {
    switch (encoded.t) {
      case 'undefined':
        return undefined;
      case 'value':
        return encoded.v;
      case 'regex':
        return new RegExp(encoded.s, encoded.f);
      case 'function':
        return sourceOnly(encoded.s);
      case 'handle': {
        const held = this.handles[encoded.id];
        if (held === undefined) throw new TestError('INVALID_ARGUMENT', 'run_code: an argument is an object from an earlier run_code call; get it again in this one');
        return held;
      }
      case 'array':
        return encoded.v.map((item) => this.argument(item));
      case 'object': {
        // Defined, not assigned: a property named like a prototype member stays a plain own property.
        const object = {};
        for (const [key, item] of encoded.v) Object.defineProperty(object, key, { value: this.argument(item), enumerable: true, writable: true, configurable: true });
        return object;
      }
    }
  }

  private result(value: unknown): FixtureResult {
    if (isData(value, 0)) return { value: this.redacted(value) };
    this.handles.push(value as object);
    return { handle: this.handles.length - 1 };
  }

  private redacted(value: unknown): unknown {
    if (typeof value === 'string') return this.redact(value);
    if (typeof value === 'bigint') return this.redact(String(value));
    if (Array.isArray(value)) return value.map((item) => this.redacted(item));
    if (typeof value !== 'object' || value === null) return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [this.redact(key), this.redacted(item)]));
  }
}

/** The member `name` of `owner`, unless it is one every object inherits. */
function member(owner: unknown, name: string, source: string): unknown {
  if ((typeof owner !== 'object' && typeof owner !== 'function') || owner === null) {
    throw new TestError('INVALID_ARGUMENT', `run_code: ${source} reads "${name}" on a value, not an object; await the value first`);
  }
  for (let holder: object | null = owner; holder !== null; holder = Reflect.getPrototypeOf(holder)) {
    if (!Object.hasOwn(holder, name)) continue;
    if (INHERITED.has(name) || holder === Object.prototype || holder === Function.prototype) break;
    return Reflect.get(owner, name);
  }
  throw new TestError('INVALID_ARGUMENT', `run_code: "${name}" in ${source} is not a member the fixture has`);
}

/** A function that only gives its source, as a page function is read; the host never runs the code's own functions. */
function sourceOnly(source: string): () => never {
  const stub = (): never => {
    throw new TestError('INVALID_ARGUMENT', 'run_code: a function the code passes runs only where the fixture sends its source, as evaluate does; a handler the host would call is not supported');
  };
  Object.defineProperty(stub, 'toString', { value: () => source });
  return stub;
}

/** Whether a value is plain data all the way down, so it can go back to the code as itself. */
function isData(value: unknown, depth: number): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return true;
  if (typeof value !== 'object' || depth > MAX_DEPTH) return false;
  if (Array.isArray(value)) return value.every((item) => isData(item, depth + 1));
  const prototype: unknown = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every((item) => isData(item, depth + 1));
}
