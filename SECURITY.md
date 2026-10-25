# Security Policy

## Supported versions

The project is pre-alpha; only the `main` branch receives fixes.

## Reporting a vulnerability

Do not open a public issue for security problems. Use [GitHub private vulnerability reporting](../../security/advisories/new) and describe:

- the problem and its impact (e.g. cookies/headers leaking to another domain, code from a page being executed, writes outside the downloads folder);
- steps to reproduce;
- browser and version.

You will receive a response as soon as possible. Fixes are published with credit to the reporter, if desired.

## Sensitive surfaces

- `declarativeNetRequest` rules that reapply `Cookie`/`Referer`: they must apply only to the extension's own requests and be removed at the end of each download.
- Data coming from pages (manifests, titles, URLs) is always treated as untrusted and validated.
- No remote code is loaded or executed.
