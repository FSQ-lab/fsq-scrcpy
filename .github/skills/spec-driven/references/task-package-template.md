# Compact Task Package

任务包是决策与固定输入的清单，不是 SPEC、设计、diff 或日志的副本。建议正文不超过 8 KiB；超出时先移出原始证据并用 URI、SHA-256 和 selector 引用。

```yaml
taskId: <stable-id>
featureId: <stable-id>
authorization:
  exactText: <用户显式入口原文>
  scope: <授权边界>
repository:
  root: <absolute-path>
  branch: <branch|unborn>
  head: <sha|unborn>
  initialStatus: <artifact-uri + sha256 + bytes>
featureBaseline:
  kind: accepted-tree | pre-task-snapshot | unborn
  identity: <commit/tree or manifest URI + sha256 + bytes>
  preExistingChanges: <artifact URI; none if clean>
specDecision:
  kind: delta-confirmed | no-delta
  basis: <activeInput selector(s) and observable defect/change>
platform: <host/source/connection/runtime | n/a>
module: <one module | process>
dependencies:
  acceptedFeatures: [<id>]
  selection:
    applicability: applicable | not-applicable
    decision: <approved dependency/reuse or reason>
activeInputs:
  - path: <repo path or internal URI>
    selector: <heading or inclusive lines>
    sha256: <hash of complete fixed file/artifact>
    bytes: <complete fixed file/artifact bytes>
    purpose: <why this slice is required>
ownership:
  allowedExisting: [<path>]
  allowedNew: [<path>]
  forbidden: [<path/glob or product areas>]
goal: <observable outcome>
nonGoals: [<explicit exclusions>]
acceptance: [<observable criteria>]
verification:
  - command: <exact existing command or inspection>
    environment: <requirements>
sizeBudget:
  product: <add+delete cap>
  tests: <separate cap>
  docs: <separate cap>
stopConditions: [<contract/evidence/environment conflicts>]
decisionOwner: <user or Tech Lead boundary>
```

## Context layers

1. **L0 root rules:** every project session reads `AGENTS.md`; it contains authorization and invariant gates only.
2. **L1 invoked workflow:** only an explicit workflow reads its skill and role source.
3. **L2 active inputs:** a delegated role reads its task package, role source and only the listed selectors. Adjacent context is read only when required to resolve a direct dependency or ambiguity.
4. **L3 delivery evidence:** implementation and audit read the complete Feature diff and verification artifacts by URI. Historical evidence is not an active input unless explicitly listed.

A selector narrows model context, not document identity: SHA-256 and byte count always identify the complete fixed file or artifact. Root/module SPEC remain authoritative; selectors may not omit directly affected clauses.

## Feature baseline

Prefer an accepted Git commit/tree. If approved pre-existing changes prevent that, use an immutable pre-task snapshot:

- save content or an explicit absence marker for every allowed path;
- record SHA-256 and bytes for each entry;
- record the complete initial Git status and identities of all pre-existing changed/untracked paths;
- diff every allowed baseline entry against delivery, including additions and deletions;
- compare initial and delivery workspace inventories and verify pre-existing user paths were not absorbed or overwritten.

`full` audit means the entire baseline-to-delivery Feature diff. It never means silently including unrelated user work or already accepted Features.

## Delegation and reporting

- Put shared facts once in the package; child instructions contain only slice-specific target/change/acceptance.
- Raw diff, logs and research live in artifacts. Reports cite identities and include only decisions, results, findings and blockers.
- Reuse an existing role context for ordinary follow-up. Independent audit always uses a fresh context.
