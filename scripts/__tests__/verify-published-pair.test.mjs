import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseOptions, validateCopies } from '../verify-published-pair.mjs'

test('requires exact versions and explicit manager',()=>{
  assert.deepEqual(parseOptions(['--core','0.2.0-rc.5','--ui','0.1.0-beta.35','--manager','npm']),{
    core:'0.2.0-rc.5',ui:'0.1.0-beta.35',manager:'npm',
  })
  assert.throws(()=>parseOptions(['--core','latest','--ui','beta','--manager','npm']),/exact SemVer/)
  assert.throws(()=>parseOptions(['--core','0.2.0-rc.5','--ui','0.1.0-beta.35','--manager','yarn']),/Manager/)
})
test('requires a full resolved Core package set',()=>{
  assert.match(validateCopies([], '0.2.0-rc.5').join('\n'), /was not resolved/)
})
test('identifies a mixed-version and duplicate-realpath graph',()=>{
  const names=['@zeus-js/zeus','@zeus-js/signal','@zeus-js/runtime-dom']
  const copies=names.map(name=>({name,version:'0.2.0-rc.5',realpath:'/root/'+name}))
  copies.push({name:'@zeus-js/signal',version:'0.1.1-beta.20',realpath:'/nested/signal'})
  const failures=validateCopies(copies,'0.2.0-rc.5').join('\n')
  assert.match(failures,/unexpected versions/)
  assert.match(failures,/multiple physical modules/)
})
test('accepts a single-version single-realpath graph',()=>{
  const copies=['@zeus-js/zeus','@zeus-js/signal','@zeus-js/runtime-dom']
    .map(name=>({name,version:'0.2.0-rc.5',realpath:'/root/'+name}))
  assert.deepEqual(validateCopies(copies,'0.2.0-rc.5'),[])
})
