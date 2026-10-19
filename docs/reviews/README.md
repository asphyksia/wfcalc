# Beta reviews

A beta review is a short, dated record of what was tested and what was found. It gives the
reviewer visible credit and gives the project a reproducible trail from a report to a fix.

## How to submit one

1. Copy [`TEMPLATE.md`](TEMPLATE.md) to `YYYY-MM-DD-<handle>.md`.
2. Fill in the commit or version you tested, the exact commands/builds, and what you expected
   versus what you saw.
3. Open a PR with the file; add your handle to `CONTRIBUTORS.md` if you want to be listed.
4. If a finding leads to a change, the fix's commit can carry `Reported-by: @handle` or
   `Reviewed-by: @handle`.

Use a GitHub handle (or the name you prefer). Do not include emails, real names or other
personal data without consent.

## Status values

- `open` — confirmed, not fixed
- `fixed` — a commit or release addresses it
- `wontfix` — explained and accepted as out of scope
- `unconfirmed` — could not reproduce
