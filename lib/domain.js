/**
 * Workspace and domain resolution.
 *
 * A *workspace* is one checkout; its identity is the resolved root path, so the
 * same repository cloned twice is two workspaces. A *domain* is a subject area
 * — `python/testing`, `investment-research` — that a lesson can graduate into
 * once it has been confirmed in more than one workspace.
 *
 * Resolution never throws. A directory with no configuration, no manifest and
 * no remote simply has no domain, and its records stay workspace-local; that is
 * the safe default, because inventing a domain from a folder name would leak
 * one project's quirk into every project with a similar name.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

                            
                                                               
            
              
                                          
                
 

/** Stable workspace identity. Lowercased because Windows paths are case-insensitive. */
export function workspaceId(root        )         {
  return createHash('sha256').update(resolve(root).toLowerCase()).digest('hex').slice(0, 16)
}

/** `Python/Testing` and `python//testing/` both become `python/testing`. */
export function normalizeDomain(value        )         {
  return value
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/')
    .split('/')
    .map(segment => segment.trim())
    .filter(segment => segment !== '')
    .join('/')
}

/** `@scope/pkg` becomes `scope/pkg`; a bare name is already a domain. */
export function domainFromPackageName(name        )         {
  return normalizeDomain(name.replace(/^@/, ''))
}

function readConfiguredDomain(root        )         {
  const file = join(root, '.dsh', 'memory.yml')
  try {
    if (!existsSync(file)) return ''
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = /^\s*domain\s*:\s*(.+?)\s*$/.exec(line)
      const value = match?.[1]
      if (value !== undefined && !value.startsWith('#')) return value.replace(/^['"]|['"]$/g, '')
    }
  } catch {
    // An unreadable config file is simply no config; resolution stays quiet.
  }
  return ''
}

function readPackageName(root        )         {
  const file = join(root, 'package.json')
  try {
    if (!existsSync(file)) return ''
    const parsed          = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && 'name' in parsed) {
      const { name } = parsed                      
      return typeof name === 'string' ? name : ''
    }
  } catch {
    // Malformed JSON is no manifest.
  }
  return ''
}

function readGitRemoteName(root        )         {
  const file = join(root, '.git', 'config')
  try {
    if (!existsSync(file)) return ''
    const match = /url\s*=\s*(\S+)/.exec(readFileSync(file, 'utf8'))
    const url = match?.[1]
    if (url === undefined) return ''
    const tail = url.replace(/\.git$/, '').split(/[/:]/).filter(part => part !== '').pop() ?? ''
    return tail
  } catch {
    return ''
  }
}

/**
 * Infer a domain, most explicit source first: a pinned `defaultDomain`, then
 * `.dsh/memory.yml`, then `package.json#name`, then the git remote's repository
 * name. Anything else yields `''`.
 */
export function inferDomain(root        , configured = '')         {
  if (configured !== '') return normalizeDomain(configured)
  const local = readConfiguredDomain(root)
  if (local !== '') return normalizeDomain(local)
  const packageName = readPackageName(root)
  if (packageName !== '') return domainFromPackageName(packageName)
  const remote = readGitRemoteName(root)
  if (remote !== '') return normalizeDomain(remote)
  return ''
}

/** Resolve the workspace a turn is running in. */
export function resolveWorkspace(cwd                    , configuredDomain = '')            {
  const root = resolve(cwd ?? process.cwd())
  return {
    id: workspaceId(root),
    root,
    domain: inferDomain(root, configuredDomain),
  }
}

/** The workspace's display name, used in tool output and diagnostics. */
export function workspaceLabel(root        )         {
  const name = basename(root)
  return name === '' ? root : name
}
