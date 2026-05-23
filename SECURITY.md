# Security Policy

## Supported versions

`auto-seed` is currently at **v1.x**. Only the latest minor of the `1.x` line receives security fixes.

| Version | Supported |
|---|---|
| 1.x     | ✅ |
| < 1.0   | ❌ |

## Reporting a vulnerability

**Please do not file public GitHub issues for security problems.**

Email **seif.kh021@gmail.com** with:

- A short description of the issue and its impact.
- Steps to reproduce (a minimal schema / command / config snippet if possible).
- The version of `auto-seed` you observed it on (`auto-seed --version`).
- Your Node.js version and OS.

You should expect:

- An acknowledgement within **3 business days**.
- A fix or written triage plan within **14 days** for confirmed issues.
- Credit in the release notes (unless you ask to remain anonymous).

If the issue is in a third-party dependency, I'll forward it upstream and track the patch.

## Threat model & what counts

`auto-seed` is a **developer CLI**. It:

- Reads schema files from the local working directory.
- Reads an API key from `~/.auto-seed/config.json` or environment variables.
- Makes outbound HTTPS calls to the configured LLM provider (Anthropic, OpenAI, or Google Gemini).
- Writes a `.sql` or `.ts` file to a path the user chooses.

In-scope concerns:

| Category | Examples |
|---|---|
| Secret handling | API keys leaking into logs, generated files, or error messages. `~/.auto-seed/config.json` permissions weakening. |
| Code injection | A malicious schema or `--hint` causing the renderer to emit unescaped output that could be unsafe when piped into SQL or evaluated as TypeScript. |
| Path traversal | A schema, plan path, or `--out` argument escaping the intended directory. |
| Supply chain | A vulnerable transitive dependency that becomes reachable via `auto-seed`. |
| Prompt injection that produces dangerous output | A schema/hint that coerces the LLM into emitting payloads which the renderer then writes verbatim. |

Out of scope:

- Reports that boil down to "if a malicious user runs my CLI with a malicious schema, bad things happen." Treat schema files as code you trust — same as a script.
- Vulnerabilities in third-party LLM endpoints themselves. (Please report those to the provider.)
- Anything that requires write access to `~/.auto-seed/` or the local source tree by an attacker who already has shell access.

## Safe-handling guidelines (for users)

These are good habits whether or not you've found a bug:

- Prefer **environment variables** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`) in CI; the config file is a developer-machine convenience.
- The config file is created with mode `0600`. If you copy it across machines, preserve that mode (`chmod 600 ~/.auto-seed/config.json`).
- Never commit `~/.auto-seed/config.json`, generated seed files containing real production data, or anything inside `.env*` to source control.
- Generated `.sql` and `.ts` seed files contain mock data only; do not feed real PII through the tool.

## Hardening notes

- API keys are **never** included in generated seed files or in `console.log` output. They are masked (`sk-…abcd`) in `config list` / `config get`.
- All SQL string values pass through `''`-escape encoding; identifiers are double-quoted (Postgres/SQLite) or backtick-quoted (MySQL).
- File writes are atomic (write-to-temp + `rename`).
- Overwriting an existing file requires either an interactive confirmation or `--yes`.
- The LLM is asked to return JSON only; the response is parsed inside a `try` and validated with Zod. Bad JSON triggers exactly one retry with the validation error appended, then a clean exit code `3`.

## Public security disclosures

None yet. This section will be updated when the first one lands.
