/**
 * Copyright (c) 2013-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+javascript_foundation
 * @format
 */

'use strict';

const Metro = require('../../..');

const fs = require('fs');
const sourceMap = require('source-map');
const vm = require('vm');

jest.unmock('cosmiconfig');

jasmine.DEFAULT_TIMEOUT_INTERVAL = 30 * 1000;

const ERROR_STR = "new Error('SOURCEMAP:";

it('creates correct sourcemaps in dev mode', async () => {
  const config = await Metro.loadConfig({
    config: require.resolve('../metro.config.js'),
  });
  const {code, map} = await Metro.runBuild(config, {
    entry: 'ErrorBundle.js',
  });

  const {line, column, source} = symbolicate(getErrorFromCode(code), map);

  expect(
    substrFromFile(source, line, column).startsWith(ERROR_STR),
  ).toBeTruthy();
});

it('creates correct sourcemaps in prod mode', async () => {
  const config = await Metro.loadConfig({
    config: require.resolve('../metro.config.js'),
  });
  const {code, map} = await Metro.runBuild(config, {
    entry: 'ErrorBundle.js',
    dev: false,
    minify: true,
  });

  const {line, column, source} = symbolicate(getErrorFromCode(code), map);

  expect(
    substrFromFile(source, line, column).startsWith(ERROR_STR),
  ).toBeTruthy();
});

function getErrorFromCode(code) {
  // Create a vm context to execute the bundle and get back the Error object.
  const sandbox = {};
  vm.createContext(sandbox);
  const error = vm.runInContext(code, sandbox);

  // Override the Error stacktrace serializer to be able to get the raw stack.
  const oldStackTrace = Error.prepareStackTrace;
  Error.prepareStackTrace = (err, structuredStackTrace) => structuredStackTrace;

  try {
    return {
      line: error.stack[0].getLineNumber(),
      // Column numbers coming from v8 are 1-based
      // https://chromium.googlesource.com/v8/v8.git/+/master/src/inspector/js_protocol.json#69
      // But mozilla sourcemap library expects 0-based columns
      // https://github.com/mozilla/source-map#sourcemapconsumerprototypeoriginalpositionforgeneratedposition
      column: error.stack[0].getColumnNumber() - 1,
    };
  } finally {
    Error.prepareStackTrace = oldStackTrace;
  }
}

function symbolicate({line, column}, map) {
  const consumer = new sourceMap.SourceMapConsumer(map);
  const originalTrace = consumer.originalPositionFor({
    line,
    column,
  });

  // Check that unsymbolicating the error back gives us the initial column/line.
  expect(consumer.generatedPositionFor(originalTrace)).toEqual(
    expect.objectContaining({
      column,
      line,
    }),
  );

  return originalTrace;
}

function substrFromFile(filePath, line, column) {
  return fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    [line - 1].substr(column);
}
