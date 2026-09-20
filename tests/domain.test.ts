/**
 * Domain resolution regressions.
 *
 * A domain is what lets a lesson travel between projects, so resolving one from
 * the wrong source would spread a single project's quirk everywhere. Every
 * source is therefore explicit, ordered, and silent when absent.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, eq } from './assert.ts'
import { domainFromPackageName, inferDomain, normalizeDomain, resolveWorkspace, workspaceId } from '../src/domain.ts'

export function run(): void {
  // ── Normalisation ────────────────────────────────────────────────────────
  eq(normalizeDomain('  Python//Testing/ '), 'python/testing', 'case, spacing and empty segments are normalised')
  eq(normalizeDomain('a\\b'), 'a/b', 'backslashes are separators too')
  eq(normalizeDomain('/'), '', 'a separator-only domain is empty')
  eq(domainFromPackageName('@scope/pkg'), 'scope/pkg', 'a scoped package name loses its @')
  eq(domainFromPackageName('plain'), 'plain', 'a plain package name is already a domain')

  // ── Workspace identity ───────────────────────────────────────────────────
  const id = workspaceId('F:\\Some\\Path')
  eq(id.length, 16, 'the workspace id is 16 hex characters')
  eq(workspaceId('F:\\Some\\Path'), workspaceId('f:\\some\\path'),
    'Windows path casing does not change identity')
  assert(workspaceId('F:\\a') !== workspaceId('F:\\b'), 'different roots are different workspaces')

  const dir = mkdtempSync(join(tmpdir(), 'expmem-dom-'))
  try {
    // ── No manifest, no remote: no domain, and nothing throws ───────────────
    eq(inferDomain(dir), '', 'a bare directory has no domain rather than a folder-name domain')

    // ── package.json name ───────────────────────────────────────────────────
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@acme/toolkit' }))
    eq(inferDomain(dir), 'acme/toolkit', 'a package name becomes the domain')

    // ── .dsh/memory.yml wins over package.json ──────────────────────────────
    mkdirSync(join(dir, '.dsh'), { recursive: true })
    writeFileSync(join(dir, '.dsh', 'memory.yml'), '# a comment\ndomain: Data/ETL\n')
    eq(inferDomain(dir), 'data/etl', 'a local config outranks the package name')

    // ── An explicit configuration outranks everything ───────────────────────
    eq(inferDomain(dir, 'pinned/domain'), 'pinned/domain', 'an explicit domain wins')

    // ── A malformed file is no file ─────────────────────────────────────────
    writeFileSync(join(dir, 'package.json'), '{ not json')
    rmSync(join(dir, '.dsh'), { recursive: true, force: true })
    eq(inferDomain(dir), '', 'a malformed manifest yields no domain and does not throw')

    // ── git remote, when there is no manifest ───────────────────────────────
    writeFileSync(join(dir, 'package.json'), JSON.stringify({}))
    mkdirSync(join(dir, '.git'), { recursive: true })
    writeFileSync(join(dir, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:someone/cool-project.git\n')
    eq(inferDomain(dir), 'cool-project', 'a git remote name is the last resort')

    // ── resolveWorkspace ties it together ───────────────────────────────────
    const resolved = resolveWorkspace(dir)
    eq(resolved.domain, 'cool-project', 'resolveWorkspace infers the domain')
    eq(resolved.id, workspaceId(dir), 'resolveWorkspace derives the id from the root')
    eq(resolveWorkspace(undefined, 'x/y').domain, 'x/y', 'the configured domain is honoured without a cwd')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  console.log('  domain     ok')
}
