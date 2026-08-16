/**
 * Dual-half build: Node (esm) + official client bundle (cjs wrapped in the
 * `window.__ModuleLoader__` factory contract, everything host-provided kept
 * external).
 */
export default [
  {
    // Three Node entries, one build: the profile-plane half plus the two
    // agent-plane tool rows the kernel-opt preset mounts. Shared modules
    // (projection, wire, runtime) land in a chunk both halves import, so the
    // service class stays one identity across them.
    entry: {
      index: 'src/index.ts',
      agent: 'src/agent.ts',
      'self-compact': 'src/self-compact.ts',
    },
    format: 'esm',
    platform: 'node',
    target: 'es2023',
    outDir: 'lib',
    dts: false,
    clean: true,
    external: [/^@deepseek-ai\//],
    outputOptions: {
      entryFileNames: '[name].mjs',
      chunkFileNames: 'chunk-[name]-[hash].mjs',
    },
  },
  {
    name: '@xietwim/dsh-kernel-opt/client',
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
      banner: 'window.__ModuleLoader__.load({ id: "@xietwim/dsh-kernel-opt", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
]
