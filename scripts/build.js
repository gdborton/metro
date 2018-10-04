/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 * Note: cannot use prettier here because this file is ran as-is
 */

/**
 * script to build (transpile) files.
 * By default it transpiles all files for all packages and writes them
 * into `build/` directory.
 * Non-js or files matching IGNORE_PATTERN will be copied without transpiling.
 *
 * Example:
 *  node ./scripts/build.js
 *  node ./scripts/build.js /user/c/metro/packages/metro-abc/src/abc.js
 */

'use strict';

const babel = require('babel-core');
const chalk = require('chalk');
const buildUtils = require('./build-utils');

const files = process.argv.slice(2);

if (files.length) {
  files.forEach(buildUtils.buildFile);
} else {
  // $FlowFixMe TODO t25179342 Add version to the flow types for this module
  process.stdout.write(chalk.bold.inverse('Building packages') + ' (using Babel v' + babel.version + ')\n');
  buildUtils.getPackages().forEach(buildUtils.buildPackage);
  process.stdout.write('\n');
}
