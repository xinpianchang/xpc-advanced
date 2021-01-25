module.exports = {
  presets: [
    [
      '@babel/preset-env',
      {
        targets: { esmodules: true },
        bugfixes: true,
        loose: true,
        modules: process.env.ESM ? false : 'cjs',
      },
    ],
    '@babel/preset-typescript',
  ],
  plugins: [
    '@babel/plugin-proposal-class-properties',
    ['@babel/plugin-transform-typescript', { allowNamespaces: true }],
  ],
  ignore: ['**/*.d.ts', 'node_modules'],
}
