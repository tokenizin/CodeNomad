# Protocol 2 fixtures

`rust-protocol2-*.ndjson` are the stream-json lines the Rust agent
(`build-your-own-claude-code`, `byocc-codenomad-engine-5.patch`) emits with
`NOMAD_PROTOCOL=2`, captured from its own mock-model tests:

* `rust-protocol2-parallel.ndjson` — one parent turn dispatching three Task calls that
  run at once and finish out of order (`protocol_two_stamps_each_task`).
* `rust-protocol2-one-failed.ndjson` — the same with the second task failing
  (`one_failing_task_does_not_sink_the_others_and_can_be_resumed`).

The first line (`meta`) and last line (`final`) are what the agent's `main()` adds
around the run; the rest are the events as the test harness recorded them. Task ids
differ per capture. To refresh them, print `run.events` in those two tests
(`cargo test -- <test> --nocapture`) and keep the `meta` / `final` framing.

They exist so the translator is tested against what the agent really writes, not
against what this repo believes it writes.
