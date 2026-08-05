# transcribe.cpp integration review

Date: 19 July 2026

> Historical note: this is a dated pre-implementation review. Its descriptions
> of the "current" 13-model/TinyDiarize application and its proposed comparison
> workflow describe the 19 July 2026 baseline, not the implemented model
> playground. See [the current walkthrough](walkthrough.md), [CLI reference](cli.md),
> and [model validation rules](model-validation.md) for the present design.

## Executive summary

transcribe.cpp is most valuable here as a way to turn the application into a
speech-model playground. Its model catalogue is much wider than whisper.cpp:
small English models, multilingual models, streaming models, translation
models, medical dictation, audio-event recognition and generated speaker
labels can all run through one native runtime. It also offers structured
language bindings, CPU, Vulkan, Metal and CUDA builds, and can load ordinary
whisper.cpp `.bin` model files.

It is not a drop-in replacement for whisper.cpp, and an immediate wholesale
replacement is not recommended.

The following are blockers to full replacement, but not to adding an
experimental model catalogue:

- transcribe.cpp's Whisper implementation only returns segment timestamps. The
  current pyannote merge gets its best speaker alignment from whisper.cpp's
  word or token timestamps.
- TinyDiarize models are rejected because their extra tensors are not
  supported. The existing `small.en-tdrz` path would stop working.
- The example `transcribe-cli` writes human-readable output and is not shipped
  in the native release archives. Renaming it to `whisper-cli` would not work.
- The project is young, pre-1.0 and mainly maintained by one person. There are
  current reports of silent transcript omissions in both the Whisper and
  Parakeet paths.
- A wider model catalogue brings more language, licence, quality, memory and UI
  choices. Those choices need to be made deliberately rather than exposed all
  at once.

The recommended route is to keep whisper.cpp as the known control and add
transcribe.cpp as an experimental model engine. A small, long-lived Node helper
process should use the official TypeScript binding and exchange structured
messages with the Electron main process. This preserves the crash isolation
currently provided by `whisper-cli`, while gaining model reuse, cancellation
and structured results. Models should declare their capabilities, so a model
without word timestamps can still be explored while diarization is disabled.
Full whisper.cpp replacement can be decided later and is not required to
capture the main value.

A useful proof of concept should take about 1 to 2 engineering weeks. A safe
production replacement is more likely to take 4 to 8 engineering weeks,
depending on the chosen diarization strategy and the results of real audio
testing. These are planning estimates, not measured delivery dates.

## Primary product case: a model playground

If model exploration is the goal, feature parity should be assessed per model,
not used as a gate for the whole engine. For example, missing Whisper word
timestamps should disable pyannote for that model. It should not prevent the
user from comparing its plain transcript with Parakeet, Moonshine or Qwen.

The product should have two levels:

- Stable models are a small, tested set suitable for normal work.
- Experimental models expose the wider catalogue with clear capability,
  licence, size and maturity labels.

whisper.cpp remains the control in both levels. A user can run the same file
through the current model and any experimental model, then compare text,
timings and resource use. This is more useful for exploration than forcing
every new model to imitate Whisper's output format.

### What the catalogue makes possible

The following is a useful first map of distinct experiments. Sizes are upstream
GGUF download sizes at the reviewed commit, not installed application sizes.

| Experiment | Candidate | Useful difference | Suggested quant | Main limits |
| --- | --- | --- | --- | --- |
| Known control | Existing Whisper models | Broad language coverage and translation, with current whisper.cpp features retained | Existing files | transcribe.cpp Whisper only has segment timestamps |
| Fast English with timing | Parakeet TDT-CTC 110M | Cased text plus token, word and segment timestamps | Q8, 135 MB | English only, offline, CC-BY-4.0 |
| Very small English | Moonshine tiny | Different raw-waveform architecture in a 34 MB Q8 model | Q8, 34 MB | No timestamps, translation or language detection |
| European multilingual | Parakeet TDT 0.6B v3 | 25 European languages and token timestamps | Q5, 565 MB | Offline, no translation, CC-BY-4.0 |
| Broad multilingual | Qwen3-ASR 0.6B | Auto-detects 30 languages, including Chinese, Japanese, Arabic and Hindi | Q4, 654 MB | Larger model and no documented timing output |
| Small multilingual translation | Canary 180M Flash | Transcription and two-way translation for English, German, Spanish and French | Q5, 151 MB | Explicit language hint, no exposed timestamps, CC-BY-4.0 |
| Multilingual streaming | Nemotron 3.5 ASR Streaming 0.6B | Word timing, automatic language detection and selectable streaming latency | Q5, 534 MB | OpenMDW-1.1 licence and less local validation |
| East Asian speech and sound tags | SenseVoice Small | Chinese, Cantonese, English, Japanese and Korean plus emotion and audio-event tags | Q5, 164 MB | 30 second call limit and custom model licence |
| Medical dictation | MedASR | English medical vocabulary from a specialist model | Q8, 122 MB | Gated terms, domain-specific bias and weak general speech accuracy |
| Built-in speaker experiment | MOSS Transcribe-Diarize | Generated speaker and time tags for English and Chinese | Q5, 700 MB | High duration-linked RAM, generated tags and no normal word timing |

This table should be treated as a test menu, not a promise to ship every model.
Its purpose is to cover genuinely different model families. Adding ten Whisper
sizes would give less information than comparing six different architectures.

### Model catalogue design

The existing model manifest should grow into a capability catalogue. Each entry
should include:

```text
id
displayName
engine
family
source and pinned revision
download URL and checksum
quantization and size
licence and attribution
languages and language-selection mode
translation support
timestamp level: none, segment, word or token
streaming support
diarization compatibility
audio-length limit
expected RAM and GPU memory
stability: stable or experimental
known issues
```

The UI and CLI can then enable only the features a model supports. Selecting
Moonshine disables timestamps and diarization. Selecting Parakeet 110M enables
pyannote experiments. Selecting Canary shows source and target language. This
is clearer than pretending every model accepts the same Whisper options.

### Comparison workflow

A model playground should make comparison cheap and repeatable:

1. Convert the source file to WAV once and reuse it for all selected models.
2. Run models serially by default so memory and timings are meaningful.
3. Save the raw normal result, engine version, model hash, backend and settings.
4. Show transcripts side by side or produce a comparison directory.
5. Record model load time, transcription time, peak memory and any truncation.
6. Let the user mark omissions, wrong words and preferred output without
   pretending an automatic score exists for audio with no reference text.

For files with a reference transcript, add word error rate and character error
rate. For speaker-labelled fixtures, add the existing diarization comparison.
The saved metadata makes results reproducible when transcribe.cpp or a model is
upgraded.

### Guardrails for experimentation

Experimental breadth should not weaken the reliable path:

- Download models on demand rather than increasing the base installer.
- Show model size and licence before download.
- Pin model files by hash and never silently replace them.
- Label upstream benchmark figures as upstream figures.
- Keep known correctness issues beside the affected model in the catalogue.
- Do not run models in parallel unless the user explicitly chooses it.
- Keep the native worker outside Electron so a broken model or backend cannot
  close the application.
- Make unsupported options visibly unavailable instead of silently ignoring
  them.

With these guardrails, a new family can be useful before it is trusted as a
default. That is the key difference between a model lab and an engine
replacement project.

## Scope and evidence

This review compares:

- this application at commit `5bf455fc` and version `0.3.1-dev`;
- transcribe.cpp at commit
  `5a5a49664a8ea1f0e5b3be1dfc544730d1b62561`, dated 13 July 2026;
- the latest transcribe.cpp release available during the review, `v0.1.3`,
  published 12 July 2026.

The review used source inspection, release archive inspection, a local
CPU-only build, a same-machine smoke test, the upstream model documentation,
and open upstream issues. Performance figures from upstream documents are
labelled as upstream claims. They have not been treated as direct comparisons
with this application.

The project is moving quickly. Recheck the pinned commit, release contents,
open correctness issues and package support immediately before implementation.

## The current integration

The current pipeline is:

```text
audio or video
  -> FFmpeg creates a 16 kHz mono WAV
  -> whisper-cli transcribes it
  -> optional pyannote finds speaker turns
  -> Whisper timing data and pyannote turns are merged
  -> text or JSON is returned to the GUI or CLI
```

`lib/transcription-runner.js` is the main orchestrator. It checks dependencies,
runs FFmpeg, calls `lib/whisper-runner.js`, optionally runs pyannote, merges the
results, and removes temporary files.

`lib/whisper-runner.js` is a deep, useful module rather than a thin process
wrapper. It owns several pieces of product behaviour:

- plain output uses `--no-timestamps`;
- TinyDiarize models use `--tinydiarize`;
- pyannote and JSON output use `--output-json-full`;
- supported models add a DTW preset for finer timing;
- anti-corruption mode changes decoding thresholds;
- a missing or failed Vulkan path retries on CPU;
- an unsupported DTW path retries without DTW;
- cancellation stops the child process.

The current model catalogue contains 13 Whisper choices, including TinyDiarize
and DTW metadata. Release and setup scripts build or download CPU and Vulkan
whisper.cpp binaries and stage them with FFmpeg. The local `bin` directory was
319 MB during this review, and the local model directory was 2.0 GB. Those are
working-tree measurements, not installer sizes.

Any replacement has to preserve the behaviour above or remove it as an
explicit product decision. Replacing only the executable would hide important
regressions.

## What transcribe.cpp provides

transcribe.cpp is an MIT-licensed C and C++ inference library built on ggml. Its
current main branch lists 19 speech model families and more than 60 variants.
It accepts 16 kHz mono WAV input and supports CPU, Metal, Vulkan and CUDA. It
has official Python, TypeScript, Rust and Swift bindings.

The model catalogue includes Whisper, Parakeet, Canary, Moonshine, Nemotron,
Granite, Voxtral and MOSS, among others. Capabilities vary by family. Some are
offline models, some stream, some provide words or tokens, and some only work
in a small set of languages.

This breadth is the project's main attraction and also its main integration
risk. A single engine can support several future product directions, but there
is no single model that preserves every current Whisper feature while also
adding all of the new features.

### Project maturity

The repository was created in April 2026 and had 488 commits at the reviewed
snapshot. It had active development and frequent releases, but was still at
version `0.1.3`. Git history and GitHub contributor data indicated that nearly
all work came from one maintainer.

Positive maturity signs include:

- numerical tensor checks against reference implementations;
- word error rate tests for published models;
- unit, smoke and real-model test guidance;
- native packages for several operating systems and processor types;
- explicit third-party licence records;
- documented Electron packaging for the TypeScript binding.

Risk signs include:

- a very young, pre-1.0 interface and packaging contract;
- a large and fast-changing model surface;
- a small maintainer base;
- current open reports of silent text omissions;
- some model features present on main but not in the latest release packages.

The repository is good enough for a controlled trial. Its maturity does not
yet support removing the proven fallback engine without substantial local
validation.

## Compatibility with this application

| Area | Compatibility | Effect |
| --- | --- | --- |
| 16 kHz mono WAV input | Good | The FFmpeg stage can stay unchanged. |
| Ordinary whisper.cpp `.bin` models | Good, with limits | The legacy loader accepted the existing `ggml-tiny.en.bin` in a local smoke test. |
| Whisper GGUF models | Good | New quantized Whisper downloads can be offered later. |
| TinyDiarize `.bin` models | Not supported | The loader rejects the extra TinyDiarize tensors. |
| Plain transcript | Good | All useful candidate models return text. |
| Whisper translation to English | Good | Multilingual Whisper variants retain translation. |
| Whisper word timestamps | Not supported | transcribe.cpp Whisper stops at segment timestamps. |
| pyannote merge | Partial | It can merge segments, but speaker placement will be less precise unless another model supplies word timing. |
| Current full Whisper JSON | Not compatible | A normal result type and a compatibility exporter are needed. |
| Vulkan and CPU fallback | Partial | Both backends exist, but this app's retry policy must be rebuilt and tested. |
| Intel Vulkan | Potential gain | Upstream supports Vulkan more broadly; this app currently rejects Intel GPUs. Device testing is required. |
| Metal on Apple Silicon | Potential gain | Official native support could make a macOS build more realistic. |
| CUDA | Potential gain | It can improve NVIDIA throughput, but greatly increases package size and release work. |
| Cancellation | Good through binding | The TypeScript binding accepts `AbortSignal` and can return partial results. |
| Process isolation | Lost with direct binding | A native crash would take down Electron unless the binding runs in a helper process. |
| CLI output | Poor | The example CLI is human-readable and has no compatible single-file JSON mode. |
| Published native assets | Partial | The release archives contain libraries and licences, but not the example CLI. |
| Offline privacy | Good | Inference remains local once binaries and models have been installed. |

## Verified smoke test

The reviewed transcribe.cpp commit was built locally with CPU support and its
example CLI. It then ran against this application's existing
`models/ggml-tiny.en.bin` and the upstream 11 second JFK fixture.

Both engines returned exactly:

```text
And so my fellow Americans ask not what your country can do for you, ask what you can do for your country.
```

Across five alternating warm-filesystem runs with four CPU threads:

| Engine | Wall time | Peak resident memory |
| --- | ---: | ---: |
| current whisper.cpp binary | 1.18 s | 180,392 KB |
| transcribe.cpp example CLI | 0.73 s | 128,480 KB |

These medians are useful evidence that ordinary model reuse works and justify a
larger benchmark. They are not evidence of a general 38 percent speed
improvement. This was one short English file, one tiny model and one machine.
Cold startup, thread implementation and process logging were not isolated. A
proper comparison must cover the same models, long recordings, several CPUs
and GPUs, and repeated cold and warm runs.

## Potential gains

### 1. More model choices behind one runtime

The current app is tied to Whisper. transcribe.cpp would allow the product to
choose a model based on the task:

- a small, fast English Parakeet model for ordinary English transcription;
- multilingual Whisper when translation and broad language coverage matter;
- Parakeet or Nemotron where word timing matters;
- a streaming model if live transcription is added later;
- MOSS where built-in English or Chinese speaker labels are worth its memory
  cost and limitations.

This could become a real caller benefit if the application presents a few
tested modes, such as "Fast English", "Multilingual" and "Speaker labels".
Presenting 60 raw model names would pass technical complexity to the user.

### 2. Smaller or faster models for common work

Upstream publishes a Parakeet TDT-CTC 110M model at about 90 MB in Q4 or 135 MB
in Q8. It provides word, token and segment timestamps. Its published benchmarks
show high real-time factors on CPU and Vulkan, and its published LibriSpeech
word error rate is competitive.

Those figures are promising for interview transcription, especially on
ordinary laptops. They are upstream figures, not yet reproduced on this
application's users' hardware or audio. Accent, noise, crosstalk and domain
language matter much more than LibriSpeech alone.

Whisper GGUF quantization can also reduce some model downloads. For example,
upstream lists Whisper tiny.en Q8 at about 44 MB, compared with the current
tiny.en file at about 75 MB. Larger model size differences are less dramatic.
The runtime package may grow, so installer size must be measured end to end.

### 3. Structured results

The TypeScript binding returns text, language, segments, words, tokens and
timings as structured data where the selected model supports them. That is a
cleaner interface than parsing console output and reading a Whisper-specific
temporary JSON file.

A normal result shape would make transcript formatting and pyannote merging
independent of the selected inference engine. It would also make it easier to
add confidence, model and backend metadata to exported JSON.

### 4. Model reuse

The current process loads a model for every file. The TypeScript binding can
load a model once and run several files through it. A long-lived helper can
therefore reduce repeated startup cost for the queue. The binding allows one
compute operation at a time per loaded model, which fits the current serial
queue. More parallel work would require more loaded model instances and much
more memory.

### 5. Wider hardware support

transcribe.cpp publishes native builds for Windows x64, Linux x64 and arm64,
and macOS x64 and arm64, with the appropriate CPU, Vulkan or Metal paths. CUDA
is available for Linux and Windows. This is broader than the current packaged
CPU and Vulkan setup and could help with:

- Apple Silicon through Metal;
- ARM Linux;
- NVIDIA CUDA where Vulkan is weak;
- Intel integrated graphics, subject to real device tests.

The gain is not automatic. Each additional backend adds release assets,
detection rules, fallback tests and user support cases.

### 6. A route to streaming

Several supported families are streaming-first. The current file pipeline does
not become live transcription merely by changing engines: FFmpeg flow,
incremental result handling, UI updates and transcript revision all need work.
Still, transcribe.cpp supplies a plausible inference foundation for that later
feature.

## Trade-offs and losses

### 1. Whisper timestamp regression

The largest functional mismatch is timing. Upstream explicitly documents that
its Whisper path returns segments only, not words. The current app asks
whisper.cpp for full JSON and enables DTW where available. The merge code can
then assign speaker turns using finer timing.

Using transcribe.cpp Whisper with pyannote would force segment-level alignment.
A long segment that crosses a speaker change could be assigned poorly or need
to be split by guesswork. Plain transcription may be equivalent, but speaker
transcription is not.

Parakeet models can return word timing, so they offer a possible replacement
path for pyannote. That changes the recognition model, supported languages and
error profile at the same time. It needs direct speaker-turn tests rather than
an interface-only test.

### 2. TinyDiarize is lost

The transcribe.cpp legacy `.bin` loader checks that every tensor was consumed.
It specifically treats TinyDiarize's extra speaker-turn head as an unsupported
extension and fails model loading. The existing `small.en-tdrz` model cannot be
carried across.

Options are:

1. keep whisper.cpp for TinyDiarize;
2. remove TinyDiarize and use pyannote with a word-timed model;
3. add TinyDiarize support upstream or maintain it locally;
4. replace it with MOSS for supported English and Chinese cases.

The first option is the safest during migration. The second may produce better
speaker labels but keeps the Python and Hugging Face token setup. The third has
ongoing maintenance cost. The fourth has severe memory and behaviour limits.

### 3. Current correctness concerns

Two open upstream reports deserve release-blocking tests:

- issue 89 reports silent tail truncation in Whisper short-form transcription
  when an initial prompt is used, while whisper.cpp completes the same audio;
- issue 71 reports a multi-second span silently missing from Parakeet TDT v3
  output across CPU and Vulkan and more than one quantization.

The present app does not expose Whisper initial prompts, so the exact issue 89
trigger is absent today. It still shows that decoding parity cannot be assumed.
Silent omission is worse than a clear failure because retry logic cannot see
it. The application needs omission-focused corpus tests and, where possible,
duration or coverage checks.

### 4. Native code in Electron

Calling the TypeScript binding directly in the Electron main process is the
shortest implementation route, but it changes the failure mode. A segfault,
illegal instruction or native library conflict could close the whole app. The
current CLI child process contains that failure.

A helper process keeps native code outside Electron and can be restarted after
a failure. This costs a small message protocol and worker lifecycle code, but
is the safer design for a desktop application.

### 5. Packaging is different, not removed

The `v0.1.3` Linux x64 CPU and Vulkan release archive was about 29.7 MB
compressed and about 88 MB unpacked during inspection. Most of the unpacked
size was the Vulkan library. The Windows CPU and Vulkan asset was about 26 MB
compressed. CUDA archives were roughly 226 MB compressed.

These figures are not directly comparable to this repository's 319 MB `bin`
working directory because that directory also includes FFmpeg and duplicate
shared-library layouts. A staged Electron build is the only useful installer
comparison.

The official archives contain `libtranscribe` and ggml libraries, contracts and
licences. They do not contain `transcribe-cli`. The TypeScript package uses
platform-specific optional packages and Koffi. Electron must keep native files
outside ASAR, or unpack them into a known path.

The binding is ESM-only and declares Node 22 or newer. This repository's
developer guide currently allows Node 18 and the standalone CLI runs under the
user's system Node. A helper launched with a system Node would therefore raise
the CLI requirement. Packaging the helper with the Electron runtime, or using
a small C adapter, avoids relying on an arbitrary system Node. The chosen route
must be tested from both the GUI and `node cli.js` entry points.

The local build script currently cross-builds Windows from Linux. A normal npm
install on Linux will not necessarily stage an optional Windows native package.
The build must explicitly select and copy the target package, or native release
jobs must build each target on its own operating system.

### 6. CPU compatibility requires care

An upstream Windows issue shows that statically linked builds made with native
CPU tuning can fail with an illegal instruction on older processors. The
maintainer recommends the dynamic "fat CPU" package for broad compatibility.
This application should use published dynamic CPU variants or conservative
build flags, then test on an older supported CPU. A fast build produced on a
new developer machine is not suitable release evidence.

### 7. More licences and notices

The transcribe.cpp runtime, ggml and miniz are MIT licensed and are compatible
with this GPLv3 application. Model licences vary. Examples in the candidate
set include Apache-2.0, CC-BY-4.0 and NVIDIA's Open Model Development and
Weights licence.

Every offered model needs a recorded source, version, checksum, licence,
attribution text, redistribution decision and download terms. The existing
model manifest should become the one place that holds this information. Model
breadth should not be enabled until release notices and the download UI show
the right terms.

### 8. Anti-corruption behaviour needs new evidence

The current `antiCorruption` option maps to Whisper-specific decoding flags.
There is no general equivalent across all transcribe.cpp families. The product
should define the user-facing outcome, such as reducing repeated or invented
text, and test it per model. Passing the existing option through without a
model-specific implementation would be misleading.

## Diarization choices

### Keep pyannote and use a word-timed model

This is the strongest route to current feature parity. Use Parakeet or another
validated model that returns words, then convert its result to the merge
format. Keep pyannote, Python setup and Hugging Face authentication unchanged.

Pros:

- preserves a dedicated speaker model;
- can improve timing compared with segment-only Whisper;
- isolates recognition choice from speaker recognition;
- works within the current pipeline.

Cons:

- recognition quality and language coverage change;
- still has the heavy Python environment and token setup;
- word timing semantics need to be checked against the current merge logic;
- Parakeet's open omission report must be resolved or safely bounded.

### Use transcribe.cpp Whisper with pyannote

This maximises model compatibility and broad language coverage, but accepts
segment-only alignment.

Pros:

- ordinary existing `.bin` files can be reused;
- recognition behaviour remains closest to the current product;
- translation remains available on multilingual models.

Cons:

- speaker changes inside a segment are hard to place;
- DTW presets and word timing are lost;
- it is not full diarization parity.

This is acceptable for a plain transcription trial, but not as the sole route
for replacing the speaker workflow.

### Use MOSS Transcribe-Diarize

MOSS generates inline speaker tags with English and Chinese transcription. It
could remove pyannote for a narrow mode, but it is not a general replacement.

Upstream documents roughly 85 MB of extra memory for each minute of audio,
which is about 2.5 GB for 30 minutes and 5 GB for an hour. Diarization cannot
currently be disabled. Speaker and time tags are generated tokens rather than
a separate structured speaker analysis, so tags can drift or be malformed.
The model does not provide the same word-timing contract.

MOSS landed on main after `v0.1.3`, so its presence in the source does not mean
it is in the reviewed release packages. Treat it as a later experiment for
short English or Chinese recordings on high-memory machines.

### Keep whisper.cpp only for TinyDiarize

This is an effective transitional option. It preserves the lightweight
speaker-change mode while other work moves to transcribe.cpp. The cost is two
native runtimes in the package and a longer support tail. It should have an
explicit removal condition so it does not become accidental permanent debt.

## Integration route comparison

| Route | Work | Isolation | Structured output | Model reuse | Recommendation |
| --- | --- | --- | --- | --- | --- |
| Rename or wrap example CLI output | Low at first, high later | Good | Poor | No | Reject. Output and release packaging do not match the app. |
| Call TypeScript binding in Electron | Moderate | Poor | Good | Good | Useful only for an internal spike. |
| TypeScript binding in helper process | Moderate | Good | Good | Good | Recommended. |
| Maintain a custom C or C++ adapter executable | Moderate to high | Good | As designed | Possible | Valid fallback if the binding proves hard to package. |
| Link the C library into a new Electron native addon | High | Poor unless separately hosted | Good | Good | Little benefit over the maintained binding. |

### Recommended helper process

The helper should be a small Node program packaged beside the native libraries.
Electron starts it as a child process and exchanges one JSON message per line,
or another framed format if payloads grow. The first version only needs these
operations:

```text
load { modelPath, backend, threads }
transcribe { jobId, wavPath, language, timestamps }
cancel { jobId }
unload
shutdown
```

Responses should include a stable status and a normal result:

```text
{
  text,
  language,
  segments,
  words,
  tokens,
  timings,
  engine,
  model,
  backend,
  truncated
}
```

The protocol should never rely on parsing diagnostic log text. Logs belong on
stderr; framed results belong on stdout. A killed or crashed worker should fail
the active job clearly and allow one controlled CPU restart when appropriate.

## Target architecture

Add one transcription engine interface below `transcription-runner.js`:

```text
transcription-runner.js
  -> audio conversion
  -> selected engine adapter
       -> whisper.cpp process adapter
       -> transcribe.cpp worker adapter
  -> normal transcript result
  -> optional pyannote merge
  -> formatter/exporter
```

The engine interface should accept model metadata, WAV path, options,
`AbortSignal` and progress reporting. It should return the normal result above.

This seam keeps useful policy local:

- the whisper adapter owns whisper.cpp flags and DTW fallback;
- the transcribe adapter owns worker lifecycle and backend selection;
- the orchestrator owns FFmpeg, pyannote and cleanup;
- the merge module consumes words or segments without knowing which engine
  produced them;
- the model manifest states engine, family, timing, languages, translation,
  diarization compatibility, memory guidance, licence and checksums.

Do not make callers branch on raw model family names. Ask the manifest for
capabilities such as `wordTimestamps`, `translation` and `streaming`. This keeps
model-specific rules in one place and prevents conditionals spreading through
the GUI, CLI and orchestration code.

## Suggested initial model set

The first implementation should prove three different families, not three
similar Whisper sizes:

1. Existing `ggml-tiny.en.bin` through transcribe.cpp Whisper. This is the
   compatibility control and proves legacy model reuse.
2. Parakeet TDT-CTC 110M Q8. This tests fast English, a small download and word
   timestamps suitable for pyannote experiments.
3. Moonshine tiny Q8. This tests a genuinely different architecture and the
   smallest useful download, while exercising a text-only result.

Once the worker and catalogue are stable, add a second experimental wave:

4. Canary 180M Flash Q5 for multilingual transcription and translation.
5. Qwen3-ASR 0.6B Q4 for broad automatic language detection.
6. Nemotron 3.5 Q5 for multilingual word timing and streaming experiments.

SenseVoice, MedASR and MOSS should remain explicit opt-in experiments because
they have unusual input, licence, domain or memory constraints. CUDA packages
should also wait until there is a specific hardware experiment. This sequence
exposes meaningful breadth quickly without making every upstream model a local
support promise.

## Rollout plan

### Phase 0: catalogue, fixtures and seam, 2 to 4 days

- Define the normal transcript result, engine interface and capability
  catalogue.
- Record current output for a representative corpus before changing execution.
- Add timing-aware merge tests using both words and segments.
- Keep the current whisper runner as the default adapter.

Exit condition: all existing behaviour and tests pass through the new seam.

### Phase 1: Linux CPU model playground, 4 to 7 days

- Package the TypeScript binding in a helper process.
- Load the existing tiny.en `.bin`, Parakeet 110M Q8 and Moonshine tiny Q8.
- Implement cancellation, progress, worker crash reporting and model reuse.
- Add on-demand model downloads and save engine, model and backend metadata.
- Compare text, omissions, time and memory across the three families.

Exit condition: repeated short and long CPU jobs complete across all three
families with no worker leaks or cancellation failures, and unsupported
features are clearly disabled per model.

### Phase 2: Windows and Vulkan, 5 to 10 days

- Stage the correct Windows native package in setup and release builds.
- Rebuild backend detection around transcribe.cpp discovery.
- Preserve explicit retry after Vulkan load, allocation or run failure.
- Test NVIDIA, AMD and Intel graphics, plus old and new CPUs.

Exit condition: packaged Windows and Linux apps pass CPU and available GPU
tests, including forced GPU failure and CPU recovery.

### Phase 3: diarization and product choices, 1 to 3 weeks

- Add Canary, Qwen or Nemotron in small steps based on the experiments that
  matter most.
- Compare pyannote merge quality using current Whisper word timing, Parakeet
  word timing and transcribe.cpp Whisper segments.
- Decide whether TinyDiarize stays, is removed, or waits for upstream support.
- Add user-facing modes based on tested capabilities, not model family jargon.
- Run a separate MOSS experiment only if its narrow use case matters.

Exit condition: the chosen speaker route meets an agreed turn-attribution gate
and unsupported combinations cannot be selected.

### Phase 4: release hardening, about 1 week

- Complete notices, model licence records, hashes and download recovery.
- Measure final installer and per-model download sizes.
- Update privacy, setup, CLI and troubleshooting documentation.
- Ship transcribe.cpp behind an experimental setting, collect explicit error
  logs, and retain whisper.cpp rollback.

Exit condition: at least one release cycle shows reliable results on the
supported hardware matrix before changing the default.

## Validation matrix

### Audio corpus

Include:

- 10 second, 10 minute, 60 minute and 120 minute files;
- clean speech, room noise, music, silence and long pauses;
- British, American and several non-native English accents;
- the main languages users actually submit;
- technical terms, names, numbers and repeated phrases;
- two and four speakers, overlaps and quick speaker changes;
- corrupt, empty and unsupported inputs.

Use real, consented or public-domain audio. Synthetic clips are useful for
precise timing tests but should not be the whole corpus.

### Hardware and packages

At minimum:

- Windows x64 on an older and a newer CPU;
- Windows NVIDIA, AMD and Intel Vulkan machines;
- Linux x64 CPU and Vulkan;
- Linux arm64 if it becomes supported by the app;
- Apple Silicon Metal if macOS packaging is added;
- CUDA only if it is a release target.

Test installed applications, not only development commands. Include paths with
spaces and non-ASCII filenames even though this document itself uses ASCII.

### Measures

Record:

- word and character error rates;
- missing spans and repeated or invented spans;
- speaker error and speaker-turn placement;
- wall time, model load time and warm queue throughput;
- peak RAM and GPU memory;
- cancellation latency and partial result behaviour;
- CPU fallback after GPU load, allocation and mid-run failures;
- worker recovery after a forced crash;
- installer and model download sizes;
- network traffic during transcription.

Suggested release gates are:

- no known silent omission in the release corpus;
- no material median or worst-case accuracy regression against the chosen
  current baseline;
- cancellation stops useful work within 2 seconds;
- a 2 hour file completes without leaked workers or temporary files;
- packaged CPU and GPU paths pass on supported Windows and Linux machines;
- transcription performs no network access after assets are installed;
- speaker-turn accuracy is no worse than the agreed current workflow.

Numeric accuracy tolerances should be set after measuring the present product.
Choosing them before a baseline would give false precision.

## Risks and mitigations

| Risk | Consequence | Mitigation |
| --- | --- | --- |
| Silent missing text | Users trust an incomplete transcript | Omission-focused corpus, coverage checks, retain whisper fallback, track issues 89 and 71. |
| Segment-only Whisper timing | Worse speaker placement | Use a word-timed model for pyannote or retain current Whisper for diarization. |
| TinyDiarize rejection | Existing feature disappears | Route tdrz models to whisper.cpp until an explicit product decision. |
| Native worker crash | Active job fails | Helper process isolation, restart policy, clear job error, conservative CPU builds. |
| Rapid upstream changes | Release breaks unexpectedly | Pin exact runtime and package versions, keep checksums, upgrade deliberately. |
| Single maintainer | Slow fixes or project pause | Keep the adapter small, retain a fallback, avoid depending on unreleased features. |
| Model licence mismatch | Distribution or notice problem | Per-model licence manifest and release review. |
| Too many user choices | Confusing UI and weak test coverage | Offer a small set of task-based modes. |
| CUDA package growth | Large installer and support burden | Make CUDA an optional download after demand is proven. |
| Cross-target npm staging | Missing Windows native files | Explicit target package staging and packaged smoke tests in release CI. |

## Pros and cons

### Pros

- Reuses ordinary existing whisper.cpp `.bin` models.
- Opens a much larger, actively developed model catalogue.
- Offers word-timed models that may suit fast English transcription well.
- Supplies CPU, Vulkan, Metal and CUDA through one runtime.
- Provides maintained TypeScript bindings with structured results,
  cancellation and model reuse.
- Keeps inference local and compatible with the current privacy design.
- Has a permissive runtime licence compatible with GPLv3.
- Gives a credible future route to streaming and macOS Metal support.
- Showed encouraging speed and memory in the limited local smoke test.

### Cons

- Is not output-compatible with `whisper-cli`.
- Does not ship the example CLI in native release archives.
- Loses Whisper word timestamps, DTW and TinyDiarize.
- Has open silent-omission reports in important candidate paths.
- Is young, pre-1.0 and heavily dependent on one maintainer.
- Requires new worker, result, packaging and backend fallback code.
- Expands the model licence and quality assurance workload.
- Direct binding use would reduce crash isolation.
- MOSS diarization has high duration-linked memory use and a narrow language
  range.
- Wider hardware support increases the release test matrix.

## Recommendation

Adopt transcribe.cpp as the engine for an experimental model playground. Do not
make whisper.cpp removal the goal of the first project.

Build the capability catalogue, normal result and helper process first. The
first useful release should expose the current Whisper path as a control plus
Parakeet 110M and Moonshine tiny as clearly different experiments. Follow with
Canary, Qwen and Nemotron only after the catalogue, download flow and saved
comparison metadata work well.

Keep whisper.cpp for the reliable default, DTW-backed pyannote merge and
TinyDiarize. A model does not need full feature parity to enter the experimental
catalogue; it needs accurate capability labels, safe process isolation,
reproducible versioning and no silent misuse of unsupported options.

Whether transcribe.cpp eventually becomes the default is a later decision
based on what the experiments show. This approach captures its real value now:
one integration opens access to many genuinely different speech models without
making the existing workflow less reliable.

## Primary upstream sources

- [transcribe.cpp repository](https://github.com/handy-computer/transcribe.cpp)
- [reviewed commit](https://github.com/handy-computer/transcribe.cpp/tree/5a5a49664a8ea1f0e5b3be1dfc544730d1b62561)
- [v0.1.3 release](https://github.com/handy-computer/transcribe.cpp/releases/tag/v0.1.3)
- [Whisper model capabilities](https://github.com/handy-computer/transcribe.cpp/blob/5a5a49664a8ea1f0e5b3be1dfc544730d1b62561/docs/models/whisper.md)
- [TypeScript binding](https://github.com/handy-computer/transcribe.cpp/tree/5a5a49664a8ea1f0e5b3be1dfc544730d1b62561/bindings/typescript)
- [Parakeet model documentation](https://github.com/handy-computer/transcribe.cpp/blob/5a5a49664a8ea1f0e5b3be1dfc544730d1b62561/docs/models/parakeet.md)
- [Parakeet 110M model card](https://github.com/handy-computer/transcribe.cpp/blob/5a5a49664a8ea1f0e5b3be1dfc544730d1b62561/docs/models/parakeet-tdt_ctc-110m.md)
- [Moonshine tiny model card](https://github.com/handy-computer/transcribe.cpp/blob/5a5a49664a8ea1f0e5b3be1dfc544730d1b62561/docs/models/moonshine-tiny.md)
- [Canary 180M Flash model card](https://github.com/handy-computer/transcribe.cpp/blob/5a5a49664a8ea1f0e5b3be1dfc544730d1b62561/docs/models/canary-180m-flash.md)
- [Qwen3-ASR 0.6B model card](https://github.com/handy-computer/transcribe.cpp/blob/5a5a49664a8ea1f0e5b3be1dfc544730d1b62561/docs/models/qwen3-asr-0.6b.md)
- [Nemotron 3.5 model card](https://github.com/handy-computer/transcribe.cpp/blob/5a5a49664a8ea1f0e5b3be1dfc544730d1b62561/docs/models/nemotron-3.5-asr-streaming-0.6b.md)
- [SenseVoice model card](https://github.com/handy-computer/transcribe.cpp/blob/5a5a49664a8ea1f0e5b3be1dfc544730d1b62561/docs/models/sensevoice-small.md)
- [MedASR model card](https://github.com/handy-computer/transcribe.cpp/blob/5a5a49664a8ea1f0e5b3be1dfc544730d1b62561/docs/models/medasr.md)
- [MOSS model documentation](https://github.com/handy-computer/transcribe.cpp/blob/5a5a49664a8ea1f0e5b3be1dfc544730d1b62561/docs/models/moss-transcribe-diarize.md)
- [Whisper silent truncation issue 89](https://github.com/handy-computer/transcribe.cpp/issues/89)
- [Parakeet missing span issue 71](https://github.com/handy-computer/transcribe.cpp/issues/71)
- [Windows CPU compatibility issue 88](https://github.com/handy-computer/transcribe.cpp/issues/88)

## Relevant local sources

- `lib/transcription-runner.js`
- `lib/whisper-runner.js`
- `lib/capabilities.js`
- `lib/models.js`
- `lib/diarize-merge.js`
- `lib/paths.js`
- `scripts/build.sh`
- `.github/workflows/release.yml`
- `docs/diarization.md`
- `docs/privacy-architecture.md`
