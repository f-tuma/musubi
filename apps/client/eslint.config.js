// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['**/dist/**', '**/.expo/**'],
  },
  {
    rules: {
      // React Compiler skips components that trigger these diagnostics. Keep
      // the existing debt visible without making the whole lint gate unusable;
      // the warning budget prevents it from growing.
      'react-hooks/immutability': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
]);
