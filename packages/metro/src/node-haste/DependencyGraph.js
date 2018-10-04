/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 * @format
 */

'use strict';

const AssetResolutionCache = require('./AssetResolutionCache');
const DependencyGraphHelpers = require('./DependencyGraph/DependencyGraphHelpers');
const FilesByDirNameIndex = require('./FilesByDirNameIndex');
const JestHasteMap = require('jest-haste-map');
const Module = require('./Module');
const ModuleCache = require('./ModuleCache');
const ResolutionRequest = require('./DependencyGraph/ResolutionRequest');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {ModuleResolver} = require('./DependencyGraph/ModuleResolution');
const {EventEmitter} = require('events');
const {
  Logger: {createActionStartEntry, createActionEndEntry, log},
} = require('metro-core');

import type {ModuleMap} from './DependencyGraph/ModuleResolution';
import type Package from './Package';
import type {HasteFS} from './types';
import type {ConfigT} from 'metro-config/src/configTypes.flow';

const JEST_HASTE_MAP_CACHE_BREAKER = 4;

class DependencyGraph extends EventEmitter {
  _assetResolutionCache: AssetResolutionCache;
  _config: ConfigT;
  _filesByDirNameIndex: FilesByDirNameIndex;
  _haste: JestHasteMap;
  _hasteFS: HasteFS;
  _helpers: DependencyGraphHelpers;
  _moduleCache: ModuleCache;
  _moduleMap: ModuleMap;
  _moduleResolver: ModuleResolver<Module, Package>;

  constructor({
    config,
    haste,
    initialHasteFS,
    initialModuleMap,
  }: {|
    +config: ConfigT,
    +haste: JestHasteMap,
    +initialHasteFS: HasteFS,
    +initialModuleMap: ModuleMap,
  |}) {
    super();
    this._config = config;
    this._filesByDirNameIndex = new FilesByDirNameIndex(
      initialHasteFS.getAllFiles(),
    );
    this._assetResolutionCache = new AssetResolutionCache({
      assetExtensions: new Set(config.resolver.assetExts),
      getDirFiles: dirPath => this._filesByDirNameIndex.getAllFiles(dirPath),
      platforms: new Set(config.resolver.platforms),
    });
    this._haste = haste;
    this._hasteFS = initialHasteFS;
    this._moduleMap = initialModuleMap;
    this._helpers = new DependencyGraphHelpers({
      assetExts: config.resolver.assetExts,
      providesModuleNodeModules: config.resolver.providesModuleNodeModules,
    });
    this._haste.on('change', this._onHasteChange.bind(this));
    this._moduleCache = this._createModuleCache();
    this._createModuleResolver();
  }

  static _createHaste(config: ConfigT): JestHasteMap {
    return new JestHasteMap({
      computeDependencies: false,
      computeSha1: true,
      extensions: config.resolver.sourceExts.concat(config.resolver.assetExts),
      forceNodeFilesystemAPI: !config.resolver.useWatchman,
      hasteImplModulePath: config.resolver.hasteImplModulePath,
      ignorePattern: config.resolver.blacklistRE || / ^/,
      maxWorkers: config.maxWorkers,
      mocksPattern: '',
      name: 'metro-' + JEST_HASTE_MAP_CACHE_BREAKER,
      platforms: config.resolver.platforms,
      providesModuleNodeModules: config.resolver.providesModuleNodeModules,
      retainAllFiles: true,
      resetCache: config.resetCache,
      roots: config.watchFolders,
      throwOnModuleCollision: true,
      useWatchman: config.resolver.useWatchman,
      watch: true,
    });
  }

  static async load(config: ConfigT): Promise<DependencyGraph> {
    const initializingMetroLogEntry = log(
      createActionStartEntry('Initializing Metro'),
    );

    config.reporter.update({type: 'dep_graph_loading'});
    const haste = DependencyGraph._createHaste(config);
    const {hasteFS, moduleMap} = await haste.build();

    log(createActionEndEntry(initializingMetroLogEntry));
    config.reporter.update({type: 'dep_graph_loaded'});

    return new DependencyGraph({
      haste,
      initialHasteFS: hasteFS,
      initialModuleMap: moduleMap,
      config,
    });
  }

  _getClosestPackage(filePath: string): ?string {
    const parsedPath = path.parse(filePath);
    const root = parsedPath.root;
    let dir = parsedPath.dir;
    do {
      const candidate = path.join(dir, 'package.json');
      if (this._hasteFS.exists(candidate)) {
        return candidate;
      }
      dir = path.dirname(dir);
    } while (dir !== '.' && dir !== root);
    return null;
  }

  _onHasteChange({eventsQueue, hasteFS, moduleMap}) {
    this._hasteFS = hasteFS;
    this._filesByDirNameIndex = new FilesByDirNameIndex(hasteFS.getAllFiles());
    this._assetResolutionCache.clear();
    this._moduleMap = moduleMap;
    eventsQueue.forEach(({type, filePath}) =>
      this._moduleCache.processFileChange(type, filePath),
    );
    this._createModuleResolver();
    this.emit('change');
  }

  _createModuleResolver() {
    this._moduleResolver = new ModuleResolver({
      dirExists: filePath => {
        try {
          return fs.lstatSync(filePath).isDirectory();
        } catch (e) {}
        return false;
      },
      doesFileExist: this._doesFileExist,
      extraNodeModules: this._config.resolver.extraNodeModules,
      isAssetFile: filePath => this._helpers.isAssetFile(filePath),
      mainFields: this._config.resolver.resolverMainFields,
      moduleCache: this._moduleCache,
      moduleMap: this._moduleMap,
      preferNativePlatform: true,
      resolveAsset: (dirPath, assetName, platform) =>
        this._assetResolutionCache.resolve(dirPath, assetName, platform),
      resolveRequest: this._config.resolver.resolveRequest,
      sourceExts: this._config.resolver.sourceExts,
    });
  }

  _createModuleCache() {
    return new ModuleCache({
      getClosestPackage: this._getClosestPackage.bind(this),
    });
  }

  getSha1(filename: string): string {
    // TODO Calling realpath allows us to get a hash for a given path even when
    // it's a symlink to a file, which prevents Metro from crashing in such a
    // case. However, it doesn't allow Metro to track changes to the target file
    // of the symlink. We should fix this by implementing a symlink map into
    // Metro (or maybe by implementing those "extra transformation sources" we've
    // been talking about for stuff like CSS or WASM).
    const resolvedPath = fs.realpathSync(filename);
    const sha1 = this._hasteFS.getSha1(resolvedPath);

    if (!sha1) {
      const content = fs.readFileSync(resolvedPath, 'utf8');
      const otherSha1 = crypto.createHash('sha1')
        .update(content)
        .digest('hex');
      return otherSha1;
      throw new ReferenceError(`SHA-1 for file ${filename} is not computed`);
    }

    return sha1;
  }

  getWatcher() {
    return this._haste;
  }

  end() {
    this._haste.end();
  }

  resolveDependency(from: string, to: string, platform: ?string): string {
    const req = new ResolutionRequest({
      moduleResolver: this._moduleResolver,
      entryPath: from,
      helpers: this._helpers,
      platform: platform || null,
      moduleCache: this._moduleCache,
    });

    return req.resolveDependency(this._moduleCache.getModule(from), to).path;
  }

  _doesFileExist = (filePath: string): boolean => {
    return this._hasteFS.exists(filePath);
  };

  getHasteName(filePath: string): string {
    const hasteName = this._hasteFS.getModuleName(filePath);

    if (hasteName) {
      return hasteName;
    }

    return path.relative(this._config.projectRoot, filePath);
  }
}

module.exports = DependencyGraph;
