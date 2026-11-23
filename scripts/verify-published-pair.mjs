import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const EXACT = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/
const CORE_PACKAGES = ['@zeus-js/zeus', '@zeus-js/signal', '@zeus-js/runtime-dom']
const UI_PACKAGES = ['@zeus-web/button']

export function parseOptions(args) {
  const values = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]
    const value = args[i + 1]
    if (!['--core','--ui','--manager','--out'].includes(key) || !value) {
      throw new Error('Usage: --core <exact> --ui <exact> --manager npm|pnpm [--out <path>]')
    }
    values[key.slice(2)] = value
  }
  if (!EXACT.test(values.core ?? '') || !EXACT.test(values.ui ?? '')) {
    throw new Error('Core and UI versions must be exact SemVer values, not tags/ranges')
  }
  if (!['npm','pnpm'].includes(values.manager)) {
    throw new Error('Manager must be npm or pnpm')
  }
  return values
}

export function validateCopies(copies, core) {
  const errors = []
  for (const name of ['@zeus-js/zeus', '@zeus-js/signal', '@zeus-js/runtime-dom']) {
    const selected = copies.filter(item => item.name === name)
    if (!selected.length) errors.push(name + ' was not resolved')
    const versions = [...new Set(selected.map(item => item.version))]
    if (versions.some(version => version !== core)) {
      errors.push(name + ' has unexpected versions: ' + versions.join(', '))
    }
    const realpaths = [...new Set(selected.map(item => item.realpath))]
    if (realpaths.length > 1) errors.push(name + ' resolves to multiple physical modules')
  }
  return errors
}

function getPackage(root, name) {
  const path = join(root, 'node_modules', ...name.split('/'), 'package.json')
  const pkg = JSON.parse(readFileSync(path, 'utf8'))
  return { name, version:pkg.version, realpath:realpathSync(path) }
}

function getFrom(base, name) {
  try {
    const request = createRequire(base)
    const path = request.resolve(name)
    const parts = path.split(/[\\/]/)
    return {name, realpath:realpathSync(path), resolved:true, from:base}
  } catch (error) {
    return {name, resolved:false, from:base, error:error.code ?? error.message}
  }
}

export function run(options) {
  const evidence = {
    schema:'zeus.ecosystem.published-pair-probe/v1',
    core:options.core, ui:options.ui, manager:options.manager,
    attemptedAt:new Date().toISOString(),
    result:'fail', copies:[], resolution:[], errors:[],
    note:'Only published package install/peer/realpath evidence. Browser E2E is a separate, mandatory acceptance gate.',
  }
  const dir = mkdtempSync(join(tmpdir(), 'zeus-ecosystem-pair-'))
  try {
    const dependencies = Object.fromEntries([
      ...CORE_PACKAGES.map(name=>[name,options.core]),
      ...UI_PACKAGES.map(name=>[name,options.ui]),
    ])
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name:'zeus-pair-installed-consumer', private:true,version:'0.0.0', dependencies,
    }, null, 2)+'\n')
    const args = options.manager === 'npm'
      ? ['install','--strict-peer-deps','--ignore-scripts','--no-audit','--no-fund']
      : ['install','--strict-peer-dependencies','--ignore-scripts']
    const child = spawnSync(options.manager, args, {
      cwd:dir, encoding:'utf8', timeout:180000,
      env:{...process.env, npm_config_registry:'https://registry.npmjs.org/'},
    })
    evidence.install = {
      exitCode:child.status,
      error:child.error?.message ?? null,
      // Keep only the tail; npm/pnpm output sometimes contains full paths.
      output:(String(child.stdout ?? '')+'\n'+String(child.stderr ?? '')).slice(-3500),
    }
    if (child.status !== 0) {
      evidence.errors.push(options.manager + ' strict peer install failed')
    } else {
      for (const name of [...CORE_PACKAGES, ...UI_PACKAGES]) {
        evidence.copies.push(getPackage(dir,name))
      }
      for (const baseName of ['@zeus-js/zeus','@zeus-web/button']) {
        const base = join(dir,'node_modules', ...baseName.split('/'), 'package.json')
        for (const name of CORE_PACKAGES) {
          const item=getFrom(base,name)
          const version=evidence.copies.find(copy=>copy.name===name)?.version
          evidence.resolution.push({...item,version})
        }
      }
      evidence.errors.push(...validateCopies(evidence.copies,options.core))
      const basePaths = evidence.resolution.filter(item=>item.resolved)
      for (const name of CORE_PACKAGES) {
        const resolved=[...new Set(basePaths.filter(item=>item.name===name).map(item=>item.realpath))]
        if (resolved.length>1) evidence.errors.push(name+' resolves to multiple runtime modules across Core/UI imports')
      }
      const lockfile=join(dir,options.manager==='npm'?'package-lock.json':'pnpm-lock.yaml')
      if (!existsSync(lockfile)) evidence.errors.push('Missing generated lockfile')
      else evidence.lockfileSha256=createHash('sha256').update(readFileSync(lockfile)).digest('hex')
      evidence.result=evidence.errors.length===0?'pass':'fail'
    }
  } catch(error) {
    evidence.errors.push(error.message)
  } finally {
    rmSync(dir,{recursive:true,force:true})
    if(options.out)writeFileSync(resolve(options.out),JSON.stringify(evidence,null,2)+'\n')
  }
  return evidence
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const result=run(parseOptions(process.argv.slice(2)))
    console.log(JSON.stringify({core:result.core,ui:result.ui,manager:result.manager,result:result.result,errors:result.errors,lockfileSha256:result.lockfileSha256??null},null,2))
    if(result.result!=='pass')process.exitCode=1
  }catch(error){console.error(error.message);process.exitCode=2}
}
