---
"e2e": patch
---

`e2e mcp`'s `run_code` now runs JavaScript in a sandbox: variables, loops, `try`/`catch`, return values, and `console.log`, with `screen`, `app`, `expect`, `credentials`, `secrets`, and the engine's fixture (`browser` or `device`) in scope. Each call on `screen`, `app`, or `expect` still runs as one test line under the same grammar and secret checks, and any member of the engine's fixture can be called, such as `browser.evaluate`, so an agent reads, computes, and acts in one call. The result format changed: it shows what the code returned, then each line that ran. `open_session` lists the API the code can call.
