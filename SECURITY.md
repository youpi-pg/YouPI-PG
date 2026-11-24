# Security Policy

The YouPI-PG team takes the security of our self-hosted payment gateway software seriously. We appreciate the responsible disclosure of security vulnerabilities by security researchers, merchants, and the open-source community.

## Supported Versions

Only the latest major version branch receives security updates.

| Version | Supported          |
| :---    | :---               |
| 2.x     | :white_check_mark: |
| 1.x     | :x:                |
| < 1.0   | :x:                |

## Reporting a Vulnerability

**Please do NOT report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

### Preferred Reporting Method

1. **GitHub Private Vulnerability Reporting**:
   If enabled on this repository, please submit your report via [GitHub Security Advisories](https://github.com/youpi-pg/YouPI-PG/security/advisories/new). This creates a private draft advisory where we can collaborate with you directly on a patch before public disclosure.

2. **Alternative Reporting**:
   If Private Vulnerability Reporting is not yet enabled on the upstream repository, please open an issue requesting the maintainers enable it (as done in [#146](https://github.com/youpi-pg/YouPI-PG/issues/146)) without disclosing sensitive exploit details, or contact the core maintainers privately.

### What to Include in Your Report

To help us triage and resolve your report quickly, please include:
- A clear description of the vulnerability and its potential impact.
- Step-by-step reproduction instructions or a minimal Proof of Concept (PoC).
- Affected components (e.g., webhook engine, payment session state machine, webhook URL validation, API endpoints).
- Any suggested mitigations or patches if available.

## Vulnerability Handling Process

1. **Acknowledgment**: We aim to acknowledge receipt of your vulnerability report within 48–72 hours.
2. **Investigation & Triage**: We will verify the issue in an isolated development environment and assess severity.
3. **Remediation**: A fix will be developed and verified in a private security advisory branch.
4. **Coordinated Disclosure**: Once a patch is merged and released in a tagged version, a GitHub Security Advisory (GHSA) and CVE identifier (if applicable) will be published crediting the reporter.

## Scope & Critical Areas

Key security-sensitive areas of YouPI-PG include:
- **Payment Verification & Attribution**: Preventing forged or duplicate SMS/UTR attributions from marking orders paid.
- **Webhook Integrity & SSRF**: Outbound webhook URL validation, preventing metadata service or intranet SSRF.
- **HMAC Signatures**: Raw-body webhook signature verification and timing-attack resistance.
- **Secrets Management**: Safe generation and storage of merchant signing keys, session tokens, and database credentials.

## Safe Harbor

Activities conducted in good faith under this policy will be considered authorized conduct:
- We will not pursue legal action against researchers for accidental, good-faith violations of this policy.
- Please do not access or modify merchant/user data that does not belong to you during testing.
- Please do not perform denial-of-service (DoS) attacks or degrade services for active deployments.
