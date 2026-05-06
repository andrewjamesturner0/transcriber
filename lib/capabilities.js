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
   */
  constructor(opts = {}) {
    this._getPreference = opts.getPreference || (() => undefined);
    this._setPreference = opts.setPreference || (() => {});
    this._paths = opts.paths || require('./paths');
    this._spawn = opts.spawn || spawn;
    this._fsExists = opts.fsExists || fs.existsSync;
    this._log = opts.logWrite || (() => {});

    // Internal state (replaces gpuState, dtwState, cachedPythonCmd globals)
    this._gpu = { setting: 'auto', detected: null, deviceName: null, deviceIndex: null };
    this._dtwSupported = null;   // null = unchecked, true/false = known
    this._cachedPythonCmd = null;
    this._pythonInfo = null;     // cached result of getPythonInfo()

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
      this._detectGpu().then(() => {
        this._log(`[GPU] Active backend: ${this.getActiveBackend()} (setting=${this._gpu.setting}, detected=${this._gpu.detected})`);
      }),
      this._detectDtw().then((supported) => {
        this._dtwSupported = supported;
        this._log(`[DTW] Support detected: ${supported}`);
      }),
      // Python is probed lazily by getPythonInfo(); eager probe is cheap
      // so we warm the cache here.
      this.getPythonInfo().then((info) => {
        this._log(`[PYTHON] found=${info.pythonFound} pyannote=${info.pyannoteInstalled} gpu=${info.gpuAvailable}`);
      }).catch((err) => {
        this._log(`[PYTHON] Probe error: ${err.message}`);
      }),
    ];
    await Promise.allSettled(probes);
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
    return {
      backend: this.getActiveBackend(),
      detected: this._gpu.detected,
      deviceName: this._gpu.deviceName,
      setting: this._gpu.setting,
      available,
    };
  }

  /** True if the current whisper binary supports --dtw. */
  isDtwSupported() {
    return this._dtwSupported !== false;
  }

  /**
   * Mark DTW as unsupported (called when a transcription fails with a
   * DTW-related error, so subsequent runs skip --dtw for this session).
   */
  disableDtw() {
    this._dtwSupported = false;
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
   * Cached after first call. Replaces the check-python IPC handler.
   *
   * @returns {Promise<{pythonFound: boolean, pythonVersion: string|null,
   *                    pyannoteInstalled: boolean, pyannoteVersion: string|null,
   *                    gpuAvailable: boolean}>}
   */
  async getPythonInfo() {
    if (this._pythonInfo) return this._pythonInfo;

    const result = {
      pythonFound: false,
      pythonVersion: null,
      pyannoteInstalled: false,
      pyannoteVersion: null,
      gpuAvailable: false,
    };

    const pythonCmd = await this._findPython();
    if (!pythonCmd) {
      this._pythonInfo = result;
      return result;
    }

    // Check version >= 3.9
    try {
      const vArgs = pythonCmd === 'py' ? ['-3', '--version'] : ['--version'];
      const out = await this._run(pythonCmd, vArgs);
      const match = out.match(/Python (\d+)\.(\d+)\.(\d+)/);
      if (match) {
        const major = parseInt(match[1], 10);
        const minor = parseInt(match[2], 10);
        if (major >= 3 && minor >= 9) {
          result.pythonFound = true;
          result.pythonVersion = `${match[1]}.${match[2]}.${match[3]}`;
        }
      }
    } catch (_) { /* version check failed */ }

    if (!result.pythonFound) {
      this._pythonInfo = result;
      return result;
    }

    const pyArgs = (code) => pythonCmd === 'py' ? ['-3', '-c', code] : ['-c', code];

    // Check pyannote.audio
    try {
      const out = await this._run(pythonCmd, pyArgs('import pyannote.audio; print(pyannote.audio.__version__)'));
      result.pyannoteInstalled = true;
      result.pyannoteVersion = out.trim();
    } catch (_) { /* not installed */ }

    // Check GPU (torch + CUDA)
    try {
      const out = await this._run(pythonCmd, pyArgs('import torch; print(torch.cuda.is_available())'));
      result.gpuAvailable = out.trim() === 'True';
    } catch (_) { /* torch not installed or no GPU */ }

    this._pythonInfo = result;
    return result;
  }

  /**
   * Get the cached python command (for use by the transcription runner
   * when launching diarization).
   */
  async getPythonCommand() {
    return this._findPython();
  }

  // -- Internal probes -------------------------------------------------------

  async _findPython() {
    if (this._cachedPythonCmd) return this._cachedPythonCmd;
    const candidates = process.platform === 'win32'
      ? ['python3', 'python', 'py']
      : ['python3', 'python'];
    for (const cmd of candidates) {
      try {
        const args = cmd === 'py' ? ['-3', '--version'] : ['--version'];
        await this._run(cmd, args);
        this._cachedPythonCmd = cmd;
        return cmd;
      } catch (_) { /* not found */ }
    }
    return null;
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

  async _detectDtw() {
    try {
      const cpuBinary = this._paths.getWhisperBinary('cpu');
      const stderrChunks = [];
      await new Promise((resolve, reject) => {
        const proc = this._spawn(cpuBinary, ['--help'], {
          timeout: GPU_DETECT_TIMEOUT,
        });
        proc.stderr.on('data', (d) => stderrChunks.push(d));
        proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
        proc.on('error', reject);
      });
      const text = Buffer.concat(stderrChunks).toString();
      return /--dtw/i.test(text);
    } catch (err) {
      this._log(`[DTW] Probe failed: ${err.message}`);
      return false;
    }
  }
}

module.exports = Capabilities;
