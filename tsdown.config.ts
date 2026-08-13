/**
 * Dual-half build: Node (esm) + official client bundle (cjs wrapped in the
 * `window.__ModuleLoader__` factory contract, everything host-provided kept
 * external).
 */
export default [
  {
    entry: { index: 'src/index.ts' },
    format: 'esm',
    platform: 'node',
    target: 'es2023',
    outDir: 'lib',
    dts: false,
    clean: true,
    external: [/^@deepseek-ai\//],
    outputOptions: {
      entryFileNames: 'index.mjs',
    },
  },
  {
    name: '@xietwim/dsh-kernel-cockpit/client',
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: true,
    clean: false,
    // Only loader-module-table entries may stay external (a require the table
    // cannot answer throws at boot); the list mirrors the shell's
    // PLATFORM_MODULES plus the documented runtime exemption.
    external: [
      'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-web-react',
      '@deepseek-ai/dsh-client-ui-primitives',
      '@deepseek-ai/dsh-client-runtime/client',
    ],
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      'import.meta.env.MODE': JSON.stringify('production'),
      'import.meta.env': JSON.stringify({ MODE: 'production' }),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "@xietwim/dsh-kernel-cockpit", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
]
