/**
 * Keeping the user's copy of the bundled agent preset in step with the plugin.
 *
 * Split out of index.ts because this is the one place the plugin writes into a
 * directory the user also owns: four branches, a manifest, and a backup path.
 * That deserves tests it can actually be given.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** What this plugin last wrote into the user's preset directory. */
const PRESET_MANIFEST = '.dsh-kernel-opt-files.json'

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Every file under `dir`, as paths relative to it. */
async function walkFiles(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...await walkFiles(join(dir, entry.name), rel))
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

/**
 * Seed the bundled preset into the user's preset root, and keep it in step
 * with the plugin on every later update.
 *
 * The old rule was copy-once — existing files were never overwritten, so a
 * user's edits survived. That protected the wrong thing: after any plugin
 * update the on-disk `evaluator/bench.py` stayed at whatever shipped the day
 * it was first installed, while SKILL.md (read live from the package) described
 * the new one. The tool and its own documentation disagreed, silently, and the
 * only way out was a manual copy nobody knows to make.
 *
 * So ownership is tracked instead of assumed. A manifest records the hash of
 * every file this plugin wrote; on each install a file is
 *
 *   - written when absent,
 *   - left alone when it already matches the bundled version,
 *   - UPDATED when its hash is still the one we recorded — nobody has touched
 *     it since we wrote it, so there is nothing to protect,
 *   - KEPT when it differs from both: the user edited it. It stays flagged as
 *     theirs for good (the manifest keeps recording OUR last hash, not
 *     theirs), and the log names it so the divergence is visible.
 *
 * An install that predates the manifest cannot tell an edit from a stale copy.
 * There it backs the file up next to itself and updates, which loses nothing
 * and puts the directory on the clean path above from then on.
 *
 * @returns lines worth putting in the host log (empty when nothing moved).
 */
export async function syncPreset(source: string, target: string): Promise<string[]> {
  const manifestPath = join(target, PRESET_MANIFEST)
  let recorded: Record<string, string> = {}
  let firstSync = true
  try {
    const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
    const files = (parsed as { files?: unknown } | null)?.files
    if (files !== null && typeof files === 'object') {
      recorded = files as Record<string, string>
      firstSync = false
    }
  } catch {
    // No manifest (or an unreadable one): treat as the pre-manifest case.
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const written: Record<string, string> = {}
  const updated: string[] = []
  const kept: string[] = []
  const backedUp: string[] = []

  for (const rel of await walkFiles(source)) {
    const to = join(target, rel)
    const bundled = await readFile(join(source, rel))
    const bundledHash = sha256(bundled)
    let current: Buffer | null = null
    try {
      current = await readFile(to)
    } catch {
      current = null
    }

    if (current === null) {
      await mkdir(dirname(to), { recursive: true })
      await writeFile(to, bundled)
      written[rel] = bundledHash
      continue
    }
    const currentHash = sha256(current)
    if (currentHash === bundledHash) {
      written[rel] = bundledHash
      continue
    }
    const ours = recorded[rel]
    if (ours === currentHash) {
      await writeFile(to, bundled)
      written[rel] = bundledHash
      updated.push(rel)
      continue
    }
    if (firstSync) {
      await rename(to, `${to}.bak-${stamp}`)
      await writeFile(to, bundled)
      written[rel] = bundledHash
      backedUp.push(rel)
      continue
    }
    // Edited by the user: keep recording what WE last wrote, so it stays
    // theirs on every future update rather than being adopted back.
    if (ours !== undefined) written[rel] = ours
    kept.push(rel)
  }

  try {
    await mkdir(target, { recursive: true })
    await writeFile(manifestPath, `${JSON.stringify({ schema: 1, files: written }, null, 2)}\n`)
  } catch {
    // A manifest we cannot write costs the next update its clean path, not
    // this one its correctness.
  }

  const lines: string[] = []
  if (updated.length > 0) lines.push(`preset: updated ${updated.join(', ')} in ${target}`)
  if (backedUp.length > 0) {
    lines.push(`preset: updated ${backedUp.join(', ')} in ${target}; the previous copy of each `
      + `is kept alongside as *.bak-${stamp} (this directory predates update tracking)`)
  }
  if (kept.length > 0) {
    lines.push(`preset: kept your edited ${kept.join(', ')} — the bundled version has changed since. `
      + 'Delete a file to take the new one.')
  }
  return lines
}
