// Metro for a monorepo: the app imports @bibbly/core and @bibbly/connectors from
// packages/ (built to each package's dist), and packages shared with the
// desktop app may be hoisted to the repository's node_modules.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, '../..');
const config = getDefaultConfig(projectRoot);

config.watchFolders = [path.join(repoRoot, 'packages/core'), path.join(repoRoot, 'packages/connectors')];
config.resolver.nodeModulesPaths = [path.join(projectRoot, 'node_modules'), path.join(repoRoot, 'node_modules')];
// One copy of React and React Native: always the app's own.
config.resolver.extraNodeModules = {
  react: path.join(projectRoot, 'node_modules/react'),
  'react-native': path.join(projectRoot, 'node_modules/react-native'),
};

// The browser preview (npx expo start --web) has no Bluetooth: stub it there only.
const resolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web' && moduleName === 'react-native-ble-plx') {
    return { type: 'sourceFile', filePath: path.join(projectRoot, 'web-stubs/react-native-ble-plx.ts') };
  }
  return (resolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
