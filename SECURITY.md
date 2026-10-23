# Security policy

SplitMind stores credentials for your accounts. Please report security issues
privately.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the repository's
**Security** tab and choose **Report a vulnerability**. Include what you found,
how to reproduce it, and the commit or release you tested.

We aim to acknowledge reports within a few days. If the issue is in
OpenConnector itself, we will help report it upstream.

## Never put secrets in issues

Do not paste tokens, API keys, encryption keys, admin tokens, OAuth client
secrets, Worker URLs or account IDs into issues, pull requests, discussions or
logs. Redact them first, for example `xoxb-REDACTED`.

If you leaked a secret here by accident, rotate it first (revoke it at the
provider and create a new one), then tell us so we can remove the content.

## Scope

In scope: the scripts, configuration templates, patches and docs in this
repository, and the way they configure OpenConnector. Issues in OpenConnector's
own code belong upstream at https://github.com/oomol-lab/open-connector.
