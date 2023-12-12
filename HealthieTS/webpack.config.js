const path = require('path');
const fs = require('fs');
const webpack = require('webpack');
const header = fs.readFileSync(path.resolve(__dirname, 'headers/header.js'), 'utf8');
const headerStaging = fs.readFileSync(path.resolve(__dirname, 'headers/headerStaging.js'), 'utf8');
module.exports = [
  {
    mode: 'development',
    entry: './index.ts',
    output: {
      path: path.resolve(__dirname, '../'),
      filename: 'careplan.js'
    },
    plugins: [
      new webpack.BannerPlugin({
        banner: header,
        raw: true,
        entryOnly: true
      }),
    ],
    module: {
      rules: [{ test: /\.tsx?$/, use: 'ts-loader', exclude: /node_modules/ }],
    },
    resolve: { extensions: ['.tsx', '.ts', '.js'] },
  },
  {
    mode: 'development',
    entry: './index.ts',
    output: {
      path: path.resolve(__dirname, '../'),
      filename: 'careplanstaging.js'
    },
    plugins: [
      new webpack.BannerPlugin({
        banner: headerStaging,
        raw: true,
        entryOnly: true
      }),
    ],
    module: {
      rules: [{ test: /\.tsx?$/, use: 'ts-loader', exclude: /node_modules/ }],
    },
    resolve: { extensions: ['.tsx', '.ts', '.js'] },
  }
];




