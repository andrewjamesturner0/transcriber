# Project lessons

Carry-forward memory: the why-it-is-like-this and what-not-to-touch that git
history and code comments cannot hold. Maintained by /lesson. Read before
changing existing behaviour. Do not duplicate what code, docs, or git already
record - link to them.

## Reusable gotchas

<!-- generalisable traps and lessons; each links its evidence -->

- **Check ignored Examples/ before designing evaluation.** Tracked-file searches can miss local gold recordings and reference transcripts. Inspect available examples before assuming a new reference set is needed, and check which annotations they actually provide before choosing accuracy metrics. `Examples/` is excluded by [.gitignore](../.gitignore).

## Decisions & deliberate behaviours

The model-playground entries below record work on another branch. This
Whisper-only branch still has TinyDiarize and places alignment in the Model
card. The transcribe.cpp, promotion and playground UI tests cited in those
entries are absent here; check the matching branch before changing those
behaviours.

<!-- design decisions and intentional behaviours; behaviours name a guarding test, decisions give the trade-off -->

- **Model breadth belongs in the normal transcription job, not a comparison workflow.** Chose one-model transcription with capability-based options over built-in multi-model comparison because comparison can be done manually and is not part of Transcriber's job.
- **Do not restore TinyDiarize when carrying the old Whisper catalogue forward.** Chose to remove `small.en-tdrz` because its speaker output is not good enough, despite its advantage of working without the Python and Hugging Face setup required by pyannote.
- **The transcribe.cpp playground is a permanent two-engine design, not a whisper.cpp migration.** Chose to keep whisper.cpp as the reliable, feature-complete path while transcribe.cpp native work stays in the line-framed helper. The binding and Windows/Linux CPU/Vulkan native packages are pinned together at `0.1.3`; MOSS stays visible but unavailable until a matching published binding/native set supports it. Retained Whisper routing through whisper.cpp is guarded by `scripts/test-transcription-runner.js`; the helper, runtime pins and deferred MOSS state are guarded by `scripts/test-transcribe-runner.js`, `scripts/test-packaging.js`, and `scripts/test-cli.js`.
- **Catalogue inclusion is not a recommendation.** Chose to keep new-family models visible as Candidate or Experimental without treating upstream claims as local proof; a model leaves that state only when every named local evidence gate passes, and missing evidence stays missing. Guarded by `scripts/test-model-promotion.js` and `scripts/test-models.js`. See `docs/model-validation.md`.
- **Per-job controls stay in Job options, not Settings.** Job options sits directly after Model and before Audio files; Settings retains device preference, pyannote and Hugging Face setup, and logs. This split gives quiet defaults with capability-driven progressive disclosure, and is deliberate rather than unfinished Settings work. Guarded by `scripts/test-model-playground-ui.js` and `scripts/test-job-options.js`.

- **Keep timing evidence through speaker formatting.** A plausible timestamp can still be a token estimate, derived DTW span or interpolated alignment. Losing that distinction makes later accuracy checks misleading. Guarded by [test-transcript-timing.js](../scripts/test-transcript-timing.js) and the structured-result case in [test-merge.js](../scripts/test-merge.js). See [the timing contract](diarization.md#word-timing-libtranscript-timingjs).
- **A brief reply is not evidence of a speaker mistake.** Do not restore duration-based absorption or label smoothing: the original cleanup deleted correctly timed A/B/A replies and distant Unknown words. Guarded by cases 2, 3 and 7 in [test-merge.js](../scripts/test-merge.js). See [the original reproductions](diarization-investigation.md#3-cleanup-erases-correctly-detected-short-turns).
- **Exclusive assignment must retain regular overlap evidence.** A one-speaker transcript can hide simultaneous speech; keep both timelines so evaluation can still see it. Guarded by the exclusive-timeline and overlap cases in [test-merge.js](../scripts/test-merge.js) and [test-diarize-contract.py](../scripts/test-diarize-contract.py). See [the assignment contract](diarization.md#speaker-assignment-libdiarize-mergejs).
- **Optional alignment must not become another recogniser or an implicit download.** Installing WhisperX brings ASR packages and download paths with it. Only import its alignment functions, preserve the existing text and fail or fall back explicitly when caches are missing. Guarded by [test-align-contract.py](../scripts/test-align-contract.py) and [test-transcription-runner.js](../scripts/test-transcription-runner.js). See [the setup boundary](diarization-setup.md#privacy).
