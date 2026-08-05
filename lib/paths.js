// Transcriber - local audio/video transcription
// Copyright (C) 2026 Andrew James Turner
// Licensed under the GNU General Public License v3.0
// See LICENSE for the full licence text.

/**
 * Shared binary-path resolution.
 *
 * Owns the non-trivial logic for resolving paths to platform binaries
 * (whisper-cli, ffmpeg), library-path environment setup, and resource-path
 * resolution for both dev and packaged (asar) layouts.
 *
 * Used by lib/capabilities.js (DTW probe, Vulkan existence check) and by
 * main.js (transcription runner: ffmpeg, whisper binary, model path).
 */

const path = require('path');
const os = require('os');

let _isPackaged = null;
let _resourcesPath = null;
let _modelDirectory = null;

/**
 * Initialise the path resolver. Called once from main.js after app is ready.
 *
 * @param {object} opts
 * @param {boolean} opts.isPackaged - app.isPackaged value
 * @param {string}  opts.resourcesPath - process.resourcesPath (packaged) or __dirname (dev)
 * @param {string}  [opts.modelDirectory] - writable directory for downloaded models
 */
function initPaths({ isPackaged, resourcesPath, modelDirectory }) {
  _isPackaged = isPackaged;
  _resourcesPath = resourcesPath;
  _modelDirectory = modelDirectory || path.join(resourcesPath, 'models');
}

/**
 * Resolve a path relative to the app root (dev) or resources dir (packaged).
 */
function getResourcePath(relativePath) {
  if (_isPackaged) {
    return path.join(_resourcesPath, relativePath);
  }
  return path.join(_resourcesPath, relativePath);
}

function getUnpackedPath(relativePath) {
  if (_isPackaged) {
    return path.join(_resourcesPath, 'app.asar.unpacked', relativePath);
  }
  return path.join(_resourcesPath, relativePath);
}

/**
 * Return the platform subdirectory name ('win', 'linux', or 'mac').
 */
function getPlatformDir() {
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}

/**
 * Resolve the whisper-cli binary for a given backend.
 *
 * @param {'cpu'|'vulkan'} backend - required; no default is applied here
 */
function getWhisperBinary(backend) {
  const name = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  return getResourcePath(path.join('bin', getPlatformDir(), backend, name));
}

/**
 * Resolve the ffmpeg binary.
 */
function getFfmpegBinary() {
  const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  return getResourcePath(path.join('bin', getPlatformDir(), name));
}

function getTranscribeWorkerPath() {
  return getUnpackedPath(path.join('worker', 'transcribe-worker.mjs'));
}

function getTranscribeWorkerLaunch() {
  const env = { ...process.env };
  if (process.versions && process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  return { command: process.execPath, args: [getTranscribeWorkerPath()], env };
}

function getBundledModelPath(fileName) {
  return getResourcePath(path.join('models', fileName));
}

function getModelDownloadPath(fileName) {
  return path.join(_modelDirectory, fileName);
}

function getStandaloneModelDirectory({
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
} = {}) {
  if (env.TRANSCRIBER_MODEL_DIR) return path.resolve(env.TRANSCRIBER_MODEL_DIR);
  if (platform === 'win32') {
    const dataRoot = env.LOCALAPPDATA || env.APPDATA || path.join(homedir, 'AppData', 'Local');
    return path.join(dataRoot, 'Transcriber', 'models');
  }
  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Application Support', 'Transcriber', 'models');
  }
  return path.join(env.XDG_DATA_HOME || path.join(homedir, '.local', 'share'), 'transcriber', 'models');
}

/**
 * Build an environment object with the library path set to binDir so that
 * whisper-cli can find its shared libraries at runtime.
 */
function makeEnvWithLibPath(binDir) {
  const env = { ...process.env };
  if (process.platform === 'linux') {
    env.LD_LIBRARY_PATH = binDir + (env.LD_LIBRARY_PATH ? ':' + env.LD_LIBRARY_PATH : '');
  } else if (process.platform === 'darwin') {
    env.DYLD_LIBRARY_PATH = binDir + (env.DYLD_LIBRARY_PATH ? ':' + env.DYLD_LIBRARY_PATH : '');
  }
  return env;
}

module.exports = {
  initPaths,
  getResourcePath,
  getUnpackedPath,
  getPlatformDir,
  getWhisperBinary,
  getFfmpegBinary,
  getTranscribeWorkerPath,
  getTranscribeWorkerLaunch,
  getBundledModelPath,
  getModelDownloadPath,
  getStandaloneModelDirectory,
  makeEnvWithLibPath,
};
