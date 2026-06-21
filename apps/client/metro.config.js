const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(projectRoot);

// Allow Metro to watch and serve files from the entire monorepo root.
// Without this, asset paths that traverse into the pnpm virtual store
// (../../node_modules/.pnpm/...) are blocked because they fall outside
// Metro's default project root.
config.watchFolders = [monorepoRoot];

// Tell the resolver where to look for node_modules in a pnpm monorepo.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

const defaultResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web' && moduleName === 'react-native-infinite-pager') {
    return {
      filePath: require.resolve('react-native-infinite-pager/lib/module/index.js'),
      type: 'sourceFile',
    };
  }
  if (defaultResolveRequest) return defaultResolveRequest(context, moduleName, platform);
  return context.resolveRequest(context, moduleName, platform);
};

config.resolver.sourceExts.push('sql');

module.exports = config;

