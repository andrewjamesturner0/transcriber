# Project lessons

Carry-forward memory: the why-it-is-like-this and what-not-to-touch that git
history and code comments cannot hold. Maintained by /lesson. Read before
changing existing behaviour. Do not duplicate what code, docs, or git already
record - link to them.

## Reusable gotchas

<!-- generalisable traps and lessons; each links its evidence -->

## Decisions & deliberate behaviours

<!-- design decisions and intentional behaviours; behaviours name a guarding test, decisions give the trade-off -->

- **Model breadth belongs in the normal transcription job, not a comparison workflow.** Chose one-model transcription with capability-based options over built-in multi-model comparison because comparison can be done manually and is not part of Transcriber's job. See `.agents/docs/spec-model-playground.md`.
- **Do not restore TinyDiarize when carrying the old Whisper catalogue forward.** Chose to remove `small.en-tdrz` because its speaker output is not good enough, despite its advantage of working without the Python and Hugging Face setup required by pyannote. See `.agents/docs/spec-model-playground.md`.
- **The transcribe.cpp playground is a permanent two-engine design, not a whisper.cpp migration.** Chose to keep whisper.cpp as the reliable, feature-complete path while transcribe.cpp native work stays in the line-framed helper. The binding and Windows/Linux CPU/Vulkan native packages are pinned together at `0.1.3`; MOSS stays visible but unavailable until a matching published binding/native set supports it. Retained Whisper routing through whisper.cpp is guarded by `scripts/test-transcription-runner.js`; the helper, runtime pins and deferred MOSS state are guarded by `scripts/test-transcribe-runner.js`, `scripts/test-packaging.js`, and `scripts/test-cli.js`. See the T0.2 and T5.1 records in `.agents/docs/implementation-model-playground.md`.
- **Catalogue inclusion is not a recommendation.** Chose to keep new-family models visible as Candidate or Experimental without treating upstream claims as local proof; a model leaves that state only when every named local evidence gate passes, and missing evidence stays missing. Guarded by `scripts/test-model-promotion.js` and `scripts/test-models.js`. See `docs/model-validation.md`.
- **Per-job controls stay in Job options, not Settings.** Job options sits directly after Model and before Audio files; Settings retains device preference, pyannote and Hugging Face setup, and logs. This split gives quiet defaults with capability-driven progressive disclosure, and is deliberate rather than unfinished Settings work. Guarded by `scripts/test-model-playground-ui.js` and `scripts/test-job-options.js`. See `.agents/docs/design-model-playground.md`.
