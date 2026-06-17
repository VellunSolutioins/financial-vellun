/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  extends: ['./packages/config/.eslintrc.base.js'],
  env: {
    node: true,
    es2022: true,
  },
  ignorePatterns: ['node_modules/', 'dist/', '.next/', 'apps/', 'packages/shared/'],
};
