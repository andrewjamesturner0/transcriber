// Transcriber — local audio/video transcription
// Copyright (C) 2026 Andrew James Turner
// Licensed under the GNU General Public License v3.0
// See LICENSE for the full licence text.

/**
 * Platform capability detection.
 *
 * Consolidates GPU backend detection, DTW support probing, Python
 * availability, and pyannote detection into a single module, replacing
 * the scattered global-state approach that lived in main.js.
 *
 * Design decisions (see todo-1-capabilities.md):
 *   D1 — Eager detection: detect() probes everything at startup.
 *   D2 — Settings callbacks injected: getPreference / setPreference.
 *   D3 — Binary paths via shared lib/paths.js.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const GPU_DETECT_TIMEOUT = 5000;
// `diarize.py --check` imports torch and asks about CUDA; allow for a cold
// start on Windows.
const PYTHON_CHECK_TIMEOUT = 60000;

// Status strings from `lib/diarize.py --check`, plus two set here:
// 'python-missing' (no interpreter) and 'unknown' (check script missing or
// its output unreadable).
const DIARIZATION_STATUSES = [
  'ready', 'model-not-prepared', 'pyannote-missing', 'pyannote-unsupported',
  'python-unsupported',
];
const MIN_PYTHON = [3, 10];
const SUPPORTED_PYANNOTE_MAJOR = 4;

// ---------------------------------------------------------------------------
// Capabilities class
// ---------------------------------------------------------------------------

class Capabilities {
  /**
   * @param {object} opts
   * @param {Function} [opts.getPreference] - (key) => value | undefined
   * @param {Function} [opts.setPreference] - (key, value) => void
   * @param {object}   [opts.paths]         - lib/paths.js interface (injected for tests)
   * @param {Function} [opts.spawn]          - child_process.spawn (injected for tests)
   * @param {Function} [opts.fsExists]       - fs.existsSync (injected for tests)
   * @param {Function} [opts.logWrite]       - log writer callback
   * @param {object}   [opts.env]            - environment (defaults to process.env; injected for tests)
   */
  constructor(opts = {}) {
    this._getPreference = opts.getPreference || (() => undefined);
    this._setPreference = opts.setPreference || (() => {});
    this._paths = opts.paths || require('./paths');
    this._spawn = opts.spawn || spawn;
    this._fsExists = opts.fsExists || fs.existsSync;
    this._log = opts.logWrite || (() => {});
    this._env = opts.env || process.env;

    // Internal state (replaces gpuState, dtwState, cachedPythonCmd globals)
    this._gpu = { setting: 'auto', detected: null, deviceName: null, deviceIndex: null };
    this._gpuDetectionPromise = null;
    // Per-executable DTW support: null = unchecked, true/false = known.
    this._dtwSupport = { cpu: null, vulkan: null };
    this._cachedPythonCmd = null;
    this._pythonInfo = null;     // cached result of getPythonInfo()
    this._pythonInfoPromise = null; // in-flight probe shared by concurrent callers

    // Load persisted backend preference on construction
    const saved = this._getPreference('gpuBackend');
    if (saved) this._gpu.setting = saved;
  }

  // -- Internal helpers ------------------------------------------------------

  /**
   * Run a command and return its stdout. Throws on non-zero exit or error.
   * Uses this._spawn so tests can inject a mock.
   */
  _run(cmd, args, { timeout, env } = {}) {
    return new Promise((resolve, reject) => {
      const proc = this._spawn(cmd, args, { env, timeout });
      const stdoutChunks = [];
      const stderrChunks = [];
      proc.stdout.on('data', (d) => stdoutChunks.push(d));
      proc.stderr.on('data', (d) => stderrChunks.push(d));
      proc.on('close', (code) => {
        if (code === 0) resolve(Buffer.concat(stdoutChunks).toString());
        else reject(new Error(`exit ${code}: ${Buffer.concat(stderrChunks).toString().slice(0, 200)}`));
      });
      proc.on('error', reject);
    });
  }

  // -- Public API -----------------------------------------------------------

  /**
   * Eagerly detect all capabilities. Call once at startup.
   * GPU, DTW, and Python probes run concurrently.
   */
  async detect() {
    const probes = [
      this.detectGpu().then(() => {
        this._log(`[GPU] Active backend: ${this.getActiveBackend()} (setting=${this._gpu.setting}, detected=${this._gpu.detected})`);
      }),
      this.detectDtw(),
      // Python is probed lazily by getPythonInfo(); eager probe is cheap
      // so we warm the cache here.
      this.getPythonInfo().then((info) => {
        this._log(`[PYTHON] found=${info.pythonFound} supported=${info.pythonSupported} pyannote=${info.pyannoteVersion || 'none'} status=${info.diarizationStatus} gpu=${info.gpuAvailable}`);
      }).catch((err) => {
        this._log(`[PYTHON] Probe error: ${err.message}`);
      }),
    ];
    await Promise.allSettled(probes);
  }

  /**
   * Start GPU detection once and return the shared probe promise.
   * Callers that display or use the selected backend can await this without
   * waiting for the unrelated DTW and Python probes run by detect().
   */
  detectGpu() {
    if (!this._gpuDetectionPromise) {
      this._gpuDetectionPromise = this._detectGpu();
    }
    return this._gpuDetectionPromise;
  }

  /**
   * Probe DTW support for the CPU binary and, if present, the Vulkan
   * binary, and store the results. Returns { cpu, vulkan } (vulkan stays
   * null when its binary is missing).
   */
  async detectDtw() {
    const backends = ['cpu'];
    if (this._fsExists(this._paths.getWhisperBinary('vulkan'))) backends.push('vulkan');
    await Promise.all(backends.map(async (b) => {
      const supported = await this._detectDtw(b);
      this._dtwSupport[b] = supported;
      this._log(`[DTW] Support detected (${b}): ${supported}`);
    }));
    return { ...this._dtwSupport };
  }

  /** Return the currently active backend ('cpu' or 'vulkan'). */
  getActiveBackend() {
    if (this._gpu.setting === 'vulkan' && this._fsExists(this._paths.getWhisperBinary('vulkan'))) {
      return 'vulkan';
    }
    if (this._gpu.setting === 'cpu') return 'cpu';
    return this._gpu.detected || 'cpu';
  }

  /**
   * Persist a user backend preference.
   * @param {'auto'|'cpu'|'vulkan'} backend
   * @returns {boolean} true if valid and persisted
   */
  setBackendPreference(backend) {
    if (!['auto', 'cpu', 'vulkan'].includes(backend)) return false;
    this._gpu.setting = backend;
    this._setPreference('gpuBackend', backend);
    this._log(`[GPU] Backend preference set to: ${backend} (active: ${this.getActiveBackend()})`);
    return true;
  }

  /**
   * Return the full GPU status object for the renderer.
   * Replaces the get-gpu-status IPC handler.
   */
  getStatus() {
    const vulkanExists = this._fsExists(this._paths.getWhisperBinary('vulkan'));
    const available = ['cpu'];
    if (vulkanExists) available.push('vulkan');
    const backend = this.getActiveBackend();
    return {
      backend,
      detected: this._gpu.detected,
      deviceName: this._gpu.deviceName,
      setting: this._gpu.setting,
      available,
      // DTW support for the active backend, and per backend
      // (null = not probed).
      dtwSupported: this.isDtwSupported(backend),
      dtwSupport: { ...this._dtwSupport },
    };
  }

  /**
   * True if the whisper binary for `backend` supports DTW (both --dtw and
   * --no-flash-attn). Unprobed backends are treated optimistically.
   * With no argument, reports the CPU binary (the pre-per-backend behaviour).
   *
   * @param {'cpu'|'vulkan'} [backend='cpu']
   */
  isDtwSupported(backend) {
    const b = backend || 'cpu';
    return this._dtwSupport[b] !== false;
  }

  /**
   * Mark DTW as unsupported for one backend's binary (called when a
   * transcription fails with a DTW-related error, so subsequent runs skip
   * --dtw for this session). With no argument, disables it for every
   * backend, as the old single session-wide flag did.
   *
   * @param {'cpu'|'vulkan'} [backend]
   */
  disableDtw(backend) {
    if (backend) {
      this._dtwSupport[backend] = false;
    } else {
      for (const b of Object.keys(this._dtwSupport)) this._dtwSupport[b] = false;
    }
  }

  /**
   * Disable GPU for the remainder of this session (called when a
   * non-OOM Vulkan error occurs during transcription).
   */
  disableGpu() {
    this._gpu.detected = 'cpu';
  }

  /**
   * Probe the Python environment and return structured info.
   * Cached after first call; pass { refresh: true } to probe again (for
   * example after the user installs pyannote or prepares the model).
   * Replaces the check-python IPC handler.
   *
   * Runs `<python> lib/diarize.py --check` once and maps its JSON. If the
   * script is missing or its output cannot be read, falls back to the older
   * import probes, which cannot tell whether the model is prepared.
   *
   * @param {object}  [opts]
   * @param {boolean} [opts.refresh=false]
   * @returns {Promise<{pythonFound: boolean, pythonVersion: string|null,
   *                    pythonSupported: boolean,
   *                    pyannoteInstalled: boolean, pyannoteVersion: string|null,
   *                    pyannoteSupported: boolean, gpuAvailable: boolean,
   *                    diarizationStatus: string, diarizationMessage: string|null,
   *                    modelReady: boolean,
   *                    model: {id: string, revision: string|null}|null}>}
   *   pythonFound is true for any runnable Python 3 (3.9 is found but not
   *   supported). diarizationStatus is one of the `diarize.py --check`
   *   statuses (ready, model-not-prepared, pyannote-missing,
   *   pyannote-unsupported, python-unsupported), or 'python-missing' when no
   *   interpreter was found, or 'unknown' when the check could not run.
   */
  async getPythonInfo({ refresh = false } = {}) {
    if (refresh) {
      this._pythonInfo = null;
      this._cachedPythonCmd = null;
    }
    if (this._pythonInfo) return this._pythonInfo;
    if (!this._pythonInfoPromise) {
      this._pythonInfoPromise = this._probePython()
        .then((info) => { this._pythonInfo = info; return info; })
        .finally(() => { this._pythonInfoPromise = null; });
    }
    return this._pythonInfoPromise;
  }

  /**
   * Get the cached python command (for use by the transcription runner
   * when launching diarization). Returns the bare command; when it is the
   * Windows `py` launcher, callers must add `-3` (see getPythonSpawn).
   */
  async getPythonCommand() {
    return this._findPython();
  }

  /**
   * Resolve how to spawn the selected Python: the command plus any prefix
   * arguments that must come before the script path (`-3` for the `py`
   * launcher). Honours TRANSCRIBER_PYTHON. Returns null if none was found.
   *
   * @returns {Promise<{command: string, args: string[]}|null>}
   */
  async getPythonSpawn() {
    const cmd = await this._findPython();
    if (!cmd) return null;
    return { command: cmd, args: this._pythonArgs(cmd, []) };
  }

  /**
   * Probe optional word alignment (design decision D3/D4) with the same
   * Python the jobs use: runs `lib/align.py --check --language <lang>`.
   * Cached per language; pass refresh to probe again (after setup).
   *
   * @returns {Promise<{alignmentStatus: string, alignmentMessage: string|null,
   *   language: string, whisperxVersion: string|null, model: object|null}>}
   */
  async getAlignmentInfo({ language = 'en', refresh = false } = {}) {
    if (!this._alignmentInfo) this._alignmentInfo = new Map();
    if (refresh) this._alignmentInfo.delete(language);
    if (this._alignmentInfo.has(language)) return this._alignmentInfo.get(language);

    const info = { alignmentStatus: 'python-missing', alignmentMessage: null, language, whisperxVersion: null, model: null };
    const pythonCmd = await this._findPython();
    let script = null;
    try {
      script = typeof this._paths.getResourcePath === 'function'
        ? this._paths.getResourcePath(path.join('lib', 'align.py')) : null;
    } catch (_) { script = null; }
    if (pythonCmd && (!script || !this._fsExists(script))) {
      info.alignmentStatus = 'unknown';
      info.alignmentMessage = 'align.py not found';
    } else if (pythonCmd) {
      try {
        const out = await this._run(pythonCmd, this._pythonArgs(pythonCmd, [script, '--check', '--language', language]),
          { timeout: PYTHON_CHECK_TIMEOUT });
        const parsed = parseCheckOutput(out);
        if (parsed && typeof parsed.status === 'string') {
          info.alignmentStatus = parsed.status;
          info.alignmentMessage = parsed.message || null;
          info.whisperxVersion = (parsed.versions && parsed.versions.whisperx) || null;
          info.model = parsed.model || null;
        } else {
          info.alignmentStatus = 'unknown';
        }
      } catch (err) {
        this._log(`[ALIGN] align.py --check failed: ${err.message}`);
        info.alignmentStatus = 'unknown';
      }
    }
    this._alignmentInfo.set(language, info);
    return info;
  }

  // -- Internal probes -------------------------------------------------------

  /** Prefix `-3` for the Windows `py` launcher (bare or by path). */
  _pythonArgs(cmd, args) {
    return /(^|[\\/])py(\.exe)?$/i.test(cmd) ? ['-3', ...args] : args;
  }

  /**
   * Find a runnable Python. TRANSCRIBER_PYTHON (an interpreter path)
   * replaces the PATH search; if it is set but cannot be run, report not
   * found rather than silently using another interpreter.
   */
  async _findPython() {
    if (this._cachedPythonCmd) return this._cachedPythonCmd;
    const override = (this._env.TRANSCRIBER_PYTHON || '').trim();
    const candidates = override
      ? [override]
      : (process.platform === 'win32' ? ['python3', 'python', 'py'] : ['python3', 'python']);
    for (const cmd of candidates) {
      try {
        await this._run(cmd, this._pythonArgs(cmd, ['--version']));
        this._cachedPythonCmd = cmd;
        return cmd;
      } catch (_) { /* not found */ }
    }
    if (override) this._log(`[PYTHON] TRANSCRIBER_PYTHON is set but could not be run: ${override}`);
    return null;
  }

  async _probePython() {
    const result = {
      pythonFound: false,
      pythonVersion: null,
      pythonSupported: false,
      pyannoteInstalled: false,
      pyannoteVersion: null,
      pyannoteSupported: false,
      gpuAvailable: false,
      diarizationStatus: 'python-missing',
      diarizationMessage: null,
      modelReady: false,
      model: null,
    };

    const pythonCmd = await this._findPython();
    if (!pythonCmd) return result;

    try {
      const out = await this._run(pythonCmd, this._pythonArgs(pythonCmd, ['--version']));
      const match = out.match(/Python (\d+)\.(\d+)\.(\d+)/);
      if (match && parseInt(match[1], 10) >= 3) {
        result.pythonFound = true;
        result.pythonVersion = `${match[1]}.${match[2]}.${match[3]}`;
        result.pythonSupported = isSupportedPython(match[1], match[2]);
      }
    } catch (_) { /* version check failed */ }

    if (!result.pythonFound) return result;

    const check = await this._runDiarizeCheck(pythonCmd);
    if (check) {
      applyDiarizeCheck(result, check);
    } else {
      await this._legacyPythonProbe(pythonCmd, result);
    }
    return result;
  }

  /** Resolve lib/diarize.py, or null if the paths helper cannot. */
  _diarizeScriptPath() {
    try {
      if (typeof this._paths.getResourcePath !== 'function') return null;
      return this._paths.getResourcePath(path.join('lib', 'diarize.py'));
    } catch (_) {
      return null;
    }
  }

  /**
   * Run `diarize.py --check` and return its parsed JSON object, or null if
   * the script is missing, fails, or prints something unreadable.
   */
  async _runDiarizeCheck(pythonCmd) {
    const script = this._diarizeScriptPath();
    if (!script || !this._fsExists(script)) {
      this._log('[PYTHON] diarize.py not found, using basic import probes');
      return null;
    }
    let out;
    try {
      out = await this._run(pythonCmd, this._pythonArgs(pythonCmd, [script, '--check']),
        { timeout: PYTHON_CHECK_TIMEOUT });
    } catch (err) {
      this._log(`[PYTHON] diarize.py --check failed: ${err.message}`);
      return null;
    }
    const parsed = parseCheckOutput(out);
    if (!parsed) this._log(`[PYTHON] diarize.py --check output not understood: ${String(out).slice(0, 200)}`);
    return parsed;
  }

  /**
   * Older probes used when `--check` is unavailable: import pyannote.audio
   * and torch directly. Cannot report whether the model is prepared.
   */
  async _legacyPythonProbe(pythonCmd, result) {
    const pyArgs = (code) => this._pythonArgs(pythonCmd, ['-c', code]);

    try {
      const out = await this._run(pythonCmd, pyArgs('import pyannote.audio; print(pyannote.audio.__version__)'));
      result.pyannoteInstalled = true;
      result.pyannoteVersion = out.trim();
    } catch (_) { /* not installed */ }

    try {
      const out = await this._run(pythonCmd, pyArgs('import torch; print(torch.cuda.is_available())'));
      result.gpuAvailable = out.trim() === 'True';
    } catch (_) { /* torch not installed or no GPU */ }

    result.pyannoteSupported = result.pyannoteInstalled
      && majorVersion(result.pyannoteVersion) === SUPPORTED_PYANNOTE_MAJOR;
    if (!result.pythonSupported) result.diarizationStatus = 'python-unsupported';
    else if (!result.pyannoteInstalled) result.diarizationStatus = 'pyannote-missing';
    else if (!result.pyannoteSupported) result.diarizationStatus = 'pyannote-unsupported';
    else result.diarizationStatus = 'unknown';
  }


  async _detectGpu() {
    const vulkanBinary = this._paths.getWhisperBinary('vulkan');
    if (!this._fsExists(vulkanBinary)) {
      this._log('[GPU] Vulkan binary not found, using CPU');
      this._gpu.detected = 'cpu';
      return;
    }

    try {
      const stderrChunks = [];
      await new Promise((resolve, reject) => {
        const proc = this._spawn(vulkanBinary, ['--help'], {
          env: this._paths.makeEnvWithLibPath(path.dirname(vulkanBinary)),
          timeout: GPU_DETECT_TIMEOUT,
        });
        proc.stderr.on('data', (d) => stderrChunks.push(d));
        proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
        proc.on('error', reject);
      });

      const stderrText = Buffer.concat(stderrChunks).toString();
      const deviceRegex = /ggml_vulkan:\s*(\d+)\s*=\s*(.+?)(?:\s*\(|$)/gm;
      const devices = [];
      let match;
      while ((match = deviceRegex.exec(stderrText)) !== null) {
        devices.push({ index: parseInt(match[1]), name: match[2].trim() });
      }
      this._log(`[GPU] Found ${devices.length} Vulkan device(s): ${devices.map(d => `${d.index}=${d.name}`).join(', ')}`);

      // Prefer discrete GPU (non-Intel) over integrated
      const discrete = devices.find(d => !/\bintel\b/i.test(d.name));
      const chosen = discrete || devices[0] || null;

      if (chosen && !/\bintel\b/i.test(chosen.name)) {
        this._gpu.deviceName = chosen.name;
        this._gpu.deviceIndex = chosen.index;
        process.env.GGML_VK_VISIBLE_DEVICES = String(chosen.index);
        this._log(`[GPU] Using Vulkan device ${chosen.index}: ${chosen.name}`);
        this._gpu.detected = 'vulkan';
      } else if (chosen) {
        this._gpu.deviceName = chosen.name;
        this._log(`[GPU] Only Intel integrated GPU found (${chosen.name}), using CPU instead`);
        this._gpu.detected = 'cpu';
      } else {
        this._log('[GPU] No Vulkan devices found, using CPU');
        this._gpu.detected = 'cpu';
      }
    } catch (err) {
      this._log(`[GPU] Vulkan test failed (${err.message}), using CPU`);
      this._gpu.detected = 'cpu';
    }
  }

  /**
   * Probe one backend's whisper binary `--help` for DTW support. Both
   * `--dtw` and `--no-flash-attn` must be listed: whisper.cpp silently
   * disables DTW under flash attention, which is on by default.
   *
   * @param {'cpu'|'vulkan'} [backend='cpu']
   * @returns {Promise<boolean>}
   */
  async _detectDtw(backend = 'cpu') {
    try {
      const binary = this._paths.getWhisperBinary(backend);
      const chunks = [];
      await new Promise((resolve, reject) => {
        const proc = this._spawn(binary, ['--help'], {
          env: this._paths.makeEnvWithLibPath(path.dirname(binary)),
          timeout: GPU_DETECT_TIMEOUT,
        });
        // whisper-cli prints usage to stderr; read stdout too in case that changes.
        proc.stdout.on('data', (d) => chunks.push(d));
        proc.stderr.on('data', (d) => chunks.push(d));
        proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
        proc.on('error', reject);
      });
      const text = Buffer.concat(chunks).toString();
      return /--dtw\b/i.test(text) && /(?:--no-flash-attn|(?:^|\s)-nfa)\b/i.test(text);
    } catch (err) {
      this._log(`[DTW] Probe failed (${backend}): ${err.message}`);
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Python check helpers
// ---------------------------------------------------------------------------

function isSupportedPython(major, minor) {
  const ma = parseInt(major, 10);
  const mi = parseInt(minor, 10);
  return ma > MIN_PYTHON[0] || (ma === MIN_PYTHON[0] && mi >= MIN_PYTHON[1]);
}

function majorVersion(version) {
  const match = /^(\d+)/.exec(String(version || ''));
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Find the `diarize.py --check` JSON object in stdout (the last line that
 * parses to an object with a string `status`). Returns null otherwise.
 */
function parseCheckOutput(out) {
  const lines = String(out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj && typeof obj === 'object' && !Array.isArray(obj) && typeof obj.status === 'string') {
        return obj;
      }
    } catch (_) { /* not JSON */ }
  }
  return null;
}

/** Copy `diarize.py --check` fields onto a getPythonInfo() result. */
function applyDiarizeCheck(result, check) {
  const versions = (check.versions && typeof check.versions === 'object') ? check.versions : {};
  if (typeof check.pythonSupported === 'boolean') result.pythonSupported = check.pythonSupported;
  const pyannote = versions['pyannote.audio'];
  result.pyannoteVersion = typeof pyannote === 'string' && pyannote ? pyannote : null;
  result.pyannoteInstalled = result.pyannoteVersion !== null;
  result.pyannoteSupported = check.pyannoteSupported === true;
  result.gpuAvailable = check.cudaAvailable === true;
  result.diarizationStatus = DIARIZATION_STATUSES.includes(check.status) ? check.status : 'unknown';
  result.diarizationMessage = typeof check.message === 'string' ? check.message : null;
  result.modelReady = check.modelReady === true;
  result.model = (check.model && typeof check.model.id === 'string')
    ? { id: check.model.id, revision: typeof check.model.revision === 'string' ? check.model.revision : null }
    : null;
}

module.exports = Capabilities;
