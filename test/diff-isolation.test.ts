import * as childProcess from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { diffWorkspaces } from '../src/diff.js';
import { GraphStore } from '../src/db.js';
import * as indexer from '../src/indexer.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {...actual, mkdtempSync:vi.fn(actual.mkdtempSync)};
});
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {...actual, execFileSync:vi.fn(actual.execFileSync)};
});
const actualChildProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
vi.mocked(childProcess.execFileSync).mockImplementation(actualChildProcess.execFileSync);
const dirs:string[]=[];
afterEach(()=>{vi.restoreAllMocks();vi.mocked(childProcess.execFileSync).mockReset().mockImplementation(actualChildProcess.execFileSync);for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
function repo():string {
  const dir=mkdtempSync(join(tmpdir(),'diff-isolation-test-'));dirs.push(dir);
  const git=(...args:string[])=>execFileSync('git',['-C',dir,...args],{stdio:'pipe'});
  git('init','-q');git('config','user.email','test@example.com');git('config','user.name','Test');
  writeFileSync(join(dir,'base.ts'),'export const baseOnly = 1;');
  git('add','.');git('commit','-qm','base');git('branch','collision/a');
  rmSync(join(dir,'base.ts'));writeFileSync(join(dir,'head.ts'),'export const headOnly = 2;');
  git('add','-A');git('commit','-qm','head');git('branch','collision_a');return dir;
}
const scratchDirs=()=>vi.mocked(mkdtempSync).mock.results
  .filter(r=>r.type==='return' && String(r.value).includes('/sqlite-graph-diff-'))
  .map(r=>String(r.value)).filter(existsSync).sort();
describe('git snapshot isolation',()=>{
  it('preserves forward, reverse and same-ref graphs with independent cleaned roots',async()=>{
    const dir=repo();
    const forward=await diffWorkspaces(dir,'collision/a','collision_a',{engine:'heuristic'});
    expect(forward.base.root).not.toBe(forward.head.root);
    expect(forward.addedNodes.map(n=>n.key)).toContain('file:head.ts');
    expect(forward.removedNodes.map(n=>n.key)).toContain('file:base.ts');
    const reverse=await diffWorkspaces(dir,'collision_a','collision/a',{engine:'heuristic'});
    expect(reverse.addedNodes.map(n=>n.key)).toContain('file:base.ts');
    expect(reverse.removedNodes.map(n=>n.key)).toContain('file:head.ts');
    const same=await diffWorkspaces(dir,'collision/a','collision/a',{engine:'heuristic'});
    expect(same.base.root).not.toBe(same.head.root);
    expect(same.counts.addedNodes+same.counts.removedNodes).toBe(0);
    for(const result of [forward,reverse,same])for(const side of [result.base,result.head])expect(existsSync(dirname(side.root))).toBe(false);
  });
  it('cleans scratch when either ref cannot be resolved',async()=>{
    const dir=repo(),before=scratchDirs();
    await expect(diffWorkspaces(dir,'missing-ref','collision_a')).rejects.toThrow();
    await expect(diffWorkspaces(dir,'collision/a','missing-ref')).rejects.toThrow();
    expect(scratchDirs()).toEqual(before);
  });
  it('closes an already opened store and cleans scratch on head indexing failure',async()=>{
    const dir=repo(),before=scratchDirs();
    const original=indexer.indexWorkspace;
    const close=vi.spyOn(GraphStore.prototype,'close');
    vi.spyOn(indexer,'indexWorkspace').mockImplementationOnce(original).mockRejectedValueOnce(new Error('head indexing failed'));
    await expect(diffWorkspaces(dir,'collision/a','collision_a',{engine:'heuristic'})).rejects.toThrow('head indexing failed');
    // One close belongs to base indexing, another to the comparison's base store.
    expect(close).toHaveBeenCalledTimes(2);
    expect(scratchDirs()).toEqual(before);
  });
  it('cleans snapshots and tar files when extraction fails',async()=>{
    const dir=repo(),before=scratchDirs();
    const original=(await vi.importActual<typeof import('node:child_process')>('node:child_process')).execFileSync;
    vi.spyOn(childProcess,'execFileSync').mockImplementation(((file:string,...args:unknown[])=>{
      if(file==='tar')throw new Error('tar extraction failed');
      return (original as Function)(file,...args);
    }) as typeof original);
    await expect(diffWorkspaces(dir,'collision/a','collision_a')).rejects.toThrow('tar extraction failed');
    expect(scratchDirs()).toEqual(before);
  });
  it('still closes the other store and removes scratch if a comparison close throws',async()=>{
    const dir=repo(),before=scratchDirs();
    const original=GraphStore.prototype.close;
    let count=0;
    const close=vi.spyOn(GraphStore.prototype,'close').mockImplementation(function(this:GraphStore){
      original.call(this);count++;
      if(count===3)throw new Error('comparison close failed');
    });
    await expect(diffWorkspaces(dir,'collision/a','collision_a',{engine:'heuristic'})).rejects.toThrow('comparison close failed');
    expect(close).toHaveBeenCalledTimes(4);
    expect(scratchDirs()).toEqual(before);
  });
  it('cleans scratch on base indexing failure',async()=>{
    const dir=repo(),before=scratchDirs();
    vi.spyOn(indexer,'indexWorkspace').mockRejectedValueOnce(new Error('base indexing failed'));
    await expect(diffWorkspaces(dir,'collision/a','collision_a')).rejects.toThrow('base indexing failed');
    expect(scratchDirs()).toEqual(before);
  });
});
