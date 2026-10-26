# License and provenance review packet

The repository currently carries the original MIT license, copyright 2026
Filip Tůma, in [LICENSE](../../LICENSE). Candidate packaging includes those exact
bytes and records their hash. This packet does not select a replacement license
or approve a new public distribution policy.

The [research source inventory](../research/nylas/10-source-inventory.md) records
the pinned public snapshots used for the architecture study and states that no
third-party source was copied into the repository. Its source citations describe
research provenance; they are separate from artifact dependency notices and
provider certification.

The packaging report inventories the actual resolved production closure, package
names/versions, declared license metadata and included license/notice texts with
hashes. It must report missing or unrecognized declarations rather than infer
permissions from a package name. Development-only tooling and base-image
components are separately identified. In particular, existing `ical.js` metadata
declares MPL-2.0; an MIT repository does not change that declaration.

The inventory and retained texts support owner review. They are not a legal
compatibility opinion, a warranty that every dependency has been audited, or
permission to omit applicable notices. Before public release, the owner reviews
the exact candidate closure, intended distribution and outstanding license or
notice questions. A later dependency change requires a fresh inventory.
