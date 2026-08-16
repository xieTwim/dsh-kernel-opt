/**
 * Preset-sync tests. This is the one place the plugin writes into a directory
 * the user also owns, so every branch is exercised against a real temp tree:
 * seed, no-op, update-what-nobody-touched, keep-what-they-edited, and the
 * backup path a pre-manifest directory takes.
 */
import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { syncPreset } from '../src/preset.ts'

/** A bundled-preset tree and an empty user root. */
async function fixture(): Promise<{ source: string; target: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'kopt-preset-'))
  const source = join(root, 'bundled')
  const target = join(root, 'user', 'kernel-opt')
  await mkdir(join(source, 'evaluator'), { recursive: true })
  await writeFile(join(source, 'agent.cordis.yml'), 'persona: v1\n')
  await writeFile(join(source, 'evaluator', 'bench.py'), '# bench v1\n')
  return { source, target, cleanup: () => rm(root, { recursive: true, force: true }) }
}

const read = (path: string): Promise<string> => readFile(path, 'utf8')

test('a fresh directory is seeded, and a second sync changes nothing', async () => {
  const { source, target, cleanup } = await fixture()
  try {
    const first = await syncPreset(source, target)
    assert.equal(await read(join(target, 'agent.cordis.yml')), 'persona: v1\n')
    assert.equal(await read(join(target, 'evaluator', 'bench.py')), '# bench v1\n')
    // Seeding is not news — the log stays quiet unless something moved.
    assert.deepEqual(first, [])
    assert.deepEqual(await syncPreset(source, target), [])
  } finally {
    await cleanup()
  }
})

test('a file nobody touched follows the plugin', async () => {
  const { source, target, cleanup } = await fixture()
  try {
    await syncPreset(source, target)
    // The plugin ships a new evaluator.
    await writeFile(join(source, 'evaluator', 'bench.py'), '# bench v2 — frozen baseline\n')
    const lines = await syncPreset(source, target)
    assert.equal(await read(join(target, 'evaluator', 'bench.py')), '# bench v2 — frozen baseline\n',
      'this is the whole point: an update must reach the disk')
    assert.equal(lines.length, 1)
    assert.match(lines[0] ?? '', /updated evaluator\/bench\.py/)
    // And it stays updated without saying so twice.
    assert.deepEqual(await syncPreset(source, target), [])
  } finally {
    await cleanup()
  }
})

test('a file the user edited is kept, named, and stays theirs', async () => {
  const { source, target, cleanup } = await fixture()
  try {
    await syncPreset(source, target)
    await writeFile(join(target, 'agent.cordis.yml'), 'persona: MY OWN\n')
    await writeFile(join(source, 'agent.cordis.yml'), 'persona: v2\n')

    const lines = await syncPreset(source, target)
    assert.equal(await read(join(target, 'agent.cordis.yml')), 'persona: MY OWN\n')
    assert.match(lines[0] ?? '', /kept your edited agent\.cordis\.yml/)

    // Still theirs on the next update, and the one after: the manifest keeps
    // recording what the PLUGIN wrote, never what it found.
    await writeFile(join(source, 'agent.cordis.yml'), 'persona: v3\n')
    await syncPreset(source, target)
    assert.equal(await read(join(target, 'agent.cordis.yml')), 'persona: MY OWN\n')
    await syncPreset(source, target)
    assert.equal(await read(join(target, 'agent.cordis.yml')), 'persona: MY OWN\n')

    // Deleting it takes the new one, as the log says.
    await rm(join(target, 'agent.cordis.yml'))
    await syncPreset(source, target)
    assert.equal(await read(join(target, 'agent.cordis.yml')), 'persona: v3\n')
  } finally {
    await cleanup()
  }
})

test('a directory that predates the manifest is backed up, not frozen', async () => {
  const { source, target, cleanup } = await fixture()
  try {
    // What every install made by the copy-once version looks like: files on
    // disk, no manifest, and no way to tell a stale copy from an edited one.
    await mkdir(join(target, 'evaluator'), { recursive: true })
    await writeFile(join(target, 'agent.cordis.yml'), 'persona: v1\n')
    await writeFile(join(target, 'evaluator', 'bench.py'), '# bench OLD\n')

    const lines = await syncPreset(source, target)
    assert.equal(await read(join(target, 'evaluator', 'bench.py')), '# bench v1\n',
      'the stale copy must not survive an update')
    const backups = (await readdir(join(target, 'evaluator'))).filter(f => f.includes('.bak-'))
    assert.equal(backups.length, 1, 'and the old one must still be readable')
    assert.equal(await read(join(target, 'evaluator', backups[0] ?? '')), '# bench OLD\n')
    assert.match(lines[0] ?? '', /predates update tracking/)
    // An identical file needs no backup, so the one that already matched is untouched.
    assert.ok(!(await readdir(target)).some(f => f.startsWith('agent.cordis.yml.bak')))

    // From here the clean rules apply: this directory is now tracked.
    await writeFile(join(target, 'evaluator', 'bench.py'), '# bench MINE\n')
    await writeFile(join(source, 'evaluator', 'bench.py'), '# bench v2\n')
    await syncPreset(source, target)
    assert.equal(await read(join(target, 'evaluator', 'bench.py')), '# bench MINE\n')
  } finally {
    await cleanup()
  }
})

test('a bundled file added later still tops up', async () => {
  const { source, target, cleanup } = await fixture()
  try {
    await syncPreset(source, target)
    await writeFile(join(source, 'evaluator', 'GUIDE.md'), '# how to assemble\n')
    await syncPreset(source, target)
    assert.equal(await read(join(target, 'evaluator', 'GUIDE.md')), '# how to assemble\n')
  } finally {
    await cleanup()
  }
})

// ── where the model-facing tools are allowed to live ────────────────────────
// The four tools are levers of ONE mode. Registering them from the plugin's
// profile-level `apply` is what put their descriptions in the tool catalog of
// every session in the deployment, kernel-opt or not — the cost this split
// removed. These two tests pin the split itself, since nothing else fails when
// a tool drifts back: the mode keeps working and only unrelated sessions pay.

test('the profile-level half registers no model-facing tool', async () => {
  const source = await read(new URL('../src/index.ts', import.meta.url).pathname)
  const registrations = source.match(/\.tools\.register\(/g) ?? []
  assert.equal(registrations.length, 0,
    'a tool registered here reaches every session in the deployment; '
    + 'register it from src/agent.ts (or src/self-compact.ts) instead')
})

test('the preset carries the tool rows, and self_compact sits in the compaction group', async () => {
  const composition = await read(new URL('../preset/kernel-opt/agent.cordis.yml', import.meta.url).pathname)
  assert.match(composition, /name: '@xietwim\/dsh-kernel-opt\/agent'/,
    'the kernel_plan / kernel_env / kernel_finalize row is missing — the mode has no tools')

  // `isolate: { compaction: true }` gives the group its own realm, so a row
  // outside it cannot reach `compaction` and self_compact silently vanishes
  // from the catalog (which is exactly how it was lost before).
  const groupStart = composition.indexOf('- id: compaction')
  const groupEnd = composition.indexOf('\n- id: ', groupStart + 1)
  assert.ok(groupStart >= 0, 'the compaction group is gone')
  const group = composition.slice(groupStart, groupEnd < 0 ? undefined : groupEnd)
  assert.match(group, /name: '@xietwim\/dsh-kernel-opt\/self-compact'/,
    'self_compact must be registered from INSIDE the compaction group or the service is out of reach')
})
