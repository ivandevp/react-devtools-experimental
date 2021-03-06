const { readFileSync } = require('fs');
const { resolve } = require('path');
const { DefinePlugin } = require('webpack');
const { getGitHubURL, getVersionString } = require('../../utils');

const __DEV__ = process.env.NODE_ENV !== 'production';

const GITHUB_URL = getGitHubURL();
const DEVTOOLS_VERSION = getVersionString();

module.exports = {
  mode: __DEV__ ? 'development' : 'production',
  devtool: __DEV__ ? 'cheap-module-eval-source-map' : false,
  entry: {
    backend: './src/backend.js',
  },
  output: {
    path: __dirname + '/build',
    filename: '[name].js',
  },
  resolve: {
    alias: {
      src: resolve(__dirname, '../../../src'),
    },
  },
  plugins: [
    new DefinePlugin({
      __DEV__: true,
      'process.env.DEVTOOLS_VERSION': `"${DEVTOOLS_VERSION}"`,
      'process.env.GITHUB_URL': `"${GITHUB_URL}"`,
    }),
  ],
  module: {
    rules: [
      {
        test: /\.js$/,
        loader: 'babel-loader',
        options: JSON.parse(
          readFileSync(resolve(__dirname, '../../../.babelrc'))
        ),
      },
    ],
  },
};
