# Repository working preference

Commit completed work as you go in this repository. Make small, descriptive commits after each coherent change, and report the commit hash to the user. Do not commit unrelated work.

Do not push to `main` unless the user explicitly asks you to push.

Write long, detailed commit messages. Use a concise subject followed by a body that explains what changed, why it changed, and how the change was verified. Include relevant behavior, design decisions, and limitations when they help a future reader understand the commit.

Pull regularly so work stays current with the shared repository. Run `git pull` at the start of each new task when the working tree is clean, and repeat it during long-running work after reaching a safe checkpoint. If there are uncommitted changes, preserve them and pull only after they can be safely committed or otherwise integrated; never discard someone else's work to make a pull succeed.

# Schema migration preference

Always upgrade existing database schemas to the current schema. Preserve unchanged tables and rows, and carry forward compatible column values. When data has a straightforward mapping to a new schema, migrate it too, including renamed columns and values moved into typed tables.

This project is pre-release, so losing specific obsolete or incompatible values is acceptable when preserving them would be difficult or impractical. That allowance is not a reason to skip schema migrations, discard easily migrated data, or reset an entire database. Verify upgrades from the previous schema and relevant partially upgraded states, including preservation of unrelated data.
