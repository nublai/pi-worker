import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactSubject } from '../artifact.js';

test('evidence binds commit AND native tree; diff bytes are advisory with producing Git version', () => {
  const root=mkdtempSync(join(tmpdir(),'a0s7-artifact-'));
  const git=(...args:string[])=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
  try {
    git('init','-q');git('config','user.name','A0 fixture');git('config','user.email','a0@example.invalid');
    writeFileSync(join(root,'note'),'one\n');git('add','.');git('commit','-qm','one');const base=git('rev-parse','HEAD');
    writeFileSync(join(root,'note'),'two\n');git('commit','-qam','two');
    const first=artifactSubject(root,'HEAD',base);
    assert.equal(first.commit_id,git('rev-parse','HEAD'));
    assert.equal(first.tree_id,git('rev-parse','HEAD^{tree}'));
    assert.notEqual(first.tree_id,first.commit_id);
    assert.equal(first.diff_digest?.advisory,true);
    assert.equal(first.diff_digest?.git_version,git('--version'));
    assert.match(first.diff_digest!.value,/^[a-f0-9]{64}$/);
    git('commit','--allow-empty','-qm','same tree different commit');
    const second=artifactSubject(root);
    assert.notEqual(second.commit_id,first.commit_id);assert.equal(second.tree_id,first.tree_id);
  } finally {rmSync(root,{recursive:true,force:true});}
});
